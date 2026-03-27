const express = require('express');
const jwt = require('jsonwebtoken');
const { SECRET, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// ─── User store (env-based for Railway, no DB needed) ────────────────────────
function getUsers() {
  try { return JSON.parse(process.env.USERS_CONFIG || '[]'); } catch { return []; }
}

// Helper: strip surrounding quotes that Railway sometimes adds to env vars
function stripQuotes(str) {
  return (str || '').replace(/^["']|["']$/g, '');
}

// ─── Login ────────────────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });

  const adminUser = {
    username: stripQuotes(process.env.ADMIN_USERNAME) || 'admin',
    password: stripQuotes(process.env.ADMIN_PASSWORD) || 'salesbot2024',
    role: 'admin',
    name: 'Admin'
  };

  const allUsers = [adminUser, ...getUsers()];
  const user = allUsers.find(u => u.username === username && u.password === password);

  if (!user) return res.status(401).json({ error: 'Identifiants incorrects / بيانات غير صحيحة' });

  const token = jwt.sign(
    { username: user.username, role: user.role, name: user.name || user.username },
    SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 3600 * 1000
  });

  res.json({ success: true, role: user.role, name: user.name });
});

// ─── Logout ───────────────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// ─── Current user ─────────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = (req.cookies && req.cookies.token) || '';
  if (!token) return res.status(401).json({ error: 'Non connecté' });
  try {
    const user = jwt.verify(token, SECRET);
    res.json({ username: user.username, role: user.role, name: user.name });
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
});

// ─── Admin: list clients ──────────────────────────────────────────────────────
router.get('/clients', requireAdmin, (req, res) => {
  const users = getUsers();
  res.json(users.map(u => ({ username: u.username, name: u.name, role: u.role })));
});

// ─── Admin: create client ─────────────────────────────────────────────────────
// NOTE: Updating process.env only works per-restart; for persistence,
//       update USERS_CONFIG env var in Railway dashboard.
router.post('/clients', requireAdmin, (req, res) => {
  const { username, password, name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username + password requis' });
  const users = getUsers();
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Utilisateur existe déjà' });
  users.push({ username, password, name: name || username, role: 'client' });
  process.env.USERS_CONFIG = JSON.stringify(users);
  // Return the new USERS_CONFIG so admin can save it in Railway
  res.json({ success: true, usersConfig: process.env.USERS_CONFIG });
});

// ─── Admin: delete client ─────────────────────────────────────────────────────
router.delete('/clients/:username', requireAdmin, (req, res) => {
  const users = getUsers().filter(u => u.username !== req.params.username);
  process.env.USERS_CONFIG = JSON.stringify(users);
  res.json({ success: true, usersConfig: process.env.USERS_CONFIG });
});

module.exports = router;
