// ============================================================
// FICHIER: src/agents/instagram/index.js
// ROLE: Agent Instagram - recoit et envoie des DMs via Meta API
//       Necessite: un compte Meta Developer + token d'acces
//       Guide: developers.facebook.com/docs/messenger-platform
// ============================================================

require('dotenv').config();
const axios = require('axios');
const { processMessage } = require('../../orchestrator/index');

const META_API_BASE = 'https://graph.facebook.com/v20.0';
const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'mon_token_secret_2024';
const IG_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;

/**
 * Verifie le webhook Instagram (Meta demande cette verification a la config)
 * Cette fonction est appelee par ton serveur Express
 */
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook Instagram verifie avec succes!');
    res.status(200).send(challenge);
  } else {
    console.error('❌ Echec verification webhook Instagram');
    res.sendStatus(403);
  }
}

/**
 * Traite les evenements webhook entrants de Meta
 * Cette fonction est appelee par ton serveur Express
 */
async function handleWebhookEvent(req, res) {
  // Repondre immediatement a Meta (ils veulent une reponse rapide)
  res.sendStatus(200);

  const body = req.body;

  // Verification que c'est bien un evenement Instagram
  if (body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      // Ignore les messages qu'on a envoyes (evite les boucles)
      if (event.message?.is_echo) continue;

      // Message recu d'un utilisateur
      if (event.message && event.message.text) {
        await handleIncomingMessage(event);
      }
    }
  }
}

/**
 * Traite un message Instagram entrant
 */
async function handleIncomingMessage(event) {
  const senderId = event.sender.id;     // ID Instagram de l'utilisateur
  const messageText = event.message.text;

  console.log(`\n📸 Instagram DM de ${senderId}: "${messageText.substring(0, 60)}"`);

  // Recupere le nom de l'utilisateur Instagram
  let firstName = null;
  try {
    const userInfo = await getUserInfo(senderId);
    firstName = userInfo.name?.split(' ')[0] || null;
  } catch (e) {
    // Continue sans le nom
  }

  // Envoie a l'orchestrateur
  const response = await processMessage({
    channel: 'instagram',
    contactId: senderId,
    text: messageText,
    firstName: firstName,
  });

  // Delai naturel avant de repondre
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Envoie la reponse via Instagram
  await sendMessage(senderId, response);
}

/**
 * Envoie un message a un utilisateur Instagram
 */
async function sendMessage(recipientId, messageText) {
  if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) {
    console.log('⚠️  Instagram non configure (ACCESS_TOKEN ou IG_ACCOUNT_ID manquant)');
    return;
  }

  try {
    await axios.post(
      `${META_API_BASE}/${IG_ACCOUNT_ID}/messages`,
      {
        recipient: { id: recipientId },
        message: { text: messageText },
        messaging_type: 'RESPONSE',
      },
      {
        params: { access_token: ACCESS_TOKEN },
        headers: { 'Content-Type': 'application/json' },
      }
    );
    console.log(`✅ Message Instagram envoye a ${recipientId}`);
  } catch (error) {
    console.error(`❌ Erreur envoi Instagram:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Recupere les infos d'un utilisateur Instagram
 */
async function getUserInfo(userId) {
  const response = await axios.get(
    `${META_API_BASE}/${userId}`,
    { params: { access_token: ACCESS_TOKEN, fields: 'name,profile_pic' } }
  );
  return response.data;
}

/**
 * Envoie un message avec un bouton (Call-to-Action)
 * Ex: "Prendre un RDV" -> bouton avec lien
 */
async function sendMessageWithCTA(recipientId, text, buttonText, buttonUrl) {
  if (!ACCESS_TOKEN || !IG_ACCOUNT_ID) return;

  try {
    await axios.post(
      `${META_API_BASE}/${IG_ACCOUNT_ID}/messages`,
      {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'button',
              text: text,
              buttons: [{
                type: 'web_url',
                url: buttonUrl,
                title: buttonText,
              }]
            }
          }
        },
        messaging_type: 'RESPONSE',
      },
      { params: { access_token: ACCESS_TOKEN } }
    );
  } catch (error) {
    // Fallback: envoie juste le texte avec le lien
    await sendMessage(recipientId, `${text}\n\n👉 ${buttonUrl}`);
  }
}

module.exports = {
  verifyWebhook,
  handleWebhookEvent,
  sendMessage,
  sendMessageWithCTA,
};
