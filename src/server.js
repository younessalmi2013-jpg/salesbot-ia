'use strict';
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

// =====================
// Config IA (persistee dans data/config.json)
// =====================
const CONFIG_PATH = path.join(process.cwd(), 'data', 'config.json');

function getConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {}
  return {
    botName: process.env.BOT_NAME || 'Sophie',
    productName: process.env.PRODUCT_NAME || 'notre programme',
    language: 'fr',
    systemPrompt: 'Tu es {botName}, une conseillere commerciale sympathique.\nTu travailles pour: {productName}.\nRegles: messages courts (3-4 lignes), termine par une question, ne revele pas que tu es une IA, propose un appel avant les prix.\nTa mission: qualifier les leads et les amener a prendre un rendez-vous.',
    autoCallEnabled: false,
    followupEnabled: true,
    followupDays: [1, 3, 7]
  };
}

function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// =====================
// Middleware
// =====================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =====================
// Auth
// =====================
const { requireAuth, requireAdmin } = require('./middleware/auth');
app.use('/auth', require('./routes/auth'));

// =====================
// Pages HTML
// =====================
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// =====================
// Agents (chargement differe)
// =====================
let crmAgent, whatsappAgent, bookingAgent, telegramAgent, emailAgent;

function loadAgents() {
  try { crmAgent = require('./agents/crm'); console.log('[Server] CRM OK'); }
  catch (e) { console.error('[Server] CRM erreur:', e.message); }

  try { bookingAgent = require('./booking'); console.log('[Server] Booking OK'); }
  catch (e) { console.error('[Server] Booking erreur:', e.message); }

  try {
    whatsappAgent = require('./agents/whatsapp');
    if (process.env.WHATSAPP_ENABLED === 'true') {
      whatsappAgent.initialize().catch(e => console.error('[WA] Init erreur:', e.message));
    }
    console.log('[Server] WhatsApp OK');
  } catch (e) { console.error('[Server] WhatsApp erreur:', e.message); }

  // Telegram (optionnel)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      telegramAgent = require('./agents/telegram');
      telegramAgent.startBot();
      console.log('[Server] Telegram OK');
    } catch (e) { console.error('[Server] Telegram erreur:', e.message); }
  } else {
    console.log('[Server] Telegram: TELEGRAM_BOT_TOKEN non defini');
  }

  // Email (optionnel)
  if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
    try {
      emailAgent = require('./agents/email');
      emailAgent.startEmailPolling();
      console.log('[Server] Email OK');
    } catch (e) { console.error('[Server] Email erreur:', e.message); }
  } else {
    console.log('[Server] Email: EMAIL_USER/EMAIL_PASSWORD non definis');
  }
}

// =====================
// API - Config IA
// =====================
app.get('/api/config', requireAuth, (req, res) => {
  res.json(getConfig());
});

app.put('/api/config', requireAuth, (req, res) => {
  try {
    const updated = { ...getConfig(), ...req.body };
    saveConfig(updated);
    res.json({ success: true, config: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================
// API - Stats
// =====================
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const stats = crmAgent ? await crmAgent.getStats() : {
      total: 0, new: 0, qualified: 0, rdv: 0, clients: 0, lost: 0, todayNew: 0,
      byStatus: {}, byChannel: {}
    };
    res.json({
      ...stats,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      agents: {
        whatsapp: whatsappAgent ? whatsappAgent.isReady : false,
        telegram: telegramAgent ? telegramAgent.isRunning() : false,
        email: !!(emailAgent && process.env.EMAIL_USER),
        instagram: !!process.env.META_ACCESS_TOKEN,
        crm: !!crmAgent,
        booking: !!bookingAgent
      },
      systemStats: {
        messagesProcessed: global._msgCount || 0,
        responsesSent: global._responseCount || 0,
        callsTriggered: global._callCount || 0,
        followupsSent: global._followupCount || 0
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================
// API - Integrations (statut en direct)
// =====================
app.get('/api/integrations', requireAuth, (req, res) => {
  const waStatus = whatsappAgent ? whatsappAgent.getStatus() : null;
  res.json({
    whatsapp: {
      enabled: !!whatsappAgent,
      connected: waStatus ? waStatus.connected : false,
      initializing: waStatus ? waStatus.initializing : false,
      phone: waStatus ? (waStatus.phone || null) : null,
      status: waStatus ? (waStatus.connected ? 'connected' : waStatus.initializing ? 'initializing' : 'disconnected') : 'unavailable'
    },
    telegram: {
      enabled: !!process.env.TELEGRAM_BOT_TOKEN,
      connected: telegramAgent ? telegramAgent.isRunning() : false,
      status: !process.env.TELEGRAM_BOT_TOKEN ? 'missing_token' : (telegramAgent && telegramAgent.isRunning() ? 'connected' : 'error')
    },
    instagram: {
      enabled: !!process.env.META_ACCESS_TOKEN,
      connected: !!process.env.META_ACCESS_TOKEN,
      webhookUrl: process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/instagram` : null,
      status: process.env.META_ACCESS_TOKEN ? 'configured' : 'missing_token'
    },
    email: {
      enabled: !!(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD),
      connected: !!(emailAgent && process.env.EMAIL_USER),
      user: process.env.EMAIL_USER || null,
      status: (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) ? 'missing_credentials' : (emailAgent ? 'connected' : 'error')
    }
  });
});

// =====================
// API - Leads CRUD
// =====================
app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.json({ leads: [], total: 0 });
    const leads = await crmAgent.getAllLeads({
      status: req.query.status,
      channel: req.query.channel,
      search: req.query.search
    });
    const limit = parseInt(req.query.limit) || 0;
    res.json({ leads: limit ? leads.slice(0, limit) : leads, total: leads.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    const { name, phone, email, channel, status, notes, score } = req.body;
    if (!name) return res.status(400).json({ error: 'Le nom est requis' });
    const lead = await crmAgent.createLead({ name, phone, email, channel: channel || 'web', status: status || 'new', notes, score: score || 0 });
    res.status(201).json({ success: true, lead });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    const lead = await crmAgent.getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead non trouve' });
    res.json(lead);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    const lead = await crmAgent.updateLead(req.params.id, req.body);
    if (!lead) return res.status(404).json({ error: 'Lead non trouve' });
    res.json({ success: true, lead });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    await crmAgent.deleteLead(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envoyer un message manuel a un lead
app.post('/api/leads/:id/message', requireAuth, async (req, res) => {
  try {
    const { text, channel } = req.body;
    if (!text) return res.status(400).json({ error: 'Message requis' });
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    const lead = await crmAgent.getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead non trouve' });
    const ch = channel || lead.channel;
    let sent = false;
    if (ch === 'whatsapp' && whatsappAgent && whatsappAgent.isReady) {
      await whatsappAgent.sendMessage(lead.phone, text); sent = true;
    } else if (ch === 'telegram' && telegramAgent && telegramAgent.isRunning()) {
      await telegramAgent.sendMessage(lead.identifier || lead.phone, text); sent = true;
    }
    res.json({ success: true, sent, channel: ch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================
// API - WhatsApp
// =====================
app.get('/api/whatsapp/status', requireAuth, (req, res) => {
  if (!whatsappAgent) return res.json({ connected: false, available: false });
  res.json({ ...whatsappAgent.getStatus(), available: true });
});

app.get('/api/whatsapp/qr', requireAuth, (req, res) => {
  if (!whatsappAgent) return res.status(503).json({ error: 'WhatsApp non disponible' });
  const status = whatsappAgent.getStatus();
  if (status.connected) return res.json({ connected: true, phone: status.phone });
  const qr = whatsappAgent.getQR();
  if (qr) return res.json({ qr, connected: false });
  if (!status.initializing) whatsappAgent.initialize().catch(e => console.error(e.message));
  res.json({ connected: false, initializing: true, message: 'QR en cours de generation...' });
});

app.post('/api/whatsapp/start', requireAuth, async (req, res) => {
  try {
    if (!whatsappAgent) return res.status(503).json({ error: 'Agent non disponible' });
    const s = whatsappAgent.getStatus();
    if (s.connected) return res.json({ success: true, message: 'Deja connecte' });
    if (s.initializing) return res.json({ success: true, message: 'Deja en cours...' });
    whatsappAgent.initialize().catch(console.error);
    res.json({ success: true, message: 'Initialisation demarree' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/whatsapp/logout', requireAuth, async (req, res) => {
  try {
    if (!whatsappAgent) return res.status(503).json({ error: 'Agent non disponible' });
    await whatsappAgent.logout();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/whatsapp/send', requireAuth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone et message requis' });
    if (!whatsappAgent || !whatsappAgent.isReady) return res.status(503).json({ error: 'WhatsApp non connecte' });
    await whatsappAgent.sendMessage(phone, message);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================
// API - Telegram
// =====================
app.post('/api/telegram/send', requireAuth, async (req, res) => {
  try {
    const { chatId, message } = req.body;
    if (!chatId || !message) return res.status(400).json({ error: 'chatId et message requis' });
    if (!telegramAgent || !telegramAgent.isRunning()) return res.status(503).json({ error: 'Telegram non connecte' });
    await telegramAgent.sendMessage(chatId, message);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================
// Webhook Instagram
// =====================
app.get('/webhook/instagram', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === (process.env.META_VERIFY_TOKEN || 'salesbot_verify_2024')) {
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook/instagram', (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'instagram') return;
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        if (event.message?.is_echo || !event.message?.text) continue;
        const from = event.sender?.id;
        const text = event.message.text;
        console.log(`[Instagram] Message de ${from}: ${text.substring(0, 50)}`);
      }
    }
  } catch (e) { console.error('[Instagram] Webhook error:', e.message); }
});

// =====================
// API - Bookings
// =====================
app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    if (!bookingAgent) return res.json({ bookings: [] });
    const bookings = await bookingAgent.getBookings();
    res.json({ bookings: bookings || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bookings', requireAuth, async (req, res) => {
  try {
    if (!bookingAgent) return res.status(503).json({ error: 'Booking non disponible' });
    const booking = await bookingAgent.createBooking(req.body);
    res.status(201).json({ success: true, booking });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bookings/:id', requireAuth, async (req, res) => {
  try {
    if (!bookingAgent) return res.status(503).json({ error: 'Booking non disponible' });
    const booking = await bookingAgent.updateBookingStatus(req.params.id, req.body.status);
    res.json({ success: true, booking });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================
// API - Calls
// =====================
const callsLog = [];
app.get('/api/calls', requireAuth, (req, res) => {
  res.json({ calls: callsLog.slice(-50) });
});

// =====================
// Health
// =====================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000), timestamp: new Date().toISOString() });
});

// =====================
// 404
// =====================
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) {
    return res.status(404).json({ error: 'Route non trouvee: ' + req.path });
  }
  res.redirect('/login');
});

// =====================
// Demarrage
// =====================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] SalesBot IA demarre sur le port ${PORT}`);
  loadAgents();
});

module.exports = app;
