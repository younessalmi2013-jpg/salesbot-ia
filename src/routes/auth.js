const express = require('express');
const jwt = require('jsonwebtoken');
const { SECRET, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// âââ User store (env-based for Railway, no DB needed) ââââââââââââââââââââââââ
function getUsers() {
  try { return JSON.parse(process.env.USERS_CONFIG || '[]'); } catch { return []; }
}

// âââ Login ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });

  const adminUser = {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'salesbot2024',
    role: 'admin',
    name: 'Admin'
  };

  const allUsers = [adminUser, ...getUsers()];
  const user = allUsers.find(u => u.username === username && u.password === password);

  if (!user) return res.status(401).json({ error: 'Identifiants incorrects / Ø¨ÙØ§ÙØ§Øª ØºÙØ± ØµØ­ÙØ­Ø©' });

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

// âââ Logout âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// âââ Current user âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
router.get('/me', (req, res) => {
  const token = (req.cookies && req.cookies.token) || '';
  if (!token) return res.status(401).json({ error: 'Non connectÃ©' });
  try {
    const user = jwt.verify(token, SECRET);
    res.json({ username: user.username, role: user.role, name: user.name });
  } catch {
    res.status(401).json({ error: 'Session expirÃ©e' });
  }
});

// âââ Admin: list clients ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
router.get('/clients', requireAdmin, (req, res) => {
  const users = getUsers();
  res.json(users.map(u => ({ username: u.username, name: u.name, role: u.role })));
});

// âââ Admin: create client âââââââââââââââââââââââââââââââââââââââââââââââââââââ
// NOTE: Updating process.env only works per-restart; for persistence,
//       update USERS_CONFIG env var in Railway dashboard.
router.post('/clients', requireAdmin, (req, res) => {
  const { username, password, name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username + password requis' });
  const users = getUsers();
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Utilisateur existe dÃ©jÃ ' });
  users.push({ username, password, name: name || username, role: 'client' });
  process.env.USERS_CONFIG = JSON.stringify(users);
  // Return the new USERS_CONFIG so admin can save it in Railway
  res.json({ success: true, usersConfig: process.env.USERS_CONFIG });
});

// âââ Admin: delete client âââââââââââââââââââââââââââââââââââââââââââââââââââââ
router.delete('/clients/:username', requireAdmin, (req, res) => {
  const users = getUsers().filter(u => u.username !== req.params.username);
  process.env.USERS_CONFIG = JSON.stringify(users);
  res.json({ success: true, usersConfig: process.env.USERS_CONFIG });
});

module.exports = router;
