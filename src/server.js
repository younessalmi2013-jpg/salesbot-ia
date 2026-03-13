'use strict';
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;
const startTime = Date.now();

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

const { requireAuth, requireAdmin } = require('./middleware/auth');
app.use('/auth', require('./routes/auth'));

app.get('/', requireAuth, (req, res) => {
  const p = path.join(__dirname, '../public/dashboard.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send('<h1>SalesBot IA</h1>');
});

app.get('/login', (req, res) => {
  const p = path.join(__dirname, '../public/login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send('<form method="POST" action="/auth/login"><input name="username" placeholder="Utilisateur" required><input name="password" type="password" placeholder="Mot de passe" required><button>Connexion</button></form>');
});

let crmAgent = null;
let bookingAgent = null;
let whatsappAgent = null;

function loadAgents() {
  try { crmAgent = require('./agents/crm'); console.log('[Server] CRM agent charge'); }
  catch (e) { console.error('[Server] CRM agent erreur:', e.message); }
  try { bookingAgent = require('./agents/booking'); console.log('[Server] Booking agent charge'); }
  catch (e) {
    try { bookingAgent = require('./booking'); console.log('[Server] Booking agent charge (fallback)'); }
    catch (e2) { console.log('[Server] Booking agent non disponible'); }
  }
  try {
    whatsappAgent = require('./agents/whatsapp');
    console.log('[Server] WhatsApp agent charge');
    if (process.env.WHATSAPP_ENABLED === 'true') {
      whatsappAgent.initialize().catch(e => console.error('[WhatsApp] Init erreur:', e.message));
    }
  } catch (e) { console.error('[Server] WhatsApp agent erreur:', e.message); }
}

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const stats = crmAgent ? await crmAgent.getStats() : { total: 0, new: 0, qualified: 0, rdv: 0, clients: 0 };
    res.json({ ...stats, uptime: Math.floor((Date.now() - startTime) / 1000), agents: { crm: !!crmAgent, booking: !!bookingAgent, whatsapp: !!whatsappAgent } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leads', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    res.json(await crmAgent.getAllLeads(req.query));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    res.status(201).json(await crmAgent.createLead(req.body));
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
    res.json(lead);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    const ok = await crmAgent.deleteLead(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Lead non trouve' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/:id/message', requireAuth, async (req, res) => {
  try {
    if (!crmAgent) return res.status(503).json({ error: 'CRM non disponible' });
    const lead = await crmAgent.addMessage(req.params.id, req.body);
    if (!lead) return res.status(404).json({ error: 'Lead non trouve' });
    res.json(lead);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  if (!status.initializing) whatsappAgent.initialize().catch(e => console.error('[WhatsApp] Init erreur:', e.message));
  res.json({ connected: false, initializing: true, message: 'Initialisation en cours...' });
});

app.post('/api/whatsapp/start', requireAuth, async (req, res) => {
  try {
    if (!whatsappAgent) return res.status(503).json({ error: 'WhatsApp non disponible' });
    const st = whatsappAgent.getStatus();
    if (st.connected) return res.json({ success: true, message: 'Deja connecte' });
    if (!st.initializing) whatsappAgent.initialize().catch(e => console.error(e.message));
    res.json({ success: true, message: 'Initialisation lancee' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/whatsapp/logout', requireAuth, async (req, res) => {
  try {
    if (!whatsappAgent) return res.status(503).json({ error: 'WhatsApp non disponible' });
    await whatsappAgent.logout();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/whatsapp/send', requireAuth, async (req, res) => {
  try {
    if (!whatsappAgent) return res.status(503).json({ error: 'WhatsApp non disponible' });
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'phone et message requis' });
    await whatsappAgent.sendMessage(phone, message);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bookings', requireAuth, async (req, res) => {
  try {
    if (!bookingAgent) return res.json([]);
    res.json(bookingAgent.getAllBookings ? await bookingAgent.getAllBookings() : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bookings', requireAuth, async (req, res) => {
  try {
    if (!bookingAgent) return res.status(503).json({ error: 'Booking non disponible' });
    res.status(201).json(await bookingAgent.createBooking(req.body));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bookings/:id', requireAuth, async (req, res) => {
  try {
    if (!bookingAgent) return res.status(503).json({ error: 'Booking non disponible' });
    const booking = await bookingAgent.updateBooking(req.params.id, req.body);
    if (!booking) return res.status(404).json({ error: 'Booking non trouve' });
    res.json(booking);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/bookings/:id', requireAuth, async (req, res) => {
  try {
    if (!bookingAgent) return res.status(503).json({ error: 'Booking non disponible' });
    const ok = await bookingAgent.deleteBooking(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Booking non trouve' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/calls', requireAuth, async (req, res) => {
  try {
    const logsDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logsFile = path.join(logsDir, 'calls.json');
    let calls = [];
    if (fs.existsSync(logsFile)) { try { calls = JSON.parse(fs.readFileSync(logsFile, 'utf8')); } catch(e) { calls = []; } }
    const call = { ...req.body, id: Date.now().toString(), timestamp: new Date().toISOString() };
    calls.push(call);
    if (calls.length > 500) calls = calls.slice(-500);
    fs.writeFileSync(logsFile, JSON.stringify(calls, null, 2));
    res.status(201).json(call);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/calls', requireAuth, async (req, res) => {
  try {
    const logsFile = path.join(process.cwd(), 'data', 'calls.json');
    if (!fs.existsSync(logsFile)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(logsFile, 'utf8')).reverse().slice(0, 100));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000), agents: { crm: !!crmAgent, booking: !!bookingAgent, whatsapp: !!whatsappAgent } });
});

app.use((req, res) => {
  if (req.accepts('html')) return res.redirect('/');
  res.status(404).json({ error: 'Route non trouvee' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('[Server] SalesBot IA demarre sur port ' + PORT);
  loadAgents();
});
