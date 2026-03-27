const jwt = require('jsonwebtoken');
const db = require('../db');

const SECRET = process.env.JWT_SECRET || 'salesbot_jwt_secret_2024_v3';

function hashPassword(password) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const crypto = require('crypto');
  const [salt, hash] = stored.split(':');
  return crypto.createHmac('sha256', salt).update(password).digest('hex') === hash;
}

function createToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    SECRET,
    { expiresIn: '7d' }
  );
}

function auth(req, res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifie' });
  try {
    const decoded = jwH.verify(token, SECRET);
    const user = db.users.findById(decoded.id);
    if (!user || !user.active) return res.status(401).json({ error: 'Utilisateur inactif ou introuvable' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

function role(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifie' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Access refuse' });
    next();
  };
}

module.exports = { auth, role, createToken, hashPassword, checkPassword };
