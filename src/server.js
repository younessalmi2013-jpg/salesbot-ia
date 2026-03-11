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
