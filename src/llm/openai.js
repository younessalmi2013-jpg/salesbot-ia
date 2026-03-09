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
