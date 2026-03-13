'use strict';
const { getSystemPrompt, detectLanguage } = require('./prompts');

// Historique des conversations par lead (en memoire)
const conversationHistory = new Map();

async function generateAIResponse({ message, channel, leadName, leadStatus, leadEmail, history, context }) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('[AI] OPENAI_API_KEY manquant - reponse par defaut');
      return getDefaultResponse(message, channel, detectLanguage(message));
    }

    const lang = detectLanguage(message);
    const systemPrompt = getSystemPrompt(channel, {
      leadName: leadName || 'Client',
      leadStatus: leadStatus || 'new',
      leadEmail: leadEmail || '',
      history: history ? history.slice(-5).map(m => `${m.from}: ${m.text}`).join('\n') : 'Aucun historique',
      context: context || '',
      message
    });

    const conversationKey = `${channel}_${leadName}`;
    if (!conversationHistory.has(conversationKey)) {
      conversationHistory.set(conversationKey, []);
    }
    const convHistory = conversationHistory.get(conversationKey);
    convHistory.push({ role: 'user', content: message });
    if (convHistory.length > 20) convHistory.splice(0, convHistory.length - 20);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        messages: [{ role: 'system', content: systemPrompt }, ...convHistory],
        max_tokens: 300,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[AI] OpenAI error:', err);
      return getDefaultResponse(message, channel, lang);
    }

    const data = await response.json();
    const aiResponse = data.choices[0]?.message?.content?.trim();
    if (aiResponse) convHistory.push({ role: 'assistant', content: aiResponse });
    return aiResponse || getDefaultResponse(message, channel, lang);

  } catch (e) {
    console.error('[AI] Erreur generateAIResponse:', e.message);
    return getDefaultResponse(message, channel, detectLanguage(message));
  }
}

function getDefaultResponse(message, channel, lang = 'fr') {
  const msg = message.toLowerCase();
  const isGreeting = /bonjour|salut|hello|salam|مرحبا|السلام/.test(msg);
  const isPrice = /prix|tarif|combien|cout|budget|سعر|تكلفة/.test(msg);
  const isRDV = /rdv|rendez|appointment|meeting|موعد|اجتماع/.test(msg);
  const isInfo = /info|renseignement|details|معلومات/.test(msg);

  const responses = {
    fr: {
      greeting: `Bonjour ! Merci de nous contacter. Comment puis-je vous aider aujourd'hui ?`,
      price: `Je serais ravi de vous donner les details de nos tarifs. Pouvez-vous me dire quel est votre besoin principal ?`,
      rdv: `Bien sur ! Je peux vous proposer un rendez-vous. Quelle date vous convient le mieux ?`,
      info: `Je vais vous donner toutes les informations. Pourriez-vous preciser ce qui vous interesse ?`,
      default: `Merci pour votre message. Un conseiller va vous recontacter tres rapidement. Des questions ?`
    },
    ar: {
      greeting: `مرحبا! شكرا للتواصل معنا. كيف يمكنني مساعدتك اليوم؟`,
      price: `يسعدني تزويدك بتفاصيل أسعارنا. هل يمكنك إخباري بحاجتك الرئيسية؟`,
      rdv: `بالطبع! يمكنني اقتراح موعد. ما هو التاريخ الأنسب لك؟`,
      info: `سأزودك بجميع المعلومات. هل يمكنك توضيح ما يهمك أكثر؟`,
      default: `شكرا على رسالتك. سيتواصل معك أحد مستشارينا قريبا. هل لديك أسئلة؟`
    }
  };

  const langResponses = responses[lang] || responses['fr'];
  if (isGreeting) return langResponses.greeting;
  if (isPrice) return langResponses.price;
  if (isRDV) return langResponses.rdv;
  if (isInfo) return langResponses.info;
  return langResponses.default;
}

async function analyzeLead(messages) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { score: 5, status: 'new', intent: 'unknown' };

    const conversation = messages.map(m => `${m.from}: ${m.text}`).join('\n');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{
          role: 'system',
          content: `Analyse cette conversation et retourne UN JSON:\n{"score":[0-10],"status":["new","qualified","booked","client","lost"],"intent":["buy","compare","info","not_interested"],"nextAction":["rdv","followup","close","wait"],"summary":"Resume 1 phrase"}\nUNIQUEMENT le JSON.`
        }, { role: 'user', content: conversation }],
        max_tokens: 200,
        temperature: 0.3
      })
    });
    const data = await response.json();
    const cnt = data.choices[0]?.message?.content?.trim();
    return JSON.parse(cnt);
  } catch (e) {
    console.error('[AI] Erreur analyzeLead:', e.message);
    return { score: 5, status: 'new', intent: 'unknown' };
  }
}

module.exports = { generateAIResponse, analyzeLead, getDefaultResponse };
// ============================================================
// FICHIER: src/llm/openai.js
// ROLE: Interface avec OpenAI GPT-4o - le cerveau de tous les agents
// ============================================================

require('dotenv').config();
const OpenAI = require('openai');

// Initialisation du client OpenAI avec ta cle API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Fonction principale pour envoyer un message a GPT-4o
 * @param {string} systemPrompt - Les instructions pour l'IA (son "personnage")
 * @param {Array} conversationHistory - L'historique de la conversation [{role, content}]
 * @param {string} userMessage - Le nouveau message du lead
 * @returns {string} La reponse de l'IA
 */
async function askGPT(systemPrompt, conversationHistory = [], userMessage = null) {
  try {
    // Construction des messages a envoyer a GPT
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
    ];

    // Ajout du message utilisateur si fourni
    if (userMessage) {
      messages.push({ role: 'user', content: userMessage });
    }

    // Appel a l'API OpenAI
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: messages,
      max_tokens: 500,       // Max 500 mots par reponse (limite les couts)
      temperature: 0.7,      // 0 = robotique, 1 = tres creatif, 0.7 = naturel
    });

    return response.choices[0].message.content.trim();

  } catch (error) {
    console.error('❌ Erreur OpenAI:', error.message);
    throw error;
  }
}

/**
 * Demande a GPT d'evaluer et scorer un lead (0-100)
 * @param {Object} lead - Les informations du lead
 * @returns {Object} Score et raison
 */
async function scoreLead(lead) {
  const prompt = `Tu es un expert en qualification de leads.
  Analyse ce lead et donne-lui un score de 0 a 100 base sur:
  - Budget (a-t-il les moyens ?)
  - Besoin (a-t-il un probleme que notre produit resout ?)
  - Urgence (veut-il agir maintenant ?)
  - Autorite (est-il le decideur ?)

  Reponds UNIQUEMENT en JSON avec ce format:
  {"score": 75, "reason": "Lead qualifie car...", "nextAction": "appel" ou "nurture" ou "disqualifie"}

  Informations du lead:
  - Canal: ${lead.channel}
  - Messages echanges: ${lead.messageCount}
  - Reponses: ${JSON.stringify(lead.answers || {})}
  - Comportement: ${lead.behavior || 'neutre'}`;

  try {
    const response = await askGPT(prompt, [], null);
    // Extraction du JSON de la reponse
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return { score: 50, reason: 'Score par defaut', nextAction: 'nurture' };
  } catch (error) {
    console.error('Erreur scoring lead:', error.message);
    return { score: 50, reason: 'Errour calcul score', nextAction: 'nurture' };
  }
}

module.exports = { askGPT, scoreLead };
