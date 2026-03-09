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
    console.log('âš ï¸  Vapi non configure (VAPI_API_KEY manquant)');
    return { callId: null, status: 'skipped' };
  }

  const { phone, leadName, leadContext } = callConfig;

  // Formate le numÃ©ro au format international
  const phoneNumber = formatPhoneNumber(phone);

  console.log(`ğŸ“ Lancement appel Vapi vers ${phoneNumber} pour ${leadName}...`);

  try {
    // Option 1: Utilise un assistant prÃ©-configurÃ© dans le dashboard Vapi
    // (Recommande pour les dÃ©butants - configure l'assistant visuellement)
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

      console.log(`âœ… Appel lancÃ© ! ID: ${response.data.id}`);
      return { callId: response.data.id, status: 'initiated' };
    }

    // Option 2: CrÃ©e l'assistant dynamiquement avec GPT-4o
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
            model: 'gpt-4o",
            messages: [{*              role: 'system',
              content: VOICE_AGENT_PROMPT 
) x \n\nContexte lead: ${leadContext || 'Premier contact'}`,
            }],
          },
          // Configuration de la voik (change voiceId pour utiliser ta propre voik clonee)
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

    console.log(`âœ… Appel lancÃ© ! ID: ${response.data.id}`);
    return { callId: response.data.id, status: 'initiated' };

  } catch (error) {
    console.error('âŒ Erreur Vapi:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Traite les evenements webhook de Vapi
  * Vapi nous notifie en temps rÃ©el: appel commence, fin, transcription...
  
 "•	…Ñ €¡”°¤ì(€€€½¹Í½±”¹•ÉÉ½È ŸŠv0ÉÉ•ÕÈÉ•ÕÁ•É…Ñ¥½¸…ÁÁ•°èœ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€É•ÑÕÉ¸¹Õ±°ì(€ô)ô((¼¨¨(€¨½Éµ…Ñ”Õ¸¹Õµ•É¼‘”Ñ•±•Á¡½¹”…Ô™½Éµ…Ğ¥¹Ñ•É¹…Ñ¥½¹…°(€€¨¼)™Õ¹Ñ¥½¸™½Éµ…ÑA¡½¹•9Õµ‰•È¡Á¡½¹”¤ì(€€¼¼MÕÁÁÉ¥µ”Ñ½ÕĞÍ…Õ˜±•Ì¡¥™™É•Ì•Ğ±”€¬(€±•Ğ±•…¹•€ôÁ¡½¹”¹É•Á±…” ½myq­t½œ°€œœ¤ì((€€¼¼M¤½µµ•¹”Á…È€À°É•µÁ±…”Á…È€¬ÌÌ€¡É…¹”¤(€¥˜€¡±•…¹•¹ÍÑ…ÉÑÍ]¥Ñ  œÀœ¤¤ì(€€€±•…¹•€ô€œ¬ÌÌœ€¬±•…¹•¹ÍÕ‰ÍÑÉ¥¹œ Ä¤ì(€ô((€€¼¼M¤Á…Ì‘”€¬°…©½ÕÑ”€¬ÌÌ(€¥˜€ …±•…¹•¹ÍÑ…ÉÑÍ]¥Ñ  œ¬œ¤¤ì(€€€±•…¹•€ô€œ¬ÌÌœ€¬±•…¹•ì(€ô((€É•ÑÕÉ¸±•…¹•ì)ô((¼¨¨(€¨I•ÕÁ•É”±„±¥ÍÑ”‘•Ì…ÁÁ•±ÌÁ…ÍÏ¥Ì(€€¨¼)…Íå¹Œ™Õ¹Ñ¥½¸•Ñ…±±!¥ÍÑ½Éä¡±¥µ¥Ğ€ô€ÈÀ¤ì(€¥˜€ …YA%}A%}-d¤É•ÑÕÉ¸mtì((€ÑÉäì(€€€½¹ÍĞÉ•ÍÁ½¹Í”€ô…İ…¥Ğ…á¥½Ì¹•Ğ (€€€€€€‘íYA%}	M}UI1ô½…±±€°(€€€€€ì(€€€€€€€¡•…‘•ÉÌèì€ÕÑ¡½É¥é…Ñ¥½¸œè	•…É•È€‘íYA%}A%}-eõ€ô°(€€€€€€€Á…É…µÌèì±¥µ¥Ğô°(€€€€€ô(€€€€¤ì(€€€É•ÑÕÉ¸É•ÍÁ½¹Í”¹‘…Ñ„ì(€ô…Ñ €¡•ÉÉ½È¤ì(€€€½¹Í½±”¹•ÉÉ½È ÉÉ•ÕÈ…¥ÍÑ½É¥ÅÕ”…ÁÁ•±Ìèœ°•ÉÉ½È¹µ•ÍÍ…”¤ì(€€€É•ÑÕÉ¸mtì(€ô)ô()µ½‘Õ±”¹•áÁ½ÉÑÌ€ôì(€µ…­•…±°°(€¡…¹‘±•Y…Á¥]•‰¡½½¬°(€•Ñ…±±•Ñ…¥±Ì°(€•Ñ…±±!¥ÍÑ½Éä°)ô(