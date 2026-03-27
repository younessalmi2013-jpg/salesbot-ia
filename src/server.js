require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const db = require('./db');
const { auth, role, createToken, hashPassword, checkPassword } = require('./middleware/auth');
const waManager = require('./agents/whatsapp/manager');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.users.findOne(u => u.username === username.trim());
  if (!user || !user.active || !checkPassword(password, user.password))
    return res.status(401).json({ error: 'Identifiants incorrects' });
  const token = createToken(user);
  res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 3600 * 1000, sameSite: 'strict' });
  res.json({ success: true, role: user.role, username: user.username });
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/auth/me', auth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, role: req.user.role, email: req.user.email });
});

// ============================================================
// USER MANAGEMENT (superadmin only)
// ============================================================
app.get('/api/users', auth, role('superadmin'), (req, res) => {
  const users = db.users.findAll().map(u => {
    const agents = db.agents.countWhere(a => a.userId === u.id);
    const leads = db.leads.countWhere(l => l.userId === u.id);
    return { ...u, password: undefined, agentsCount: agents, leadsCount: leads };
  });
  res.json(users);
});

app.post('/api/users', auth, role('superadmin'), (req, res) => {
  const { username, password, email, role: userRole } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username et password requis' });
  if (db.users.findOne(u => u.username === username))
    return res.status(400).json({ error: 'Username deja utilise' });
  const user = db.users.insert({
    username: username.trim(),
    password: hashPassword(password),
    email: email || '',
    role: userRole || 'client',
    active: true,
  });
  res.json({ ...user, password: undefined });
});

app.put('/api/users/:id', auth, role('superadmin'), (req, res) => {
  const { password, email, role: userRole, active, username } = req.body;
  const updates = {};
  if (username !== undefined) updates.username = username;
  if (email !== undefined) updates.email = email;
  if (userRole !== undefined) updates.role = userRole;
  if (active !== undefined) updates.active = active;
  if (password) updates.password = hashPassword(password);
  const user = db.users.update(req.params.id, updates);
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouve' });
  res.json({ ...user, password: undefined });
});

app.delete('/api/users/:id', auth, role('superadmin'), (req, res) => {
  if (req.params.id === 'superadmin') return res.status(400).json({ error: 'Impossible de supprimer le super admin' });
  // Cleanup user data
  db.agents.findWhere(a => a.userId === req.params.id).forEach(a => {
    waManager.deleteAgent(a.id).catch(() => {});
  });
  db.configs.deleteWhere(c => c.userId === req.params.id);
  db.users.delete(req.params.id);
  res.json({ success: true });
});

// Reset user password
app.post('/api/users/:id/reset-password', auth, role('superadmin'), (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Nouveau mot de passe requis' });
  const user = db.users.update(req.params.id, { password: hashPassword(password) });
  if (!user) return res.status(404).json({ error: 'Utilisateur non trouve' });
  res.json({ success: true });
});

// ============================================================
// WHATSAPP AGENTS
// ============================================================
app.get('/api/agents', auth, (req, res) => {
  const userId = req.user.role === 'superadmin' && req.query.userId
    ? req.query.userId : req.user.id;
  const agents = db.agents.findWhere(a => a.userId === userId).map(a => ({
    ...a,
    liveStatus: waManager.getStatus(a.id),
    livePhone: waManager.getPhone(a.id) || a.phone,
    hasQR: !!waManager.getQR(a.id),
  }));
  res.json(agents);
});

app.post('/api/agents', auth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom de l agent requis' });
  const count = db.agents.countWhere(a => a.userId === req.user.id);
  if (count >= 10) return res.status(400).json({ error: 'Maximum 10 agents par compte' });
  waManager.createAgent(req.user.id, name.trim())
    .then(agent => res.json(agent))
    .catch(err => res.status(500).json({ error: err.message }));
});

app.get('/api/agents/:id/qr', auth, (req, res) => {
  const agent = db.agents.findById(req.params.id);
  if (!agent || (agent.userId !== req.user.id && req.user.role !== 'superadmin'))
    return res.status(404).json({ error: 'Agent non trouve' });
  res.json({
    qr: waManager.getQR(req.params.id),
    status: waManager.getStatus(req.params.id),
    phone: waManager.getPhone(req.params.id),
  });
});

app.post('/api/agents/:id/restart', auth, async (req, res) => {
  const agent = db.agents.findById(req.params.id);
  if (!agent || (agent.userId !== req.user.id && req.user.role !== 'superadmin'))
    return res.status(404).json({ error: 'Agent non trouve' });
  try {
    await waManager.restartAgent(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:id/send', auth, async (req, res) => {
  const agent = db.agents.findById(req.params.id);
  if (!agent || (agent.userId !== req.user.id && req.user.role !== 'superadmin'))
    return res.status(404).json({ error: 'Agent non trouve' });
  try {
    await waManager.sendMessage(req.params.id, req.body.phone, req.body.message);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/agents/:id', auth, async (req, res) => {
  const agent = db.agents.findById(req.params.id);
  if (!agent || (agent.userId !== req.user.id && req.user.role !== 'superadmin'))
    return res.status(404).json({ error: 'Agent non trouve' });
  await waManager.deleteAgent(req.params.id).catch(() => {});
  res.json({ success: true });
});

// ============================================================
// DASHBOARD DATA
// ============================================================
app.get('/api/dashboard', auth, (req, res) => {
  const uid = req.user.id;
  const leads = db.leads.findWhere(l => l.userId === uid);
  const today = new Date().toDateString();
  res.json({
    total: leads.length,
    new: leads.filter(l => l.status === 'new').length,
    qualified: leads.filter(l => l.status === 'qualified').length,
    booked: leads.filter(l => l.status === 'booked').length,
    clients: leads.filter(l => l.status === 'client').length,
    today: leads.filter(l => new Date(l.createdAt).toDateString() === today).length,
    recentLeads: leads
      .sort((a, b) => new Date(b.lastContact || b.createdAt) - new Date(a.lastContact || a.createdAt))
      .slice(0, 10),
  });
});

app.get('/api/leads', auth, (req, res) => {
  const leads = db.leads
    .findWhere(l => l.userId === req.user.id)
    .sort((a, b) => new Date(b.lastContact || b.createdAt) - new Date(a.lastContact || a.createdAt));
  res.json(leads);
});

app.put('/api/leads/:id/status', auth, (req, res) => {
  const lead = db.leads.findById(req.params.id);
  if (!lead || lead.userId !== req.user.id) return res.status(404).json({ error: 'Lead non trouve' });
  res.json(db.leads.update(req.params.id, { status: req.body.status }));
});

app.put('/api/leads/:id', auth, (req, res) => {
  const lead = db.leads.findById(req.params.id);
  if (!lead || lead.userId !== req.user.id) return res.status(404).json({ error: 'Lead non trouve' });
  const { name, status, score, notes } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (status !== undefined) updates.status = status;
  if (score !== undefined) updates.score = score;
  if (notes !== undefined) updates.notes = notes;
  res.json(db.leads.update(req.params.id, updates));
});

app.delete('/api/leads/:id', auth, (req, res) => {
  const lead = db.leads.findById(req.params.id);
  if (!lead || lead.userId !== req.user.id) return res.status(404).json({ error: 'Lead non trouve' });
  db.leads.delete(req.params.id);
  res.json({ success: true });
});

app.get('/api/leads/:id/messages', auth, (req, res) => {
  const lead = db.leads.findById(req.params.id);
  if (!lead || lead.userId !== req.user.id) return res.status(404).json({ error: 'Lead non trouve' });
  res.json(lead.messages || []);
});

// ============================================================
// BOOKINGS
// ============================================================
app.get('/api/bookings', auth, (req, res) => {
  const bookings = db.bookings
    .findWhere(b => b.userId === req.user.id)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(bookings);
});

app.post('/api/bookings', auth, (req, res) => {
  const booking = db.bookings.insert({ ...req.body, userId: req.user.id });
  res.json(booking);
});

app.put('/api/bookings/:id', auth, (req, res) => {
  const b = db.bookings.findById(req.params.id);
  if (!b || b.userId !== req.user.id) return res.status(404).json({ error: 'RDV non trouve' });
  res.json(db.bookings.update(req.params.id, req.body));
});

app.delete('/api/bookings/:id', auth, (req, res) => {
  const b = db.bookings.findById(req.params.id);
  if (!b || b.userId !== req.user.id) return res.status(404).json({ error: 'RDV non trouve' });
  db.bookings.delete(req.params.id);
  res.json({ success: true });
});

// ============================================================
// CONFIG
// ============================================================
app.get('/api/config', auth, (req, res) => {
  res.json(db.configs.findOne(c => c.userId === req.user.id) || {});
});

app.put('/api/config', auth, (req, res) => {
  const existing = db.configs.findOne(c => c.userId === req.user.id);
  const data = { ...req.body, userId: req.user.id };
  const result = existing
    ? db.configs.update(existing.id, data)
    : db.configs.insert(data);
  res.json(result);
});

// ============================================================
// INTEGRATIONS & STATUS
// ============================================================
app.get('/api/integrations', auth, (req, res) => {
  const agents = db.agents.findWhere(a => a.userId === req.user.id).map(a => ({
    ...a,
    liveStatus: waManager.getStatus(a.id),
    hasQR: !!waManager.getQR(a.id),
  }));
  res.json({
    whatsapp: { agents },
    telegram: { configured: !!process.env.TELEGRAM_BOT_TOKEN },
    instagram: {
      configured: !!process.env.META_ACCESS_TOKEN,
      webhookUrl: `${process.env.APP_URL || ''}/webhook/instagram`,
    },
    email: { connected: !!process.env.EMAIL_USER, email: process.env.EMAIL_USER || '' },
  });
});

app.get('/api/status', auth, (req, res) => {
  const uid = req.user.id;
  const agents = db.agents.findWhere(a => a.userId === uid);
  const config = db.configs.findOne(c => c.userId === uid) || {};
  res.json({
    agents: agents.length,
    connectedAgents: agents.filter(a => waManager.getStatus(a.id) === 'connected').length,
    leadsTotal: db.leads.countWhere(l => l.userId === uid),
    openaiConfigured: !!process.env.OPENAI_API_KEY,
    botName: config.botName || 'SalesBot',
    uptime: Math.floor(process.uptime()),
    version: '3.0.0',
    role: req.user.role,
    ...(req.user.role === 'superadmin' ? {
      totalUsers: db.users.count(),
      totalLeads: db.leads.count(),
      totalAgents: db.agents.count(),
    } : {}),
  });
});

// ============================================================
// WHATSAPP WEBHOOK (incoming messages from Meta Cloud API)
// ============================================================
app.get('/webhook/whatsapp', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN)
    return res.send(req.query['hub.challenge']);
  res.status(403).send('Forbidden');
});

// ============================================================
// PAGES
// ============================================================
app.get('/', (req, res) => res.redirect('/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));

// ============================================================
// START
// ============================================================
const server = app.listen(PORT, async () => {
  console.log(`\x1b[35m\n╔══════════════════════════════════╗`);
  console.log(`║  🤖 SalesBot IA v3.0 — Port ${PORT}  ║`);
  console.log(`╚══════════════════════════════════╝\x1b[0m`);
  console.log(`\x1b[36m📂 Data: ${require('path').join(__dirname, '../data')}\x1b[0m`);
  console.log(`\x1b[36m🔑 OpenAI: ${process.env.OPENAI_API_KEY ? '✅' : '❌ Non configure'}\x1b[0m`);

  // Init saved WA agents after a short delay
  setTimeout(() => {
    waManager.initAllAgents().catch(e => console.error('WA init error:', e.message));
  }, 3000);
});

module.exports = app;
