// WhatsApp API routes
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const sessions = new Map();

function setupWhatsAppRoutes(app) {

  app.get('/api/whatsapp/qr/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('data: ' + JSON.stringify({ status: 'initializing', message: 'Initialisation du client WhatsApp...' }) + '\n\n');
    if (sessions.has(sessionId)) {
      const existing = sessions.get(sessionId);
      if (existing.qr) { res.write('data: ' + JSON.stringify({ status: 'qr', qr: existing.qr }) + '\n\n'); }
      if (existing.ready) { res.write('data: ' + JSON.stringify({ status: 'ready', phone: existing.phone || 'connected' }) + '\n\n'); }
      existing.listeners.push(res);
      req.on('close', () => { existing.listeners = existing.listeners.filter(l => l !== res); });
      return;
    }
    try {
      const client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--single-process','--disable-gpu'] }
      });
      const session = { client, qr: null, ready: false, phone: null, listeners: [res] };
      sessions.set(sessionId, session);
      client.on('qr', async (qr) => {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 2 });
          session.qr = qrDataUrl;
          const data = JSON.stringify({ status: 'qr', qr: qrDataUrl });
          session.listeners.forEach(l => { try { l.write('data: ' + data + '\n\n'); } catch(e) {} });
        } catch(e) { console.error('QR error:', e); }
      });
      client.on('ready', () => {
        session.ready = true;
        session.phone = client.info ? client.info.wid.user : 'connected';
        const data = JSON.stringify({ status: 'ready', phone: session.phone });
        session.listeners.forEach(l => { try { l.write('data: ' + data + '\n\n'); } catch(e) {} });
      });
      client.on('authenticated', () => {
        const data = JSON.stringify({ status: 'authenticated', message: 'Authentifie!' });
        session.listeners.forEach(l => { try { l.write('data: ' + data + '\n\n'); } catch(e) {} });
      });
      client.on('auth_failure', (msg) => {
        const data = JSON.stringify({ status: 'error', message: 'Echec auth: ' + msg });
        session.listeners.forEach(l => { try { l.write('data: ' + data + '\n\n'); } catch(e) {} });
        sessions.delete(sessionId);
      });
      client.on('disconnected', (reason) => {
        const data = JSON.stringify({ status: 'disconnected', message: reason });
        session.listeners.forEach(l => { try { l.write('data: ' + data + '\n\n'); } catch(e) {} });
        sessions.delete(sessionId);
      });
      client.initialize().catch(err => {
        console.error('WhatsApp init error:', err);
        const data = JSON.stringify({ status: 'error', message: 'Erreur init: ' + err.message });
        session.listeners.forEach(l => { try { l.write('data: ' + data + '\n\n'); } catch(e) {} });
        sessions.delete(sessionId);
      });
    } catch(err) {
      console.error('WhatsApp setup error:', err);
      res.write('data: ' + JSON.stringify({ status: 'error', message: 'Erreur: ' + err.message }) + '\n\n');
      res.end();
    }
    req.on('close', () => {
      if (sessions.has(sessionId)) { sessions.get(sessionId).listeners = sessions.get(sessionId).listeners.filter(l => l !== res); }
    });
  });

  app.get('/api/whatsapp/sessions', (req, res) => {
    const result = [];
    sessions.forEach((s, id) => { result.push({ id, ready: s.ready, phone: s.phone, hasQr: !!s.qr }); });
    res.json(result);
  });

  app.post('/api/whatsapp/disconnect/:sessionId', (req, res) => {
    const sid = req.params.sessionId;
    if (sessions.has(sid)) {
      try { sessions.get(sid).client.destroy(); } catch(e) {}
      sessions.delete(sid);
      res.json({ success: true, message: 'Session deconnectee' });
    } else { res.json({ success: false, message: 'Session non trouvee' }); }
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', sessions: sessions.size, uptime: process.uptime() });
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'admin123') {
      try {
        const { createToken } = require('../middleware/auth');
        const token = createToken({ id: 1, username: 'admin', role: 'superadmin' });
        res.json({ success: true, token, user: { name: 'Admin', role: 'superadmin' } });
      } catch(e) {
        const jwt = require('jsonwebtoken');
        const secret = process.env.JWT_SECRET || 'salesbot-secret-key';
        const token = jwt.sign({ id: 1, username: 'admin', role: 'superadmin' }, secret, { expiresIn: '24h' });
        res.json({ success: true, token, user: { name: 'Admin', role: 'superadmin' } });
      }
    } else { res.status(401).json({ success: false, message: 'Identifiants invalides' }); }
  });
}

module.exports = { setupWhatsAppRoutes };
