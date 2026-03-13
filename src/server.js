'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const { requireAuth, requireAdmin } = require('./middleware/auth');
app.use('/auth', require('./routes/auth'));

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

let crmAgent, whatsappAgent, bookingAgent;

function loadAgents() {
  try {
    crmAgent = require('./agents/crm');
    console.log('[Server] CRM agent charge');
  } catch (e) { console.error('[Server] CRM agent erreur:', e.message); }

  try {
    bookingAgent = require('./booking');
    console.log('[Server] Booking agent charge');
  } catch (e) { console.error('[Server] Booking agent erreur:', e.message); }

  try {
    whatsappAgent = require('./agents/whatsapp');
    if (process.env.WHATSAPP_ENABLED === 'true') {
      whatsappAgent.initialize().catch(e => console.error('[WhatsApp] Erreur init:', e.message));
    }
    console.log('[Server] WhatsApp agent charge');
  } catch (e) { console.error('[Server] WhatsApp agent erreur:', e.message); }
}

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const stats = crmAgent ? await crmAgent.getStats() : {
      total: 0, new: 0, qualified: 0, rdv: 0, clients: 0, lost: 0, todayNew: 0
    };
    res.json({
      ...stats,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      agents: { whatsapp: whatsappAgent ? whatsappAgent.isReady : false, crm: !!crmAgent, booking: !!bookingAgent },
      systemStats: { messagesProcessed: global._msgCount || 0, responsesSent: global._responseCount || 0, callsTriggered: global._callCount || 0, followupsSent: global._followupCount || 0 }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.json({ leads: [], total: 0 });
    const filters = { status: req.query.status, channel: req.query.channel, search: req.query.search };
    const leads = await crmAgent.getAllLeads(filters);
    const limit = parseInt(req.query.limit) || 0;
    res.json({ leads: limit ? leads.slice(0, limit) : leads, total: leads.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    const { name, phone, email, channel, status, notes, score } = req.body;
    if (!name) return res.status(400).json({ error: 'Le nom est requis' });
    const lead = await crmAgent.createLead({
      name, phone, email,
      channel: channel || 'web',
      status: status || 'new',
      notes, score: score || 0
    });
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
    const deleted = await crmAgent.deleteLead(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Lead non trouve' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/:id/message', requireAuth, async (req, res) => {
  try {
    const { text, channel } = req.body;
    if (!text) return res.status(400).json({ error: 'Message requis' });
    const lead = await crmAgent.getLeadById(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead non trouve' });
    const ch = channel || lead.channel;
    let sent = false;
    if (ch === 'whatsapp' && whatsappAgent && whatsappAgent.isReady) {
      await whatsappAgent.sendMessage(lead.phone, text);
      sent = true;
    }
    await crmAgent.addMessage(req.params.id, { from: 'agent', text, channel: ch });
    res.json({ success: true, sent, channel: ch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/whatsapp/status', requireAuth, (req, res) => {
  if (!whatsappAgent) return res.json({ connected: false, available: false, message: 'Agent non charge' });
  const status = whatsappAgent.getStatus();
  res.json({ ...status, available: true });
});

app.get('/api/whatsapp/qr', requireAuth, (req, res) => {
  if (!whatsappAgent) return res.status(503).json({ error: 'WhatsApp non disponible' });
  const status = whatsappAgent.getStatus();
  if (status.connected) return res.json({ connected: true, phone: status.phone });
  const qr = whatsappAgent.getQR();
  if (qr) return res.json({ qr, connected: false });
  if (!status.initializing) whatsappAgent.initialize().catch(e => console.error(e.message));
  res.json({ connected: false, initializing: true, message: 'Initialisation en cours...' });
});

app.post('/api/whatsapp/start', requireAuth, async (req, res) => {
  try {
    if (!whatsappAgent) return res.status(503).json({ error: 'Agent non disponible' });
    const status = whatsappAgent.getStatus();
    if (status.connected) return res.json({ success: true, message: 'Deja connecte' });
    if (status.initializing) return res.json({ success: true, message: 'Deja en cours...' });
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

const callsLog = [];
app.get('/api/calls', requireAuth, (req, res) => {
  res.json({ calls: callsLog.slice(-50) });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000), timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route non trouvee: ' + req.path });
  res.redirect('/login');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] SalesBot IA demarre sur le port ${PORT}`);
  loadAgents();
});

module.exports = app;
require('dotenv').config();
const express = require('express');
const path    = require('path');
const cookieParser = require('cookie-parser');
const { requireAuth, requireAdmin } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// âââ Body / Cookie parsing ââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// âââ Auth routes (public) âââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.use('/auth', require('./routes/auth'));

// âââ Login page (public) ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// âââ Webhook Vapi (public â called by Vapi servers) ââââââââââââââââââââââââââ
const voiceAgent = require('./agents/voice');
app.post('/webhook/vapi', async (req, res) => {
  try { await voiceAgent.handleVapiWebhook(req, res); }
  catch (e) { console.error('Vapi webhook error:', e); res.status(500).json({ error: e.message }); }
});

// âââ Webhook WhatsApp (public) ââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) res.send(challenge);
  else res.sendStatus(403);
});
app.post('/webhook', express.json(), (req, res) => {
  res.sendStatus(200);
  const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
  if (entry?.messages?.[0]) {
    const msg = entry.messages[0];
    const from = msg.from;
    const text = msg.text?.body || '';
    const orchestrator = require('./orchestrator');
    orchestrator.handleMessage({ channel: 'whatsapp', from, text, raw: msg }).catch(console.error);
  }
});

// âââ Protected static assets (dashboard) âââââââââââââââââââââââââââââââââââââ
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// âââ Protected API routes âââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Health
app.get('/api/health', requireAuth, (req, res) => {
  res.json({ status: 'OK', user: req.user.username, role: req.user.role, ts: new Date().toISOString() });
});

// ââ CRM / Leads âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const crmAgent = require('./agents/crm');
app.get('/api/leads', requireAuth, (req, res) => res.json(crmAgent.getLeads()));
app.post('/api/leads', requireAuth, (req, res) => {
  const lead = crmAgent.addLead(req.body);
  res.json(lead);
});
app.patch('/api/leads/:id', requireAuth, (req, res) => {
  const lead = crmAgent.updateLead(req.params.id, req.body);
  res.json(lead || { error: 'Lead non trouvÃ©' });
});
app.delete('/api/leads/:id', requireAdmin, (req, res) => {
  crmAgent.deleteLead(req.params.id);
  res.json({ success: true });
});

// ââ Bookings / RDV ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const bookingAgent = require('./booking');
app.get('/api/bookings', requireAuth, async (req, res) => {
  try { res.json(await bookingAgent.getBookings()); }
  catch (e) { res.json([]); }
});

// ââ Stats âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/stats', requireAuth, (req, res) => {
  const leads = crmAgent.getLeads();
  const today = new Date().toDateString();
  res.json({
    total: leads.length,
    new: leads.filter(l => l.status === 'new').length,
    qualified: leads.filter(l => l.status === 'qualified').length,
    rdv: leads.filter(l => l.status === 'rdv_programme').length,
    clients: leads.filter(l => l.status === 'client').length,
    todayNew: leads.filter(l => new Date(l.createdAt).toDateString() === today).length
  });
});

// ââ Voice / Calls âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/calls/scripts', requireAuth, (req, res) => {
  try { res.json(require('./agents/voice').listScripts()); }
  catch { res.json([]); }
});

app.get('/api/calls', requireAuth, async (req, res) => {
  try { res.json(await voiceAgent.getCallHistory(50)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/calls/:callId', requireAuth, async (req, res) => {
  try { res.json(await voiceAgent.getCallDetails(req.params.callId)); }
  catch (e) { res.status(404).json({ error: 'Appel non trouvÃ©' }); }
});

app.post('/api/calls/trigger', requireAuth, async (req, res) => {
  const { phone, leadName, leadContext, scriptType, leadId } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone requis' });
  if (!process.env.VAPI_API_KEY || !process.env.VAPI_PHONE_NUMBER_ID)
    return res.status(503).json({ error: 'Vapi non configurÃ© (VAPI_API_KEY / VAPI_PHONE_NUMBER_ID manquants)' });
  try {
    const result = await voiceAgent.makeCall({ phone, leadName, leadContext, scriptType, leadId });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/calls/trigger-auto', requireAuth, async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error: 'leadId requis' });
  const lead = crmAgent.getLeads().find(l => l.id === leadId);
  if (!lead) return res.status(404).json({ error: 'Lead non trouvÃ©' });
  if (!lead.phone) return res.status(400).json({ error: 'Lead sans numÃ©ro de tÃ©lÃ©phone' });
  try {
    const result = await voiceAgent.makeCall({ phone: lead.phone, lead });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ââ Admin: manage clients âââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/admin/clients', requireAdmin, (req, res) => {
  try {
    const users = JSON.parse(process.env.USERS_CONFIG || '[]');
    res.json(users.map(u => ({ username: u.username, name: u.name, role: u.role })));
  } catch { res.json([]); }
});

app.post('/api/admin/clients', requireAdmin, (req, res) => {
  const { username, password, name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username + password requis' });
  const users = JSON.parse(process.env.USERS_CONFIG || '[]');
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Existe dÃ©jÃ ' });
  users.push({ username, password, name: name || username, role: 'client' });
  process.env.USERS_CONFIG = JSON.stringify(users);
  res.json({ success: true, newUsersConfig: process.env.USERS_CONFIG });
});

app.delete('/api/admin/clients/:username', requireAdmin, (req, res) => {
  const users = JSON.parse(process.env.USERS_CONFIG || '[]').filter(u => u.username !== req.params.username);
  process.env.USERS_CONFIG = JSON.stringify(users);
  res.json({ success: true });
});

// ââ Connexions / Integration status âââââââââââââââââââââââââââââââââââââââââââ
app.get('/api/integrations', requireAuth, (req, res) => {
  res.json({
    whatsapp: { enabled: !!process.env.META_VERIFY_TOKEN, status: 'configured' },
    telegram: { enabled: !!process.env.TELEGRAM_TOKEN, status: process.env.TELEGRAM_TOKEN ? 'configured' : 'missing' },
    instagram: { enabled: false, status: 'coming_soon' },
    email: { enabled: !!process.env.EMAIL_USER, status: process.env.EMAIL_USER ? 'configured' : 'missing' },
    voice: {
      enabled: !!process.env.VAPI_API_KEY,
      status: process.env.VAPI_API_KEY ? 'configured' : 'missing',
      phone: process.env.VAPI_PHONE_NUMBER_ID ? '+1 (339) 233 9319' : null
    },
    openai: { enabled: !!process.env.OPENAI_API_KEY, status: process.env.OPENAI_API_KEY ? 'configured' : 'missing' }
  });
});

// âââ Fallback: protect everything else âââââââââââââââââââââââââââââââââââââââ
app.use(requireAuth, express.static(path.join(__dirname, '../public')));

// âââ Start ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
app.listen(PORT, () => console.log(`ð SalesBot IA dÃ©marrÃ© sur :${PORT}`));
