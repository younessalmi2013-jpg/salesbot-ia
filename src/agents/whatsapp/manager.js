const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const db = require('../../db');

// In-memory state: { agentId: { client, status, qr, phone } }
const clients = {};

async function initClient(agentRecord) {
  const id = agentRecord.id;
  if (clients[id]) return; // already initialized

  console.log(`\x1b[36m🤖 Init agent WA: ${agentRecord.name} (${id})\x1b[0m`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: id }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
             '--disable-dev-shm-usage', '--no-first-run', '--no-zygote', '--single-process'],
    },
  });

  clients[id] = { client, status: 'initializing', qr: null, phone: null };

  client.on('qr', async (qr) => {
    try {
      const img = await qrcode.toDataURL(qr);
      clients[id].qr = img;
      clients[id].status = 'qr_ready';
      db.agents.update(id, { status: 'qr_ready', phone: null });
      console.log(`\x1b[33m📱 QR pret: ${agentRecord.name}\x1b[0m`);
    } catch (e) { console.error(e); }
  });

  client.on('ready', () => {
    const phone = client.info?.wid?.user || null;
    clients[id] = { ...clients[id], status: 'connected', qr: null, phone };
    db.agents.update(id, { status: 'connected', phone });
    console.log(`\x1b[32m✅ Agent connecte: ${agentRecord.name} (+${phone})\x1b[0m`);
  });

  client.on('auth_failure', (msg) => {
    clients[id] = { ...clients[id], status: 'auth_failed', qr: null };
    db.agents.update(id, { status: 'auth_failed' });
    console.error(`\x1b[31m❌ Auth failure: ${agentRecord.name}: ${msg}\x1b[0m`);
  });

  client.on('disconnected', () => {
    clients[id] = { ...clients[id], status: 'disconnected', qr: null, phone: null };
    db.agents.update(id, { status: 'disconnected', phone: null });
    console.log(`\x1b[33m⚠️  Deconnecte: ${agentRecord.name}\x1b[0m`);
  });

  client.on('message', async (msg) => {
    if (msg.fromMe) return;
    try {
      const { handleIncomingMessage } = require('../../orchestrator');
      await handleIncomingMessage({
        agentId: id,
        userId: agentRecord.userId,
        from: msg.from.replace('@c.us', ''),
        body: msg.body,
        channel: 'whatsapp',
        send: (text) => client.sendMessage(msg.from, text),
      });
    } catch (e) {
      console.error('WA message error:', e.message);
    }
  });

  try {
    await client.initialize();
  } catch (e) {
    clients[id] = { ...clients[id], status: 'error' };
    console.error(`Init error agent ${id}:`, e.message);
  }
}

async function createAgent(userId, name) {
  const record = db.agents.insert({ userId, name, status: 'initializing', phone: null });
  // Initialize async (don't await here so HTTP request returns fast)
  setImmediate(() => initClient(record).catch(console.error));
  return record;
}

async function deleteAgent(agentId) {
  if (clients[agentId]) {
    try { await clients[agentId].client.destroy(); } catch (e) {}
    delete clients[agentId];
  }
  // Remove session directory
  const path = require('path');
  const fs = require('fs');
  const sessionDir = path.join(process.cwd(), `.wwebjs_auth/session-${agentId}`);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  db.agents.delete(agentId);
}

async function restartAgent(agentId) {
  if (clients[agentId]) {
    try { await clients[agentId].client.destroy(); } catch (e) {}
    delete clients[agentId];
  }
  const record = db.agents.findById(agentId);
  if (record) await initClient(record);
}

function getStatus(agentId) {
  return clients[agentId]?.status || 'offline';
}

function getQR(agentId) {
  return clients[agentId]?.qr || null;
}

function getPhone(agentId) {
  return clients[agentId]?.phone || null;
}

async function sendMessage(agentId, to, message) {
  const state = clients[agentId];
  if (!state || state.status !== 'connected') throw new Error('Agent non connecte ou hors ligne');
  const chatId = to.replace(/\D/g, '') + '@c.us';
  return state.client.sendMessage(chatId, message);
}

async function initAllAgents() {
  const all = db.agents.findAll();
  console.log(`\x1b[36m🚀 Initialisation de ${all.length} agent(s) WA...\x1b[0m`);
  for (const agent of all) {
    try { await initClient(agent); } catch (e) {
      console.error(`Erreur init agent ${agent.id}:`, e.message);
    }
    // Small delay between agents to avoid overloading
    await new Promise(r => setTimeout(r, 2000));
  }
}

module.exports = {
  createAgent, deleteAgent, restartAgent,
  getStatus, getQR, getPhone, sendMessage,
  initAllAgents, clients,
};
