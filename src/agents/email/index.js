// ============================================================
// FICHIER: src/agents/email/index.js
// ROLE: Agent Email - reçoit les emails (IMAP) et répond (SMTP/Gmail)
//
// SETUP GMAIL (recommandé):
//   1. Active "Accès IMAP" dans Gmail: Paramètres → Voir tous → Transfert et POP/IMAP
//   2. Crée un mot de passe d'application: myaccount.google.com → Sécurité → Mots de passe d'application
//   3. Utilise ce mot de passe (pas ton vrai mdp) dans .env
//
// SETUP AUTRE EMAIL:
//   - Utilise les paramètres IMAP/SMTP de ton fournisseur
// ============================================================

require('dotenv').config();
const nodemailer = require('nodemailer');
const Imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const { processMessage } = require('../../orchestrator/index');

// ---- CONFIGURATION SMTP (pour ENVOYER) ----
let smtpTransporter = null;

function createSmtpTransporter() {
  const config = {
    host: process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_SMTP_PORT) || 587,
    secure: false, // TLS
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD, // Mot de passe d'application Gmail
    },
  };

  return nodemailer.createTransporter(config);
}

// ---- CONFIGURATION IMAP (pour RECEVOIR) ----
function getImapConfig() {
  return {
    imap: {
      user: process.env.EMAIL_USER,
      password: process.env.EMAIL_PASSWORD,
      host: process.env.EMAIL_IMAP_HOST || 'imap.gmail.com',
      port: parseInt(process.env.EMAIL_IMAP_PORT) || 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    },
  };
}

// Garde en mémoire les emails déjà traités (évite de répondre 2x)
const processedEmailIds = new Set();
let isPolling = false;

/**
 * Démarre la surveillance des emails entrants
 * Vérifie la boîte de réception toutes les X minutes
 */
function startEmailPolling() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log('⚠️  Agent Email non configuré (EMAIL_USER ou EMAIL_PASSWORD manquant)');
    return;
  }

  // Initialise le transporteur SMTP
  smtpTransporter = createSmtpTransporter();

  // Vérifie la boîte de réception toutes les 2 minutes
  const intervalMinutes = parseInt(process.env.EMAIL_CHECK_INTERVAL_MIN) || 2;
  console.log(`✅ Agent Email démarré (vérification toutes les ${intervalMinutes} min)`);

  // Premier check immédiat
  checkInbox().catch(err => console.log('Email check:', err.message));

  // Puis périodiquement
  setInterval(() => {
    checkInbox().catch(err => console.log('Email check:', err.message));
  }, intervalMinutes * 60 * 1000);
}

/**
 * Vérifie la boîte de réception pour les nouveaux emails
 */
async function checkInbox() {
  if (isPolling) return; // Évite les requêtes parallèles
  isPolling = true;

  let connection = null;

  try {
    connection = await Imap.connect(getImapConfig());
    await connection.openBox('INBOX');

    // Cherche les emails non lus des dernières 24h
    const since = new Date();
    since.setDate(since.getDate() - 1);

    const searchCriteria = ['UNSEEN', ['SINCE', since]];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT', ''],
      markSeen: false, // Ne marque pas comme lu tout de suite
    };

    const messages = await connection.search(searchCriteria, fetchOptions);

    for (const message of messages) {
      const emailId = message.attributes.uid;

      // Skip si déjà traité
      if (processedEmailIds.has(emailId)) continue;

      try {
        // Parse l'email complet
        const all = message.parts.find(p => p.which === '');
        const parsed = await simpleParser(all.body);

        const from = parsed.from?.value?.[0];
        const senderEmail = from?.address || '';
        const senderName = from?.name || '';
        const subject = parsed.subject || '(sans objet)';
        const textContent = parsed.text || parsed.html?.replace(/<[^>]*>/g, '') || '';

        // Ignore les emails de noreply, newsletters, etc.
        if (isSpamOrNewsletter(senderEmail, subject, textContent)) {
          processedEmailIds.add(emailId);
          continue;
        }

        console.log(`\n📧 Email reçu de ${senderEmail}: "${subject.substring(0, 50)}"`);

        // Construit le message pour l'orchestrateur
        const messageText = `[Objet: ${subject}]\n\n${textContent.substring(0, 1000)}`;

        // Envoie à l'orchestrateur
        const aiResponse = await processMessage({
          channel: 'email',
          contactId: `email_${senderEmail}`,
          text: messageText,
          firstName: senderName.split(' ')[0] || null,
          lastName: senderName.split(' ').slice(1).join(' ') || null,
          email: senderEmail,
          emailSubject: subject,
        });

        // Envoie la réponse par email
        await sendEmail({
          to: senderEmail,
          toName: senderName,
          subject: `Re: ${subject}`,
          text: aiResponse,
        });

        // Marque comme traité
        processedEmailIds.add(emailId);

        // Marque comme lu
        await connection.addFlags(emailId, ['\\Seen']);

      } catch (msgError) {
        console.error(`Erreur traitement email ${emailId}:`, msgError.message);
      }
    }

    if (messages.length > 0) {
      console.log(`✅ ${messages.length} email(s) traité(s)`);
    }

  } catch (error) {
    if (error.message.includes('AUTHENTICATIONFAILED')) {
      console.error('❌ Email: Authentification échouée - vérifie EMAIL_USER et EMAIL_PASSWORD');
    } else if (error.message.includes('ENOTFOUND')) {
      console.error('❌ Email: Impossible de se connecter au serveur IMAP');
    } else {
      console.error('❌ Email check erreur:', error.message);
    }
  } finally {
    if (connection) {
      try { connection.end(); } catch (e) {}
    }
    isPolling = false;
  }
}

/**
 * Envoie un email de réponse
 */
async function sendEmail({ to, toName, subject, text, html }) {
  if (!smtpTransporter) {
    console.log('⚠️  SMTP non configuré');
    return;
  }

  // Crée une version HTML soignée du message
  const htmlBody = html || textToHtml(text, toName);

  const mailOptions = {
    from: {
      name: process.env.BOT_NAME || 'Sophie',
      address: process.env.EMAIL_USER,
    },
    to: toName ? `${toName} <${to}>` : to,
    subject: subject,
    text: text,
    html: htmlBody,
  };

  await smtpTransporter.sendMail(mailOptions);
  console.log(`✅ Email envoyé à ${to}`);
}

/**
 * Convertit un texte en HTML email propre
 */
function textToHtml(text, firstName) {
  const botName = process.env.BOT_NAME || 'Sophie';
  const product = process.env.PRODUCT_NAME || '';
  const paragraphs = text.split('\n').filter(l => l.trim()).map(l => `<p>${l}</p>`).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; }
        .header { background: #1e3a5f; padding: 20px; text-align: center; }
        .header h2 { color: white; margin: 0; font-size: 18px; }
        .content { padding: 30px 20px; }
        p { line-height: 1.6; margin: 0 0 12px; }
        .footer { background: #f8fafc; padding: 15px 20px; font-size: 12px; color: #94a3b8; border-top: 1px solid #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="header"><h2>${botName} - ${product}</h2></div>
      <div class="content">${paragraphs}</div>
      <div class="footer">
        Ce message a été envoyé par ${botName}. Pour vous désabonner, répondez "STOP".
      </div>
    </body>
    </html>
  `;
}

/**
 * Détecte si l'email est un spam ou une newsletter (à ignorer)
 */
function isSpamOrNewsletter(from, subject, body) {
  const spamIndicators = [
    'noreply', 'no-reply', 'newsletter', 'unsubscribe', 'marketing',
    'notification', 'donotreply', 'automated', 'mailer-daemon',
  ];

  const fromLower = from.toLowerCase();
  const subjectLower = subject.toLowerCase();

  return spamIndicators.some(indicator =>
    fromLower.includes(indicator) || subjectLower.includes(indicator)
  );
}

/**
 * Envoie un email depuis l'orchestrateur (relances)
 */
async function sendMessageFromOrchestrator(contactId, message) {
  const email = contactId.replace('email_', '');
  await sendEmail({
    to: email,
    subject: `Message de ${process.env.BOT_NAME || 'notre équipe'}`,
    text: message,
  });
}

module.exports = { startEmailPolling, sendEmail, sendMessageFromOrchestrator };
