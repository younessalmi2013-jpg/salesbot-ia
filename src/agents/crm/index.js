'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(process.cwd(), 'data', 'leads.json');

function ensureDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ leads: [] }, null, 2));
}

function readDB() {
  ensureDB();
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) { return { leads: [] }; }
}

function writeDB(data) {
  ensureDB();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

async function getAllLeads(filters = {}) {
  const db = readDB();
  let leads = db.leads || [];
  if (filters.status && filters.status !== 'all') leads = leads.filter(l => l.status === filters.status);
  if (filters.channel) leads = leads.filter(l => l.channel === filters.channel);
  if (filters.search) {
    const q = filters.search.toLowerCase();
    leads = leads.filter(l =>
      (l.name || '').toLowerCase().includes(q) ||
      (l.phone || '').includes(q) ||
      (l.email || '').toLowerCase().includes(q)
    );
  }
  leads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return leads;
}

async function getLeadById(id) {
  const db = readDB();
  return (db.leads || []).find(l => l._id === id || l.id === id) || null;
}

function findLeadByPhone(phone) {
  const db = readDB();
  const clean = (phone || '').replace(/\D/g, '');
  return (db.leads || []).find(l => (l.phone || '').replace(/\D/g, '') === clean) || null;
}

function findLeadByEmail(email) {
  const db = readDB();
  return (db.leads || []).find(l => l.email === email) || null;
}

async function createLead(data) {
  const db = readDB();
  const id = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const lead = {
    _id: id,
    name: data.name || 'Inconnu',
    phone: data.phone || '',
    email: data.email || '',
    channel: data.channel || 'web',
    status: data.status || 'new',
    score: data.score || 0,
    notes: data.notes || '',
    lastMessage: data.lastMessage || '',
    lastContact: now,
    createdAt: now,
    messages: [],
    tags: data.tags || [],
    source: data.source || data.channel || 'web',
    identifier: data.identifier || data.phone || data.email || ''
  };
  db.leads = db.leads || [];
  db.leads.push(lead);
  writeDB(db);
  console.log('[CRM] Lead cree:', lead.name);
  return lead;
}

function updateLead(id, updates) {
  const db = readDB();
  const idx = (db.leads || []).findIndex(l => l._id === id || l.id === id);
  if (idx === -1) return null;
  db.leads[idx] = { ...db.leads[idx], ...updates, _id: db.leads[idx]._id, updatedAt: new Date().toISOString() };
  writeDB(db);
  return db.leads[idx];
}

function deleteLead(id) {
  const db = readDB();
  const before = (db.leads || []).length;
  db.leads = (db.leads || []).filter(l => l._id !== id && l.id !== id);
  writeDB(db);
  return before !== db.leads.length;
}

function addMessage(leadId, message) {
  const db = readDB();
  const idx = (db.leads || []).findIndex(l => l._id === leadId || l.id === leadId);
  if (idx === -1) return null;
  if (!db.leads[idx].messages) db.leads[idx].messages = [];
  db.leads[idx].messages.push({ ...message, timestamp: message.timestamp || new Date().toISOString() });
  if (db.leads[idx].messages.length > 50) db.leads[idx].messages = db.leads[idx].messages.slice(-50);
  db.leads[idx].lastContact = new Date().toISOString();
  writeDB(db);
  return db.leads[idx];
}

function updateLeadStatus(id, status) { return updateLead(id, { status }); }
function updateLeadScore(id, score) { return updateLead(id, { score: Math.min(10, Math.max(0, score)) }); }

function getStats() {
  const db = readDB();
  const leads = db.leads || [];
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const byStatus = {};
  leads.forEach(l => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });
  const todayNew = leads.filter(l => new Date(l.createdAt) >= today).length;
  const byChannel = {};
  leads.forEach(l => { byChannel[l.channel] = (byChannel[l.channel] || 0) + 1; });
  return {
    total: leads.length,
    new: byStatus.new || 0,
    qualified: byStatus.qualified || 0,
    rdv: byStatus.booked || 0,
    clients: byStatus.client || 0,
    lost: byStatus.lost || 0,
    todayNew,
    byStatus,
    byChannel
  };
}

module.exports = {
  getAllLeads, getLeadById, findLeadByPhone, findLeadByEmail,
  createLead, updateLead, deleteLead, addMessage,
  updateLeadStatus, updateLeadScore, getStats
};
