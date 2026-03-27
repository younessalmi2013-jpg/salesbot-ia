const db = require('../db');

async function generateAIResponse(messages, config, lead) {
  // Lazy-load to avoid startup errors if OpenAI key not set
  const { generateResponse } = require('../llm/openai');
  return generateResponse({ messages, config, lead });
}

async function handleIncomingMessage({ agentId, userId, from, body, channel, send }) {
  // Get or create lead
  let lead = db.leads.findOne(l => l.userId === userId && l.phone === from && l.channel === channel);

  if (!lead) {
    lead = db.leads.insert({
      userId,
      phone: from,
      name: from,
      channel,
      agentId,
      status: 'new',
      score: 0,
      messages: [],
      lastMessage: body,
      lastContact: new Date().toISOString(),
      messageCount: 0,
    });

    // Send welcome message
    const config = db.configs.findOne(c => c.userId === userId) || {};
    if (config.welcomeMessage) {
      const welcome = config.welcomeMessage
        .replace(/{name}/g, from)
        .replace(/{botName}/g, config.botName || 'Bot')
        .replace(/{productName}/g, config.productName || '');
      setTimeout(() => send(welcome).catch(console.error), 1500);
    }
  }

  const config = db.configs.findOne(c => c.userId === userId) || {};
  const maxMsgs = config.maxMessages || 20;

  // Check active hours
  if (config.activeStart && config.activeEnd) {
    const now = new Date();
    const hhmm = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = config.activeStart.split(':').map(Number);
    const [eh, em] = config.activeEnd.split(':').map(Number);
    if (hhmm < sh * 60 + sm || hhmm > eh * 60 + em) {
      return; // Outside active hours — don't respond
    }
  }

  // Add message
  const messages = [...(lead.messages || [])];
  messages.push({ role: 'user', content: body, ts: new Date().toISOString() });

  const msgCount = (lead.messageCount || 0) + 1;

  // Check message limit
  if (msgCount > maxMsgs) {
    const notif = `Le lead ${from} (${channel}) attend une reponse humaine. ${msgCount} messages echanges.`;
    console.log(`\x1b[33m⚠️  Limite atteinte: ${notif}\x1b[0m`);
    db.leads.update(lead.id, { messages, messageCount: msgCount, lastMessage: body, lastContact: new Date().toISOString(), needsHuman: true });
    return;
  }

  // Generate AI response
  try {
    const response = await generateAIResponse(messages, config, lead);
    messages.push({ role: 'assistant', content: response, ts: new Date().toISOString() });

    // Score update
    let score = lead.score || 0;
    if (body.toLowerCase().includes('prix') || body.toLowerCase().includes('budget')) score = Math.max(score, 40);
    if (body.toLowerCase().includes('rdv') || body.toLowerCase().includes('appel')) score = Math.max(score, 70);
    if (body.toLowerCase().includes('oui') || body.toLowerCase().includes('interesse')) score = Math.max(score, 60);

    // Status upgrade
    let status = lead.status;
    if (status === 'new' && msgCount >= 2) status = 'qualified';
    if (score >= 70 && status !== 'booked' && status !== 'client') status = 'qualified';

    db.leads.update(lead.id, {
      messages,
      messageCount: msgCount,
      lastMessage: body,
      lastContact: new Date().toISOString(),
      score,
      status,
      needsHuman: false,
    });

    await send(response);
  } catch (e) {
    console.error('Orchestrator error:', e.message);
    try { await send("Desole, une erreur est survenue. Reessayez dans quelques instants."); } catch (_) {}
  }
}

module.exports = { handleIncomingMessage };
