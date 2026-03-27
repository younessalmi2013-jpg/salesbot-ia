let _openai = null;

function getClient() {
  if (!_openai) {
    const OpenAI = require('openai');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

function buildSystemPrompt(config, lead) {
  const botName = config.botName || 'Sophie';
  const productName = config.productName || 'notre service';
  const rdvLink = config.rdvLink || '';
  const rdvPhone = config.rdvPhone || '';
  const price = config.productPrice || '';

  let prompt = config.systemPrompt ||
    `Tu es ${botName}, une conseillere commerciale experte et bienveillante. Tu travailles pour ${productName}.`;

  prompt = prompt
    .replace(/{botName}/g, botName)
    .replace(/{productName}/g, productName)
    .replace(/{rdvLink}/g, rdvLink)
    .replace(/{rdvPhone}/g, rdvPhone)
    .replace(/{productPrice}/g, price);

  if (config.productDescription)
    prompt += `\n\nProduit/Service:\n${config.productDescription}`;

  if (config.productBenefits)
    prompt += `\n\nAvantages cles:\n${config.productBenefits}`;

  if (config.objections?.length > 0) {
    prompt += '\n\nObjections et reponses preparees:';
    for (const o of config.objections)
      prompt += `\n- Si le lead dit "${o.objection}" → Repondre: ${o.response}`;
  }

  if (config.qualQuestions?.length > 0) {
    prompt += '\n\nQuestions de qualification a poser progressivement:';
    for (const q of config.qualQuestions) prompt += `\n- ${q}`;
  }

  const tone = config.botTone || 'professional';
  const toneMap = {
    professional: 'Ton professionnel et serieux.',
    friendly: 'Ton amical et chaleureux, utilise des emojis avec moderation.',
    casual: 'Ton decontracte et naturel.',
    formal: 'Ton tres formel et soutenu.',
    enthusiastic: 'Ton enthousiaste et dynamique.',
  };
  prompt += `\n\nStyle: ${toneMap[tone] || toneMap.professional}`;

  if (config.botSignature)
    prompt += `\n\nSignature de fin de message: ${config.botSignature}`;

  prompt += `\n\nRegles IMPORTANTES:
- Reponds en ${config.language === 'ar' ? 'arabe' : config.language === 'en' ? 'anglais' : 'francais'} sauf si le lead ecrit dans une autre langue
- Max 3-4 phrases par message — sois concis
- Ne revele pas le prix avant d avoir qualifie le lead
- Quand le lead est qualifie, propose: ${rdvLink || 'de prendre un RDV'}
- Si telephone RDV disponible: ${rdvPhone || 'non disponible'}
- N invente aucune information non fournie ci-dessus`;

  return prompt;
}

async function generateResponse({ messages, config, lead }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY non configure');
  }

  const systemPrompt = buildSystemPrompt(config, lead);
  const history = messages.slice(-12).map(m => ({ role: m.role, content: m.content }));

  const response = await getClient().chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [{ role: 'system', content: systemPrompt }, ...history],
    max_tokens: 400,
    temperature: 0.75,
  });

  return response.choices[0].message.content.trim();
}

module.exports = { generateResponse, buildSystemPrompt };
