const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'sb_jwt_salesbot_2024';

function requireAuth(req, res, next) {
  const token = (req.cookies && req.cookies.token) ||
    (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) {
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: 'Non autorisé / غير مصرح' });
  }
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    if (req.accepts('html')) return res.redirect('/login');
    res.status(401).json({ error: 'Session expirée / انتهت الجلسة' });
  }
}

function requireAdmin(req, res, next) {
  const token = (req.cookies && req.cookies.token) ||
    (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    req.user = jwt.verify(token, SECRET);
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès admin requis' });
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée' });
  }
}

module.exports = { requireAuth, requireAdmin, SECRET };
