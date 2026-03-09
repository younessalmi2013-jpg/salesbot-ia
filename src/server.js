// ============================================================
// FICHIER: src/server.js
// ROLE: Serveur principal — 4 canaux: WhatsApp, Instagram, Telegram, Email
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const { initAgents, getStats } = require('./orchestrator/index');
const { startScheduler } = require('./sequences/scheduler');
const { getDashboardStats, leadsDB } = require('./agents/crm/index');
const bookingRoutes = require('./booking/routes');
const { getBookingStats, getAllBookings } = require('./booking/manager');

// ---- Agents ----
const instagramAgent = require('./agents/instagram/index');
const voiceAgent = require('./agents/voice/index');

// Telegram (optionnel — nécessite TELEGRAM_BOT_TOKEN)
let telegramAgent = null;
try {
  telegramAgent = require('./agents/telegram/index');
} catch (e) {
  console.log('ℹ️  Module Telegram non disponible');
}

// Email (optionnel — nécessite EMAIL_USER + EMAIL_PASSWORD)
let emailAgent = null;
try {
  emailAgent = require('./agents/email/index');
} catch (e) {
  console.log('ℹ️  Module Email non disponible');
}

const app = express();
const PORT = process.env.PORT || 3000;

// ---- MIDDLEWARES ----
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Log des requêtes entrantes
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) {
    console.log(`🌐 ${req.method} ${req.path}`);
  }
  next();
});

// ============================================================
// ── WEBHOOLS ──
// ============================================================

// Instagram — vérification
app.get('/webhook/instagram', (req, res) => instagramAgent.verifyWebhook(req, res));

// Instagram — messages entrants
app.post('/webhook/instagram', async (req, res) => {
  await instagramAgent.handleWebhookEvent(req, res);
});

// Vapi — événements d'appel
app.post('/webhook/vapi', async (req, res) => {
  await voiceAgent.handleVapiWebhook(req, res);
});

// ============================================================
// ── API REST ──
// ============================================================

// ── Routes de réservation (booking) ──
app.use('/api', bookingRoutes);

// Statut global
app.get('/api/status', (req, res) => {
  const systemStats = getStats();
  res.json({
    status: 'running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    stats: getDashboardStats(),
    systemStats,
    agents: {
      whatsapp: false, // géré séparément
      instagram: !!process.env.META_ACCESS_TOKEN,
      telegram: !!process.env.TELEGRAM_BOT_TOKEN,
      email: !!(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD),
      vapi: !!process.env.VAPI_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      scheduler: true,
    },
  });
});

// Dashboard stats
app.get('/api/dashboard', (req, res) => {
  const stats = getDashboardStats();
  const recentLeads = Array.from(leadsDB.values())
    .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
    .slice(0, 10)
    .map(l => ({
      name: l.firstName, channel: l.channel, status: l.status, score: l.score,
    }));
  res.json({ stats, recentLeads });
});

// Tous les leads
app.get('/api/leads', (req, res) => {
  const leads = Array.from(leadsDB.values())
    .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt))
    .map(l => ({
      id: l.id,
      contactId: l.contactId,
      firstName: l.firstName,
      channel: l.channel,
      status: l.status,
      score: l.score,
      messageCount: l.messageCount,
      createdAt: l.createdAt,
      lastMessageAt: l.lastMessageAt,
      needsHuman: l.needsHuman,
    }));
  res.json({ total: leads.length, leads });
});

// Conversation complète d'un lead
app.get('/api/leads/:contactId', (req, res) => {
  const lead = leadsDB.get(decodeURIComponent(req.params.contactId));
  if (!lead) return res.status(404).json({ error: 'Lead non trouvé' });
  res.json(lead);
});

// Historique des appels
app.get('/api/calls', async (req, res) => {
  const calls = await voiceAgent.getCallHistory(20);
  res.json({ calls });
});

// Stats rendez-vous pour le dashboard
app.get('/api/bookings-dashboard', (req, res) => {
  const stats = getBookingStats();
  const upcoming = getAllBookings({ upcoming: true })
    .slice(0, 5)
    .map(b => ({
      id: b.id,
      firstName: b.firstName,
      lastName: b.lastName,
      slotDate: b.slotDate,
      slotTime: b.slotTime,
      channel: b.channel,
      status: b.status,
    }));
  res.json({ stats, upcoming });
});

// Page de réservation
app.get('/booking', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/booking.html'));
});

// Dashboard principal → sert le fichier HTML
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// ============================================================
// ── DÉMARRAGE ──
// ============================================================
async function start() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   🤖 SALESBOT IA — Démarrage multi-canaux        ║');
  console.log('╠══════════════════════════════════════════════════╣');

  // ── Telegram ──
  let telegramInstance = null;
  if (telegramAgent && process.env.TELEGRAM_BOT_TOKEN) {
    telegramInstance = telegramAgent.startBot();
    console.log('║   ✅ Telegram Bot démarré                         ║');
  } else {
    console.log('║   ⚠️  Telegram inactif (TELEGRAM_BOT_TOKEN manquant) ║');
  }

  // ── Email ──
  if (emailAgent && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
    emailAgent.startEmailPolling();
    console.log('║   ✅ Agent Email démarré (polling IMAP)           ║');
  } else {
    console.log('║   ⚠️  Email inactif (EMAIL_USER/PASSWORD manquant) ║');
  }

  // ── Orchestrateur ──
  initAgents({
    instagram: instagramAgent,
    voice: voiceAgent,
    telegram: telegramInstance ? {
      sendMessage: telegramAgent.sendMessage,
    } : null,
    email: emailAgent ? {
      sendMessageFromOrchestrator: emailAgent.sendMessageFromOrchestrator,
    } : null,
  });

  // ── Scheduler de relances ──
  startScheduler();
  console.log('║   ✅ Scheduleur de relances actif                  ║');

  // ── Serveur HTTP ──
  app.listen(PORT, () => {
    console.log(`║   ✅ Serveur HTTP: http://localhost:${PORT}           ║`);
    console.log('╠══════════════════════════════════════════════════╣');
    console.log('║                                                  ║');
    console.log(`║   📊 Dashboard:  http://localhost:${PORT}/            ║`);
    console.log(`║   📋 API Leads:  http://localhost:${PORT}/api/leads   ║`);
    console.log(`║   📅 Réservation: http://localhost:${PORT}/booking    ║`);
    console.log('║                                                  ║');
    console.log('║   📱 WhatsApp QR: npm run whatsapp (autre terminal) ║');
    console.log('║   🌐 Webhooks:   npx ngrok http 3000             ║');
    console.log('║                                                  ║');
    console.log('╚══════════════════════════════════════════════════╝\n');
  });
}

process.on('uncaughtException', err => console.error('❌ Exception:', err.message));
process.on('unhandledRejection', reason => console.error('❌ Rejection:', reason));

start();
