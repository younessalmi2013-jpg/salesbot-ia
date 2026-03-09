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
  console.log('рџ“± SCANNE CE QR CODE AVEC WHATSAPP:');
  console.log('========================================');
  qrcode.generate(qr, { small: true });
  console.log('\nOuvre WhatsApp sur ton telephone:');
  console.log('Parametres > Appareils lies > Lier un appareil');
  console.log('========================================\n');
});

// Connexion reussie
client.on('authenticated', () => {
  console.log('вњ… WhatsApp: Authentifie avec succes!');
});

// Pret a recevoir des messages
client.on(')ready', () => {
  console.log('вњ… WhatsApp: Agent prГЄt et connectГ©!');
  console.log(`рџ“± Connecte au numero: ${client.info?.pushname || 'WhatsApp Business'}`);
});

// Connexion perdue
client.on('disconnected', (reason) => {
  console.log('вќЊ WhatsApp deconnecte:', reason);
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
        await msg.reply("J'ai recu ton message vocal ! Peux-tu m'envoyer ton message en texte pour que je puisse mieux t'aider ? рџ™Џ");
        return;
      }
      return;
    }

    const contactId = msg.from; // Format: +33612345678@c.us
    const text = msg.body.trim();

    if (!text) return;

    console.log(`\nрџ“Ё WhatsApp de ${contactId}: "${text.substring(0, 60)}"`);

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
    console.error('вќЊ Erreur traitement message WhatsApp:', error.message);
    // En cas d'erreur, envoie un message generique
    try {
      await msg.reply("DesolГ©, j'ai eu un petit probleme technique. Peux-tu repeter ? рџЉ");
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
    // Pas critique si ca echo ue
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
    console.log(`ш§!HY\ЬШYЩHЪ]Р\[ќ›ЮYHH	ШЫЫќXЭYX
NВ€HШ]Ъ
\њ›ЬЉHВ€ЫЫњЫЫK™\њ›ЬЉ8§c\њ™]\€[ќ›ЪHЪ]Р\H	ШЫЫќXЭYN\њ›Ь‹›Y\ЬШYЩJNВ€›ЭИ\њ›ЬЋВ€BџB‚‹КЉ‚€
€[ќ›ЪYH[€YYXH
[XYЩKЉHH[€ЫЫќXЭ€
‹В\Ю[Иќ[Э[Ы€Щ[™YYXJЫЫќXЭYYYXT]Ш\[Ы€H	ЙКHВ€ћHВ€ЫЫњЭИY\ЬШYЩSYYXHHH™\]Z\™J	ЭЪ]Ш\]ЩX‹љњЙКNВ€ЫЫњЭYYXHHY\ЬШYЩSYYXK™њ›ЫQљ[T]
YYXT]
NВ€]ШZ]ЫY[ќњЩ[™Y\ЬШYЩJЫЫќXЭYYYXKИШ\[Ы€JNВ€ЫЫњЫЫK›ЩК	8§!HYYXHЪ]Р\[ќ›ЮYHH	ШЫЫќXЭYX
NВ€HШ]Ъ
\њ›ЬЉHВ€ЫЫњЫЫK™\њ›ЬЉ8§c\њ™]\€[ќ›ЪHYYXHЪ]Р\\њ›Ь‹›Y\ЬШYЩJNВ€›ЭИ\њ›ЬЋВ€BџB‚‹ЛИKKKHSPT”ђQСHKKKBЫЫњЫЫK›ЩК	ь'ж [X\њYЩHH	ШYЩ[ќЪ]Р\‹‹‰КNВЫЫњЫЫK›ЩК	ь'дЁH[€T€ЫЩHH\\Z]™HO€ШШ[›™K[H]™XИЫ€Ъ]Р\‰КNВЫY[ќљ[љ]X[^™J
NВ‚‹ЛИ^ЬќЭ\€][\Ш][Ы€\€	ЫЬЪ\Э]]\‚›[Щ[K™^ЬќИHИЫY[ќЩ[™Y\ЬШYЩKЩ[™YYXHNВ