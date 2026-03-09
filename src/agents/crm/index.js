// ============================================================
// FICHIER: src/agents/crm/index.js
// ROLE: Gestion de tous les leads (stockage en memoire + Airtable optionnel)
//       Au debut, tout est stocke en memoire (RAM)
//       Quand tu auras Airtable, ca syncronise automatiquement
// ============================================================

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const { scoreLead } = require('../../llm/openai');

// ---- BASE DE DONNEES EN MEMOIRE ----
// Tous les leads sont stockes ici pendant que le serveur tourne
// En production, utilise une vraie base de donnees (PostgreSQL, Airtable)
const leadsDB = new Map();

// Statuts possibles d'un lead
const LEAD_STATUS = {
  NEW: 'nouveau',
  CONTACTED: 'contacte',
  QUALIFYING: 'en_qualification',
  QUALIFIED: 'qualifie',
  SCHEDULED: 'rdv_planifie',
  CALLED: 'appele',
  CONVERTED: 'converti',
  LOST: 'perdu',
  FOLLOWUP_1: 'relance_1',
  FOLLOWUP_2: 'relance_2',
  FOLLOWUP_3: 'relance_3',
};

/**
 * Cree ou recupere un lead existant
 * @param {string} contactId t- ID unique du contact (numero whatsapp ou ID instagram)
 * @param {string} channel - 'whatsapp' ou 'instagram'
 * @param {Object} extraInfo - Infos supplementaires (nom, etc.)
 */
function getOrCreateLead(contactId, channel, extraInfo = {}) {
  // Si le lead existe deja, on le retourne
  if (leadsDB.has(contactId)) {
    return leadsDB.get(contactId);
  }

  // Sinon, creation d'un nouveau lead
  const newLead = {
    id: uuidv4(),
    contactId: contactId,
    channel: channel,
    status: LEAD_STATUS.NEW,
    score: 0,
    firstName: extraInfo.firstName || 'Prospect',
    lastName: extraInfo.lastName || '',
    phone: extraInfo.phone || '',
    email: extraInfo.email || '',
    // Historique de TOUTES les conversations
    conversationHistory: [],
    // Nombre de messages echanges
    messageCount: 0,
    // Reponses aux questions de qualification
    answers: {},
    // Dates importantes
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    lastFollowupAt: null,
    // Suivi des relances
    followupCount: 0,
    // Notes importantes sur le lead
    notes: [],
    // Si l'humain doit intervenir
    needsHuman: false,
    // ID de l'appel Vapi si appel passe
    callId: null,
  };

  leadsDB.set(contactId, newLead);
  console.log(`✅ Nouveau lead cree: ${contactId} (${channel})`);

  // Synchronisation Airtable si configure
  syncToAirtable(newLead).catch(err => console.log('Info: Airtable non configure'));

  return newLead;
}

/**
 * Met a jour les infos d'un lead
 */
function updateLead(contactId, updates) {
  const lead = leadsDB.get(contactId);
  if (!lead) return null;

  const updatedLead = {
    ...lead,
    ...updates,
    lastMessageAt: new Date().toISOString(),
  };

  leadsDB.set(contactId, updatedLead);

  // Sync Airtable
  syncToAirtable(updatedLead).catch(() => {});

  return updatedLead;
}

/**
 * Ajoute un message a l'historique de conversation
 * @param {string} contactId
 * @param {string} role - 'user' ou 'assistant'
 * @param {string} content - Contenu du message
 */
function addMessage(contactId, role, content) {
  const lead = leadsDB.get(contactId);
  if (!lead) return;

  lead.conversationHistory.push({
    role: role,
    content: content,
    timestamp: new Date().toISOString(),
  });

  lead.messageCount++;
  lead.lastMessageAt = new Date().toISOString();

  // Garde seulement les 20 derniers messages pour eviter trop de tokens OpenAI
  if (lead.conversationHistory.length > 20) {
    lead.conversationHistory = lead.conversationHistory.slice(-20);
  }

  leadsDB.set(contactId, lead);
}

/**
 * Calcule et met a jour le score d'un lead
 */
async function updateLeadScore(contactId) {
  const lead = leadsDB.get(contactId);
  if (!lead) return;

  try {
    const scoreData = await scoreLead(lead);
    updateLead(contactId, {
      score: scoreData.score,
      nextAction: scoreData.nextAction,
      notes: [...lead.notes, `Score: ${scoreData.score}/100 - ${scoreData.reason}`]
    });
    return scoreData;
  } catch (error) {
    console.error('Erreur calcul score:', error.message);
    return { score: lead.score, nexqction: 'nurture' };
  }
}

/**
 * Recupere tous les leads qui ont besoin de relance
 * (leads qui n'ont pas repondu depuis X jours)
 */
function getLeadsNeedingFollowup() {
  const now = new Date();
  const followupsNeeded = [];

  for (const [contactId, lead] of leadsDB.entries()) {
    // Skip si deja converti ou perdu
    if ([LEAD_STATUS.CONVERTED, LEAD_STATUS.LOST, LEAD_STATUS.SCHEDULED].includes(lead.status)) {
      continue;
    }

    // Skip si lead a besoin d'un humain (deja notifie)
    if (lead.needsHuman) continue;

    const lastMessage = new Date(lead.lastMessageAt);
    const daysSince = (now - lastMessage) / (1000 * 60 * 60 * 24);

    const day1 = parseInt(process.env.FOLLOWUP_DAY_1) || 1;
    const day2 = parseInt(process.env.FOLLOWUP_DAY_2) || 3;
    const day3 = parseInt(process.env.FOLLOWUP_DAY_3) || 7;

    if (lead.followupCount === 0 && daysSince >= day1) {      followupsNeeded.push({ lead, followupNumber: 1 });
    } else if (lead.followupCount === 1 && daysSince >= day2) {
      followupsNeeded.push({ lead, followupNumber: 2 });
    } else if (lead.followupCount === 2 && daysSince >= day3) {
      followupsNeeded.push({ lead, followupNumber: 3 });
    }
  }

  return followupsNeeded;
}

/**
 * Affiche un resume de tous les leads (pour le monitoring)
 */
function getDashboardStats() {
  const stats = {
    total: leadsDB.size,
    byStatus: {},
    byChannel: { whatsapp: 0, instagram: 0 },
    averageScore: 0,
    needsHuman: 0,
  };

  let totalScore = 0;

  for (const lead of leadsDB.values()) {
    // Stats par statut
    stats.byStatus[lead.status] = (stats.byStatus[lead.status] || 0) + 1;

    // Stats par canal
    if (lead.channel in stats.byChannel) {
      stats.byChannel[lead.channel]++;
    }

    // Score moyen
    totalScore += lead.score || 0;

    // Leads qui attendent intervention humaine
    if (lead.needsHuman) stats.needsHuman++;
  }

  stats.averageScore = leadsDB.size > 0 ? Math.round(totalScore / leadsDB.size) : 0;

  return stats;
}

/**
 * Synchronisation avec Airtable (optionnel)
 * Si AIRTABLE_API_KEY n'est pas configure, cette fonction ne fait rien
 */
async function syncToAirtable(lead) {
  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    return; // Airtable non configure, on ignore
  }

  const axios = require('axios');

  try {
    const fields = {
      'ID Contact': lead.contactId,
      'Prenom': lead.firstName,
      'Nom': lead.lastName,
      'Canal': lead.channel,
      'Statut': lead.status,
      'Score': lead.score,
      'Messages': lead.messageCount,
      'Telephone': lead.phone,
      'Cree le': lead.createdAt,
      'Dernier message': lead.lastMessageAt,
      'Notes': lead.notes.join('\n'),
    };

    // Recherche si le lead existe deja dans Airtable
    const searchResp = await axios.get(
      `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}`,
      {
        headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}` },
        params: { filterByFormula: `{ID Contact} = '${lead.contactId}'` }
      }
    );

    if (searchResp.data.records.length > 0) {
      // Mise a jour du record existant
      const recordId = searchResp.data.records[0].id;
      await axios.patch(
        `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}/${recordId}`,
        { fields },
        { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
      );
    } else {
      // Creation d'un nouveau record
      await axios.post(
        `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}`,
        { fields },
        { headers: { 'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}` } }
      );
    }
  } catch (error) {
    console.log('⚠️  Airtable sync failed (non critique):', error.message);
  }
}

module.exports = {
  LEAD_STATUS,
  getOrCreateLead,
  updateLead,
  addMessage,
  updateLeadScore,
  getLeadsNeedingFollowup,
  getDashboardStats,
  leadsDB,
};
