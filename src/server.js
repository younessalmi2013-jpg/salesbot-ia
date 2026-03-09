// ============================================================
// FICHIER: src/server.js
// ROLE: Serveur principal â€” 4 canaux: WhatsApp, Instagram, Telegram, Email
// ============================================================

require('dotenv').config();
const express = require('express');
const path = require('path');
const { initAgents, getStats } = require('./orchestrator/index');
const { startScheduler } = require('./sequences/scheduler');
const { getDashboardStats, leadsDB } = require('./agents/crm/index');
const bookingRoutes = require('./booking/routes');
const { getBookingStats, getAllBookings } = require('./booking/manager');

// ---- Agents ----
const instagramAgent = require('./agents/instagram/index');
const voiceAgent = require('./agents/voice/index');

// Telegram (optional â€” nÃ©cessite TELEGRAM_BOV_TOKEN)
let telegramAgent = null;
try {
  telegramAgent = require('./agents/telegram/index');
} catch (e) {
  console.log('â„¹ï¸  Module Telegram non disponible');
}

// Email (optionnal â€” {Ã©cessite EMAIL_USER + EMAIL_PASSWORD)
let emailAgent = null;
try {
  emailAgent = require('./agents/email/index');
} catch (e) {
  console.log('ø¡.{î#È[Ù[H[XZ[›Ûˆ\ÜÛšX›IÊNÂŸB‚˜ÛÛœİ\H^™\ÜÊ
NÂ˜ÛÛœİÔ•H›ØÙ\ÜË™[‹”Ô•ÌÂ‚‹ËÈKKKHRQUĞT‘TÈKKKB˜\\ÙJ^™\ÜËšœÛÛŠ
JNÂ˜\\ÙJ^™\ÜË\›[˜ÛÙY
È^[™YˆYHJJNÂ˜\\ÙJ^™\ÜËœİ]XÊ]š›Ú[Š×Ù\›˜[YK	Ë‹‹ÜX›XÉÊJJNÂ‚‹ËÈÙÈ\È™\]pê\È[˜[\Â˜\‹Üİ
	Î‹
™\K™\Ë™^
HOˆÂˆÛÛœİ\›H™\K›ÜšYÚ[˜[\›™\K\›ÂˆÛÛœÛÛK›ÙÊÉÛ™]È]J
KÒTÓÔİš[™Ê
KœÛXÙJNJ_WH<'å$ÈY]ÙH	İ\›X
NÂˆ™^

NÂŸJNÂ‚‹ËÈKKKH“ÕUTÈKKKB˜\‹04IĞ›ÛÚ[™Ô›İ]\ßJNÂ˜\™Ù]
	ËØ\KÙ\Ú›Ø\™	Ë\Ş[˜È
™\K™\ÊHOˆÂˆHÂˆÛÛœİİ]ÈH]ØZ]Ù]\Ú›Ø\™İ]Ê
NÂˆ™\ËšœÛÛŠÈİXØÙ\ÜÎˆYK]Nˆİ]ÈJNÂˆHØ]Ú
\œ›ÜŠHÂˆ™\ËšœÛÛŠÈİXØÙ\ÜÎˆ˜[ÙK\œ›Üˆ\œ›Ü‹›Y\ÜØYÙHJNÂˆBŸJNÂ‚˜\™Ù]
	ËØ\KØ›ÛÚÚ[™ÜÉË\Ş[˜È
™\K™\ÊHOˆÂˆHÂˆÛÛœİ›ÛÚÚ[™ÜÈH]ØZ]Ù][›ÛÚÚ[™ÜÊ
NÂˆ™\ËšœÛÛŠÈİXØÙ\ÜÎˆYK]Nˆ›ÛÚÚ[™ÜÈJNÂˆHØ]Ú
\œ›ÜŠHÂˆ™\ËšœÛÛŠÈİXØÙ\ÜÎˆ˜[ÙK\œ›Üˆ\œ›Ü‹›Y\ÜØYÙHJNÂˆBŸJNÂ‚‹ËÈKKKHS’UPSTĞUSÓˆKKKB˜\›\İ[ŠÔ•\Ş[˜È

HOˆÂˆÛÛœÛÛK›ÙÊ¼'å$H[ÙH[ˆ	Ü›ØÙ\ÜË™[‹““ÑWÑS•ŸX
NÂˆÛÛœÛÛK›ÙÊ<'æ ÛØÛH0êHØØ[Üİ‰ÔÔ•H
NÂˆÛÛœÛÛK›ÙÊ	ø§!H\Ú›Ø\™ˆ‹ËÛØØ[Üİ‰È
ÈÔ•
NÂˆÛÛœÛÛK›ÙÊ	ğªÈ8§!ˆTH‘Õˆ‹ËÛØØ[Üİ‰È
ÈÔ•
È	ËØ\t"H	ÊNÂ‚ˆ]ØZ][š]YÙ[Ê
NÂˆ]ØZ]İ\ØÚY[\Š
NÂŸJNÂ