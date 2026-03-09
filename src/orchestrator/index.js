// ============================================================
// FICHIER: src/orchestrator/index.js
// ROLE: LE CERVEAU DU SYSTEME
//       Gère les 4 canaux: WhatsApp, Instagram, Telegram, Email
// ============================================================

require('dotenv').config();
const { askGPT } = require('../llm/openai');
const {
  NURTURING_AGENT_PROMPT,
  FOLLOWUP_1_PROMPT,
  FOLLOWUP_2_PROMPT,
  FOLLOWUP_3_PROMPT
} = require('../llm/prompts');
const {
  LEAD_STATUS,
  getOrCreateLead,
  updateLead,
  addMessage,
  updateLeadScore,
} = require('../agents/crm/index');
const { generateBookingUrl } = require('../booking/manager');

// Agents de canaux (initialisés dynamiquement au démarrage)
let whatsappAgent = null;
let instagramAgent = null;
let voiceAgent = null;
let telegramAgent = null;
let emailAgent = null;

// Stats globales
const stats = {
  messagesProcessed: 0,
  responsesSent: 0,
  callsTriggered: 0,
  followupsSent: 0,
  startedAt: new Date().toISOString(),
};

/**
 * Initialise les agents de canaux disponibles
 */
function initAgents(agents) {
  if (agents.whatsapp) whatsappAgent = agents.whatsapp;
  if (agents.instagram) instagramAgent = agents.instagram;
  if (agents.voice) voiceAgent = agents.voice;
  if (agents.telegram) telegramAgent = agents.telegram;
  if (agents.email) emailAgent = agents.email;

  const activeChannels = Object.keys(agents).join(', ');
  console.log(`\n🧠 Orchestrateur initialisé → canaux actifs: ${activeChannels}`);
}

/**
 * FONCTION PRINCIPALE — Traite un message entrant (tous canaux)
 */
async function processMessage(messageData) {
  const { channel, contactId, text, firstName, lastName, phone, email } = messageData;

  stats.messagesProcessed++;
  console.log(`\n📨 [${channel.toUpperCase()}] ${contactId}: "${text.substring(0, 60)}..."`);

  // ── 1. Créer/récupérer le lead ──
  const lead = getOrCreateLead(contactId, channel, {
    firstName: firstName || extractFirstName(text) || 'Prospect',
    lastName: lastName || '',
    phone: phone || '',
    email: email || (channel === 'email' ? contactId.replace('email_', '') : ''),
  });

  // ── 2. Sauvegarder le message ──
  addMessage(contactId, 'user', text);

  // ── 3. Détecter l'intention ──
  const intent = detectIntent(text);

  if (intent === 'STOP') {
    updateLead(contactId, { status: LEAD_STATUS.LOST });
    const stopMsg = "Pas de souci, je respecte ta décision. Si tu changes d'avis, n'hésite pas ! Bonne continuation 😊";
    addMessage(contactId, 'assistant', stopMsg);
    return stopMsg;
  }

  if (intent === 'HUMAN_REQUEST') {
    updateLead(contactId, { needsHuman: true });
    notifyHumanAgent(lead, text);
    const humanMsg = "Bien sûr ! Je transmets ta demande à un conseiller qui te contactera très vite 👍";
    addMessage(contactId, 'assistant', humanMsg);
    return humanMsg;
  }

  // ── Détection directe de demande de RDV ──
  if (intent === 'HIGH_INTEREST' || text.toLowerCase().includes('rdv') || text.toLowerCase().includes('rendez-vous') || text.toLowerCase().includes('péserver') || text.toLowerCase().includes('book')) {
    const bookingUrl = generateBookingUrl(contactId, lead.firstName);
    const bookingMsg = buildBookingMessage(channel, lead.firstName, bookingUrl);
    updateLead(contactId, { status: LEAD_STATUS.QUALIFIED, bookingLinkSent: true, bookingLinkSentAt: new Date().toISOString() });
    addMessage(contactId, 'assistant', bookingMsg);
    stats.responsesSent++;
    await sendViaChannel(channel, contactId, bookingMsg, lead);
    return bookingMsg;
  }

  // ── 4. Mettre à jour le statut ──
  if (lead.status === LEAD_STATUS.NEW) {
    updateLead(contactId, { status: LEAD_STATUS.CONTACTED });
  } else if (lead.messageCount >= 3 && lead.status === LEAD_STATUS.CONTACTED) {
    updateLead(contactId, { status: LEAD_STATUS.QUALIFYING });
  }

  // ── 5. Choisir le bon prompt selon le contexte ──
  let systemPrompt = NURTURING_AGENT_PROMPT;
  if (lead.followupCount === 1) systemPrompt = FOLLOWUP_1_PROMPT;
  if (lead.followupCount === 2) systemPrompt = FOLLOWUP_2_PROMPT;
  if (lead.followupCount >= 3) systemPrompt = FOLLOWUP_3_PROMPT;

  // Ajuste le ton selon le canal
  const channelInstructions = getChannelInstructions(channel);
  const contextInfo = buildContextPrompt(lead, channelInstructions);
  const fullPrompt = systemPrompt + '\n\n' + contextInfo;

  // ── 6. Générer la réponse GPT-4o ──
  const recentHistory = lead.conversationHistory.slice(-10).map(m => ({
    role: m.role, content: m.content,
  }));

  const aiResponse = await askGPT(fullPrompt, recentHistory.slice(0, -1), text);

  // ── 7. Sauvegarder la réponse ──
  addMessage(contactId, 'assistant', aiResponse);
  stats.responsesSent++;

  // ── 8. Scoring automatique tous les 5 messages ──
  if (lead.messageCount % 5 === 0 && lead.messageCount > 0) {
    updateLeadScore(contactId).then(async scoreData => {
      if (scoreData?.score >= 70) {
        // Score élevé → envoyer lien de réservation si pas encore envoyé
        if (!lead.bookingLinkSent) {
          const bookingUrl = generateBookingUrl(contactId, lead.firstName);
          const bookingMsg = buildBookingMessage(lead.channel, lead.firstName, bookingUrl);
          updateLead(contactId, { bookingLinkSent: true, bookingLinkSentAt: new Date().toISOString(), status: LEAD_STATUS.QUALIFIED });
          addMessage(contactId, 'assistant', bookingMsg);
          stats.responsesSent++;
          await sendViaChannel(lead.channel, contactId, bookingMsg, lead);
        }
        // Si recommandé appel vocal
        if (scoreData?.nextAction === 'appel') {
          triggerVoiceCall(lead).catch(() => {});
        }
      }
    }).catch(() => {});
  }

  console.log(`✅ Réponse [${channel}]: "${aiResponse.substring(0, 60)}..."`);
  return aiResponse;
}

/**
 * Construit le message de booking selon le canal
 */
function buildBookingMessage(channel, firstName, bookingUrl) {
  const messages = {
    whatsapp: `Super ${firstName} ! 🎉\nTu peux réserver ton créneau directement ici :\n👉 ${bookingUrl}\n\nC'est rapide, ça prend 2 minutes !`,
    instagram: `Super ${firstName} ! 🎉✨\nRéserve ton créneau maintenant :\n👉 ${bookingUrl}\n\n2 minutes et c'est fait !`,
    telegram: `Super ${firstName} ! 🎉\n\nTu peux *réserver ton créneau* directement ici :\n👉 ${bookingUrl}\n\nC'est rapide, ça prend 2 minutes !`,
    email: `Bonjour ${firstName},\n\nSuper nouvelle ! Vous pouvez réserver votre créneau de consultation directement en ligne :\n\n👉 ${bookingUrl}\n\nIl vous suffit de choisir le créneau qui vous convient le mieux.\n\nÀ très bientôt !`,
  };
  return messages[channel] || messages.whatsapp;
}

/**
 * Instructions spécifiques à chaque canal pour adapter le style
 */
function getChannelInstructions(channel) {
  const instructions = {
    whatsapp: `
CANAL: WhatsApp
- Messages courts (2-4 lignes max)
- Emojis autorisés (1-2 par message)
- Ton très conversationnel, comme un SMS
- Évite les longs paragraphes`,

    instagram: `
CANAL: Instagram DM
- Ton jeune et dynamique
- Emojis un peu plus fréquents
- Références possibles au contenu Instagram
- Messages courts et percutants`,

    telegram: `
CANAL: Telegram
- Tu peux utiliser le **gras** et l'*italique* (Markdown)
- Ton conversationnel mais légèrement plus formel
- Messages un peu plus longs acceptables
- Utilise des listes si nécessaire`,

    email: `
CANAL: Email
- Ton professionnel mais chaleureux
- Structure claire avec des paragraphes
- Pas d'emojis (ou très peu)
- Peut être plus long (5-8 lignes)
- Commence toujours par le prénom
- Termine par une signature courte`,
  };

  return instructions[channel] || instructions.whatsapp;
}

/**
 * Construit le prompt de contexte sur le lead
 */
function buildContextPrompt(lead, channelInstructions) {
  return `
${channelInstructions}

PROFIL DU LEAD:
- Prénom: ${lead.firstName}
- Canal: ${lead.channel}
- Messages échangés: ${lead.messageCount}
- Statut: ${lead.status}
- Score: ${lead.score}/100
- Relances envoyées: ${lead.followupCount}
- Contexte récent: ${summarizeHistory(lead.conversationHistory)}
`;
}

/**
 * Envoie une relance automatique
 */
async function sendFollowup(lead, followupNumber) {
  console.log(`⏰ Relance #${followupNumber} → ${lead.firstName} (${lead.contactId})`);

  let prompt;
  if (followupNumber === 1) prompt = FOLLOWUP_1_PROMPT;
  else if (followupNumber === 2) prompt = FOLLOWUP_2_PROMPT;
  else prompt = FOLLOWUP_3_PROMPT;

  const channelInstructions = getChannelInstructions(lead.channel);
  const context = `
${channelInstructions}

RELANCE #${followupNumber} pour ${lead.firstName}
Dernier message reçu: "${lead.conversationHistory.slice(-1)[0]?.content || 'Aucun'}"

Génère UN message de relance naturel et court.`;

  try {
    const relanceMsg = await askGPT(prompt + context, [], null);

    updateLead(lead.contactId, {
      followupCount: followupNumber,
      lastFollowupAt: new Date().toISOString(),
      status: followupNumber === 1 ? LEAD_STATUS.FOLLOWUP_1 :
              followupNumber === 2 ? LEAD_STATUS.FOLLOWUP_2 : LEAD_STATUS.FOLLOWUP_3,
    });
    addMessage(lead.contactId, 'assistant', relanceMsg);
    await sendViaChannel(lead.channel, lead.contactId, relanceMsg, lead);
    stats.followupsSent++;
    return relanceMsg;
  } catch (error) {
    console.error(`❌ Erreur relance:`, error.message);
  }
}

/**
 * Déclenche un appel vocal Vapi
 */
async function triggerVoiceCall(lead) {
  if (!voiceAgent || !lead.phone) return;

  console.log(`📞 Appel IA → ${lead.firstName} (${lead.phone})`);
  try {
    const result = await voiceAgent.makeCall({
      phone: lead.phone,
      leadName: lead.firstName,
      leadContext: summarizeHistory(lead.conversationHistory),
    });
    updateLead(lead.contactId, { status: LEAD_STATUS.CALLED, callId: result.callId });
    stats.callsTriggered++;

    const notif = `${lead.firstName}, tu vas recevoir un appel de notre équipe dans quelques minutes ! 📞`;
    await sendViaChannel(lead.channel, lead.contactId, notif, lead);
  } catch (error) {
    console.error('Erreur appel IA:', error.message);
  }
}

/**
 * Route un message vers le bon canal
 */
async function sendViaChannel(channel, contactId, message, lead = null) {
  try {
    switch (channel) {
      case 'whatsapp':
        if (whatsappAgent) await whatsappAgent.sendMessage(contactId, message);
        break;
      case 'instagram':
        if (instagramAgent) await instagramAgent.sendMessage(contactId, message);
        break;
      case 'telegram':
        if (telegramAgent) await telegramAgent.sendMessage(contactId, message);
        break;
      case 'email':
        if (emailAgent) await emailAgent.sendMessageFromOrchestrator(contactId, message);
        break;
      default:
        console.log(`⚠️  Canal ${channel} non supporté`);
    }
  } catch (error) {
    console.error(`Erreur envoi [${channel}]:`, error.message);
  }
}

/**
 * Détecte l'intention principale du message
 */
function detectIntent(text) {
  const lower = text.toLowerCase();

  if (['stop', 'arrête', 'laisse moi', 'pas intéressé', 'unsubscribe', 'désabonne'].some(w => lower.includes(w)))
    return 'STOP';

  if (['parler à quelqu', 'vrai personne', 'humain', 'conseiller', 'agent humain'].some(w => lower.includes(w)))
    return 'HUMAN_REQUEST';

  if (['combien', 'prix', 'tarif', 'coût', 'budget'].some(w => lower.includes(w)))
    return 'PRICE_QUESTION';

  if (['intéressé', 'je veux', 'comment faire', 'rdv', 'rendez-vous', 'appel', 'réserver'].some(w => lower.includes(w)))
    return 'HIGH_INTEREST';

  return 'GENERAL';
}

/**
 * Essaie d'extraire un prénom du message
 */
function extractFirstName(text) {
  const patterns = [
    /je suis ([A-Z][a-z]+)/i,
    /c'est ([A-Z][a-z]+)/i,
    /moi c'est ([A-Z][a-z]+)/i,
    /bonjour[,\s]+([A-Z][a-z]+)/i,
    /salut[,\s]+([A-Z][a-z]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * Résumé court de l'historique
 */
function summarizeHistory(history) {
  if (!history?.length) return 'Aucune conversation';
  return history.slice(-4)
    .map(m => `[${m.role}]: ${m.content.substring(0, 60)}`)
    .join(' | ');
}

/**
 * Notifie l'équipe humaine
 */
function notifyHumanAgent(lead, lastMsg) {
  console.log('\n🚨 ─── INTERVENTION HUMAINE REQUISE ───');
  console.log(`Lead: ${lead.firstName} | Canal: ${lead.channel} | Score: ${lead.score}/100`);
  console.log(`Dernier message: "${lastMsg}"`);
  console.log('─────────────────────────────────────\n');
  // TODO: Envoie une notification Slack/email/SMS à ton équipe
}

/**
 * Retourne les stats du système
 */
function getStats() {
  return { ...stats };
}

module.exports = {
  initAgents,
  processMessage,
  sendFollowup,
  triggerVoiceCall,
  getStats,
};
