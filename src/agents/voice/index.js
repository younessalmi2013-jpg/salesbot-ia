// ============================================================
// FICHIER: src/agents/voice/index.js
// ROLE: Agent Appels Vocaux IA via Vapi.ai
//       Vapi gere tout: appel sortant, voix IA, transcription, webhooks
//       Cree un compte sur vapi.ai et configure ton assistant
// ============================================================

require('dotenv').config();
const axios = require('axios');
const { VOICE_AGENT_PROMPT } = require('../../llm/prompts');
const { updateLead, LEAD_STATUS } = require('../crm/index');

const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_BASE_URL = 'https://api.vapi.ai';

/**
 * Lance un appel sortant vers un lead
 * @param {Object} callConfig - {phone, leadName, leadContext}
 */
async function makeCall(callConfig) {
  if (!VAPI_API_KEY) {
    console.log('⚠️  Vapi non configure (VAPI_API_KEY manquant)');
    return { callId: null, status: 'skipped' };
  }

  const { phone, leadName, leadContext } = callConfig;

  // Formate le numero au format international
  const phoneNumber = formatPhoneNumber(phone);

  console.log(`📞 Lancement appel Vapi vers ${phoneNumber} pour ${leadName}...`);

  try {
    // Option 1: Utilise un assistant pre-configure dans le dashboard Vapi
    // (Recommande pour les debutants - configure l'assistant visuellement)
    if (process.env.VAPI_ASSISTANT_ID) {
      const response = await axios.post(
        `${VAPI_BASE_URL}/call`,
        {
          phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
          assistantId: process.env.VAPI_ASSISTANT_ID,
          customer: {
            number: phoneNumber,
            name: leadName,
          },
          // Passe le contexte du lead a l'assistant
          assistantOverrides: {
            variableValues: {
              leadName: leadName,
              leadContext: leadContext || '',
            },
          },
        },
        {
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      console.log(`✅ Appel lance! ID: ${response.data.id}`);
      return { callId: response.data.id, status: 'initiated' };
    }

    // Option 2: Cree l'assistant dynamiquement avec GPT-4o
    // (Plus flexible mais plus complexe)
    const response = await axios.post(
      `${VAPI_BASE_URL}/call`,
      {
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: {
          number: phoneNumber,
          name: leadName,
        },
        assistant: {
          // Modele IA a utiliser
          model: {
            provider: 'openai',
            model: 'gpt-4o',
            messages: [{
              role: 'system',
              content: VOICE_AGENT_PROMPT + `\n\nContexte lead: ${leadContext || 'Premier contact'}`,
            }],
          },
          // Configuration de la voix (change voiceId pour utiliser ta propre voix clonee)
          voice: {
            provider: 'elevenlabs',
            voiceId: 'pFZP5JQG7iQjIQuC4Bku', // Voix par defaut ElevenLabs
            // Pour cloner ta voix: va sur elevenlabs.io -> My Voices -> Add Voice
            stability: 0.5,
            similarityBoost: 0.75,
          },
          // Transcription avec Deepgram
          transcriber: {
            provider: 'deepgram',
            language: 'fr',   // Langue: francais
          },
          // Configuration generale
          firstMessage: `Bonjour ${leadName} ! C'est Sophie de l'equipe. Est-ce que je vous derange ?`,
          endCallMessage: "Merci pour votre temps ! Je vous envoie les informations par message. Bonne journee !",
          maxDurationSeconds: 1200,   // 20 minutes max
          backgroundSound: 'office',  // Ambiance bureau
          // Si le lead raccroche ou ne repond pas
          voicemailDetection: {
            provider: 'twilio',
          },
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`✅ Appel lance! ID: ${response.data.id}`);
    return { callId: response.data.id, status: 'initiated' };

  } catch (error) {
    console.error('❌ Erreur Vapi:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Traite les evenements webhook de Vapi
 * Vapi nous notifie en temps reel: appel commence, fin, transcription...
 */
async function handleVapiWebhook(req, res) {
  res.sendStatus(200); // Repondre immediatement

  const event = req.body;
  const eventType = event.message?.type;

  console.log(`📞 Vapi webhook: ${eventType}`);

  switch (eventType) {
    case 'call-started':
      console.log(`✅ Appel commence: ${event.message.call?.id}`);
      break;

    case 'call-ended': {
      const call = event.message.call;
      const summary = event.message.analysis?.summary || '';
      const transcript = event.message.artifact?.transcript || '';

      console.log(`\n📞 Appel termine: ${call?.id}`);
      console.log(`Duree: ${call?.endedAt ? 'Calcul...' : 'N/A'}`);
      console.log(`Resume: ${summary}`);

      // Met a jour le CRM avec le resultat de l'appel
      if (call?.customer?.number) {
        const phone = call.customer.number;
        // Cherche le lead par telephone dans le CRM
        // NOTE: Dans une vraie app, tu aurais un index par telephone
        console.log(`Mise a jour CRM pour le numero ${phone}`);
        console.log(`Resume de l'appel: ${summary}`);
      }
      break;
    }

    case 'end-of-call-report': {
      const report = event.message;
      console.log('\n📊 RAPPORT D\'APPEL:');
      console.log('Summary:', report.analysis?.summary);
      console.log('Success:', report.analysis?.successEvaluation);
      break;
    }

    case 'transcript': {
      // Transcription en temps reel (optionnel)
      const transcript = event.message.transcript;
      if (transcript) {
        process.stdout.write(`[${transcript.role}]: ${transcript.transcript}\n`);
      }
      break;
    }
  }
}

/**
 * Recupere les details d'un appel
 */
async function getCallDetails(callId) {
  if (!VAPI_API_KEY) return null;

  try {
    const response = await axios.get(
      `${VAPI_BASE_URL}/call/${callId}`,
      { headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` } }
    );
    return response.data;
  } catch (error) {
    console.error('Erreur recuperation appel:', error.message);
    return null;
  }
}

/**
 * Formate un numero de telephone au format international
 */
function formatPhoneNumber(phone) {
  // Supprime tout sauf les chiffres et le +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Si commence par 0, remplace par +33 (France)
  if (cleaned.startsWith('0')) {
    cleaned = '+33' + cleaned.substring(1);
  }

  // Si pas de +, ajoute +33
  if (!cleaned.startsWith('+')) {
    cleaned = '+33' + cleaned;
  }

  return cleaned;
}

/**
 * Recupere la liste des appels passes
 */
async function getCallHistory(limit = 20) {
  if (!VAPI_API_KEY) return [];

  try {
    const response = await axios.get(
      `${VAPI_BASE_URL}/call`,
      {
        headers: { 'Authorization': `Bearer ${VAPI_API_KEY}` },
        params: { limit },
      }
    );
    return response.data;
  } catch (error) {
    console.error('Erreur historique appels:', error.message);
    return [];
  }
}

module.exports = {
  makeCall,
  handleVapiWebhook,
  getCallDetails,
  getCallHistory,
};
