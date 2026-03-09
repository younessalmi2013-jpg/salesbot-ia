// ============================================================
// FICHIER: src/agents/whatsapp/index.js
// ROLE: Agent WhatsApp - connexion via QR Code
//       Lance ce fichier avec: node src/agents/whatsapp/index.js
//       Un QR code s'affiche dans le terminal -> scanne-le avec WhatsApp
// ============================================================

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { processMessage } = require('../../orchestrator/index');

// ---- CONFIGURATION DU CLIENT WHATSAPP ----
const client = new Client({
  // LocalAuth sauvegarde la session pour ne pas rescanner le QR a chaque redemarrage
  authStrategy: new LocalAuth({
    clientId: 'sales-agent',
    dataPath: './.whatsapp-session',
  }),
  puppeteer: {
    headless: true,  // Pas d'interface graphique (tourne en arriere-plan)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

// ---- EVENEMENTS DU CLIENT ----

// Affichage du QR Code dans le terminal
client.on('qr', (qr) => {
  console.log('\n========================================');
  console.log('📱 SCANNE CE QR CODE AVEC WHATSAPP:');
  console.log('========================================');
  qrcode.generate(qr, { small: true });
  console.log('\nOuvre WhatsApp sur ton telephone:');
  console.log('Parametres > Appareils lies > Lier un appareil');
  console.log('========================================\n');
});

// Connexion reussie
client.on('authenticated', () => {
  console.log('✅ WhatsApp: Authentifie avec succes!');
});

// Pret a recevoir des messages
client.on('ready', () => {
  console.log('✅ WhatsApp: Agent pret et connecte!');
  console.log(`📱 Connecte au numero: ${client.info?.pushname || 'WhatsApp Business'}`);
});

// Connexion perdue
client.on('disconnected', (reason) => {
  console.log('❌ WhatsApp deconnecte:', reason);
  console.log('Tentative de reconnexion dans 10 secondes...');
  setTimeout(() => client.initialize(), 10000);
});

// ---- RECEPTION ET TRAITEMENT DES MESSAGES ----
client.on('message', async (msg) => {
  try {
    // Ignore les messages de groupe (on ne repond qu'en prive)
    if (msg.isGroupMsg) return;

    // Ignore les messages envoyes par TOI (evite les boucles infinies)
    if (msg.fromMe) return;

    // Ignore les messages systeme, notifications, etc.
    if (msg.type !== 'chat') {
      // On peut quand meme traiter les messages audio si on veut
      if (msg.type === 'audio' || msg.type === 'ptt') {
        // Message vocal - on envoie un message generique
        await msg.reply("J'ai recu ton message vocal ! Peux-tu m'envoyer ton message en texte pour que je puisse mieux t'aider ? 🙏");
        return;
      }
      return;
    }

    const contactId = msg.from; // Format: +33612345678@c.us
    const text = msg.body.trim();

    if (!text) return;

    console.log(`\n📨 WhatsApp de ${contactId}: "${text.substring(0, 60)}"`);

    // Essaie de recuperer le prenom depuis WhatsApp
    let firstName = null;
    try {
      const contact = await msg.getContact();
      firstName = contact.pushname || contact.shortName || null;
    } catch (e) {
      // On continue sans le prenom
    }

    // Envoie le message a l'orchestrateur pour traitement
    const response = await processMessage({
      channel: 'whatsapp',
      contactId: contactId,
      text: text,
      firstName: firstName,
      phone: contactId.replace('@c.us', ''),
    });

    // Simule un delai naturel (comme si une vraie personne ecrivait)
    const typingDelay = Math.min(text.length * 30 + 1000, 5000); // Max 5 secondes
    await simulateTyping(msg.from, typingDelay);

    // Envoie la reponse
    await msg.reply(response);

  } catch (error) {
    console.error('❌ Erreur traitement message WhatsApp:', error.message);
    // En cas d'erreur, envoie un message generique
    try {
      await msg.reply("Desolé, j'ai eu un petit probleme technique. Peux-tu repeter ? 😊");
    } catch (e) {}
  }
});

/**
 * Simule que quelqu'un est en train d'ecrire (indicateur "en train d'ecrire...")
 */
async function simulateTyping(chatId, duration) {
  try {
    const chat = await client.getChatById(chatId);
    await chat.sendStateTyping();
    await new Promise(resolve => setTimeout(resolve, duration));
    await chat.clearState();
  } catch (e) {
    // Pas critique si ca echoue
    await new Promise(resolve => setTimeout(resolve, duration));
  }
}

/**
 * Envoie un message a un contact WhatsApp
 * (utilise par l'orchestrateur pour les relances)
 */
async function sendMessage(contactId, message) {
  try {
    await client.sendMessage(contactId, message);
    console.log(`✅ Message WhatsApp envoye a ${contactId}`);
  } catch (error) {
    console.error(`❌ Erreur envoi WhatsApp a ${contactId}:`, error.message);
    throw error;
  }
}

/**
 * Envoie un media (image, PDF) a un contact
 */
async function sendMedia(contactId, mediaPath, caption = '') {
  try {
    const { MessageMedia } = require('whatsapp-web.js');
    const media = MessageMedia.fromFilePath(mediaPath);
    await client.sendMessage(contactId, media, { caption });
    console.log(`✅ Media WhatsApp envoye a ${contactId}`);
  } catch (error) {
    console.error(`❌ Erreur envoi media WhatsApp:`, error.message);
    throw error;
  }
}

// ---- DEMARRAGE ----
console.log('🚀 Demarrage de l\'agent WhatsApp...');
console.log('💡 Un QR code va apparaitre -> scanne-le avec ton WhatsApp\n');
client.initialize();

// Export pour utilisation par l'orchestrateur
module.exports = { client, sendMessage, sendMedia };
