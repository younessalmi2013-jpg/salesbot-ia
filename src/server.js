// FICHIER: src/server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { initAgents, getStats } = require('./orchestrator/index');
const { startScheduler } = require('./sequences/scheduler');
const { getDashboardStats, leadsDB } = require('./agents/crm/index');
const bookingRoutes = require('./booking/routes');
const { getBookingStats, getAllBookings } = require('./booking/manager');
const instagramAgent = require('./agents/instagram/index');
const voiceAgent = require('./agents/voice/index');

let telegramAgent = null;
try { telegramAgent = require('./agents/telegram/index'); } catch(e) {}
let emailAgent = null;
try { emailAgent = require('./agents/email/index'); } catch(e) {}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use((req, res, next) => { if (!req.path.startsWith('/api')) console.log(`${req.method} ${req.path}`); next(); });

// Webhooks
app.get('/webhook/instagram', (req, res) => instagramAgent.verifyWebhook(req, res));
app.post('/webhook/instagram', async (req, res) => instagramAgent.handleWebhookEvent(req, res));
app.post('/webhook/vapi', async (req, res) => voiceAgent.handleVapiWebhook(req, res));

// Routes booking
app.use('/api', bookingRoutes);

// Status
app.get('/api/status', (req, res) => {
  res.json({ status:'running', timestamp:new Date().toISOString(), uptime:process.uptime(),
    stats: getDashboardStats(), systemStats: getStats(),
    agents: { whatsapp:false, instagram:!!process.env.META_ACCESS_TOKEN, telegram:!!process.env.TELEGRAM_BOT_TOKEN,
      email:!!(process.env.EMAIL_USER&&process.env.EMAIL_PASSWORD), vapi:!!process.env.VAPI_API_KEY, openai:!!process.env.OPENAI_API_KEY, scheduler:true } });
});

// Dashboard stats
app.get('/api/dashboard', (req, res) => {
  const stats = getDashboardStats();
  const recentLeads = Array.from(leadsDB.values()).sort((a,b)=>new Date(b.lastMessageAt)-new Date(a.lastMessageAt)).slice(0,10)
    .map(l => ({ name:l.firstName, channel:l.channel, status:l.status, score:l.score }));
  res.json({ stats, recentLeads });
});

// Leads
app.get('/api/leads', (req, res) => {
  const leads = Array.from(leadsDB.values()).sort((a,b)=>new Date(b.lastMessageAt)-new Date(a.lastMessageAt))
    .map(l => ({ id:l.id, contactId:l.contactId, firstName:l.firstName, channel:l.channel, status:l.status,
      score:l.score, messageCount:l.messageCount, createdAt:l.createdAt, lastMessageAt:l.lastMessageAt, needsHuman:l.needsHuman }));
  res.json({ total:leads.length, leads });
});

app.get('/api/leads/:contactId', (req, res) => {
  const lead = leadsDB.get(decodeURIComponent(req.params.contactId));
  if (!lead) return res.status(404).json({ error:'Lead non trouve' });
  res.json(lead);
});

// Bookings dashboard
app.get('/api/bookings-dashboard', (req, res) => {
  const stats = getBookingStats();
  const upcoming = getAllBookings({ upcoming:true }).slice(0,5).map(b => ({
    id:b.id, firstName:b.firstName, lastName:b.lastName, slotDate:b.slotDate, slotTime:b.slotTime, channel:b.channel, status:b.status }));
  res.json({ stats, upcoming });
});

// ─────────────────────────────────────────────────────────────
// API VOCALE VAPI — 10 scripts disponibles
// ─────────────────────────────────────────────────────────────

// Liste tous les scripts disponibles
app.get('/api/calls/scripts', (req, res) => {
  const scripts = voiceAgent.listScripts();
  res.json({ scripts, total: scripts.length });
});

// Historique appels
app.get('/api/calls', async (req, res) => {
  const limit = parseInt(req.query.limit)||20;
  const calls = await voiceAgent.getCallHistory(limit);
  res.json({ total:calls.length, calls });
});

// Details d'un appel
app.get('/api/calls/:callId', async (req, res) => {
  const call = await voiceAgent.getCallDetails(req.params.callId);
  if (!call) return res.status(404).json({ error:'Appel non trouve' });
  res.json(call);
});

/**
 * POST /api/calls/trigger
 * Declencher un appel avec un script specifique
 * Body: { phone, leadName, leadContext, scriptType, leadId }
 * Scripts: prospection | qualification | prise_rdv | relance | suivi_post_rdv |
 *          recuperation | no_show | urgence | confirmation_rdv | upsell
 */
app.post('/api/calls/trigger', async (req, res) => {
  const { phone, leadName, leadContext, scriptType, leadId } = req.body;
  if (!phone) return res.status(400).json({ error:'phone requis' });
  if (!process.env.VAPI_API_KEY) return res.status(503).json({ error:'VAPI_API_KEY manquant. Configurez dans Railway.' });
  if (!process.env.VAPI_PHONE_NUMBER_ID) return res.status(503).json({ error:'VAPI_PHONE_NUMBER_ID manquant. Configurez dans Railway.' });
  try {
    const lead = leadId ? leadsDB.get(leadId) : null;
    const result = await voiceAgent.makeCall({ phone, leadName: leadName||lead?.firstName||'prospect',
      leadContext: leadContext||lead?.summary||'', scriptType: scriptType||'prospection', lead });
    res.json({ success: result.status==='initiated', ...result });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/calls/trigger-auto
 * Appel avec selection automatique du script selon l'etat du lead
 * Body: { leadId }
 */
app.post('/api/calls/trigger-auto', async (req, res) => {
  const { leadId } = req.body;
  if (!leadId) return res.status(400).json({ error:'leadId requis' });
  const lead = leadsDB.get(leadId);
  if (!lead) return res.status(404).json({ error:'Lead non trouve' });
  if (!lead.phone) return res.status(400).json({ error:"Ce lead n'a pas de telephone" });
  try {
    const result = await voiceAgent.makeCall({ phone:lead.phone, leadName:lead.firstName||'prospect', leadContext:lead.summary||'', lead });
    res.json({ success:result.status==='initiated', scriptUsed:result.scriptType, ...result });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Pages HTML
app.get('/booking', (req, res) => res.sendFile(path.join(__dirname, '../public/booking.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));

// Demarrage
async function start() {
  console.log('\n=== SALESBOT IA — Demarrage ===');
  let telegramInstance = null;
  if (telegramAgent && process.env.TELEGRAM_BOT_TOKEN) { telegramInstance = telegramAgent.startBot(); console.log('Telegram actif'); }
  if (emailAgent && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) { emailAgent.startEmailPolling(); console.log('Email actif'); }
  if (process.env.VAPI_API_KEY) console.log('Vapi actif — 10 scripts disponibles');
  initAgents({ instagram:instagramAgent, voice:voiceAgent,
    telegram: telegramInstance ? { sendMessage:telegramAgent.sendMessage } : null,
    email: emailAgent ? { sendMessageFromOrchestrator:emailAgent.sendMessageFromOrchestrator } : null });
  startScheduler();
  app.listen(PORT, () => {
    console.log(`Serveur: http://localhost:${PORT}`);
    console.log(`Scripts Vapi: GET http://localhost:${PORT}/api/calls/scripts`);
    console.log(`Trigger appel: POST http://localhost:${PORT}/api/calls/trigger`);
  });
}

process.on('uncaughtException', err => console.error('Exception:', err.message));
process.on('unhandledRejection', reason => console.error('Rejection:', reason));
start();
