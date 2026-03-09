// ============================================================
// FICHIER: src/booking/manager.js
// ROLE: Gestionnaire central des rendez-vous
//       Génère les créneaux dispo, gère les réservations,
//       envoie les confirmations, synchro Google Calendar (optionnel)
// ============================================================

require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

// ── BASE DE DONNÉES EN MÉMOIRE ──
const bookingsDB = new Map();   // id → booking
const blockedSlots = new Set(); // "YYYY-MM-DD_HH:MM" → bloqué

// ── CONFIGURATION DES CRÉNEAUX ──
// Modifie ces valeurs pour adapter tes disponibilités
const BOOKING_CONFIG = {
  // Jours disponibles (0=Dim, 1=Lun, ..., 6=Sam)
  availableDays: [1, 2, 3, 4, 5], // Lun → Ven
  // Heure de début (format 24h)
  startHour: parseInt(process.env.BOOKING_START_HOUR) || 9,
  // Heure de fin
  endHour: parseInt(process.env.BOOKING_END_HOUR) || 18,
  // Durée d'un créneau en minutes
  slotDuration: parseInt(process.env.BOOKING_SLOT_MINUTES) || 30,
  // Nombre de jours à afficher en avance
  daysAhead: parseInt(process.env.BOOKING_DAYS_AHEAD) || 14,
  // Délai minimum avant RDV (en heures)
  minNoticeHours: parseInt(process.env.BOOKING_MIN_NOTICE_HOURS) || 2,
  // Nombre max de RDV par jour
  maxPerDay: parseInt(process.env.BOOKING_MAX_PER_DAY) || 8,
};

/**
 * Génère tous les créneaux disponibles pour les N prochains jours
 */
function getAvailableSlots(daysAhead = BOOKING_CONFIG.daysAhead) {
  const slots = [];
  const now = new Date();
  const minTime = new Date(now.getTime() + BOOKING_CONFIG.minNoticeHours * 3600000);

  for (let d = 0; d < daysAhead; d++) {
    const date = new Date(now);
    date.setDate(now.getDate() + d);
    date.setHours(0, 0, 0, 0);

    // Skip les jours non disponibles
    if (!BOOKING_CONFIG.availableDays.includes(date.getDay())) continue;

    const dateStr = formatDate(date); // YYYY-MM-DD
    const bookedThisDay = countBookingsForDate(dateStr);

    // Skip si la journée est complète
    if (bookedThisDay >= BOOKING_CONFIG.maxPerDay) continue;

    // Génère les créneaux pour cette journée
    for (let h = BOOKING_CONFIG.startHour; h < BOOKING_CONFIG.endHour; h++) {
      for (let m = 0; m < 60; m += BOOKING_CONFIG.slotDuration) {
        const slotTime = new Date(date);
        slotTime.setHours(h, m, 0, 0);

        // Skip les créneaux passés ou trop proches
        if (slotTime <= minTime) continue;

        const slotKey = `${dateStr}_${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;

        // Skip si bloqué ou déjà réservé
        if (blockedSlots.has(slotKey)) continue;
        if (isSlotBooked(slotKey)) continue;

        slots.push({
          id: slotKey,
          date: dateStr,
          time: `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`,
          datetime: slotTime.toISOString(),
          label: formatSlotLabel(slotTime),
          available: true,
        });
      }
    }
  }

  return slots;
}

/**
 * Crée une réservation
 */
async function createBooking(bookingData) {
  const {
    slotId,       // "2024-03-15_14:00"
    firstName,
    lastName,
    email,
    phone,
    message,
    leadId,       // lien avec le lead CRM
    channel,      // canal d'origine (whatsapp, instagram, etc.)
  } = bookingData;

  // Vérification que le créneau est encore dispo
  if (isSlotBooked(slotId)) {
    throw new Error('Ce créneau est déjà réservé');
  }

  if (blockedSlots.has(slotId)) {
    throw new Error('Ce créneau n\'est pas disponible');
  }

  // Parse de la date/heure
  const [datePart, timePart] = slotId.split('_');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const appointmentDate = new Date(year, month - 1, day, hour, minute);

  const booking = {
    id: uuidv4(),
    slotId,
    firstName,
    lastName,
    email,
    phone: phone || '',
    message: message || '',
    leadId: leadId || null,
    channel: channel || 'direct',
    date: datePart,
    time: timePart,
    datetime: appointmentDate.toISOString(),
    status: 'confirmed',  // confirmed | cancelled | completed | no_show
    createdAt: new Date().toISOString(),
    reminderSent: false,
    notes: '',
  };

  bookingsDB.set(booking.id, booking);

  console.log(`✅ RDV créé: ${firstName} ${lastName} → ${datePart} à ${timePart}`);

  // Envoie les confirmations email
  await sendConfirmationEmails(booking);

  return booking;
}

/**
 * Annule un rendez-vous
 */
function cancelBooking(bookingId, reason = '') {
  const booking = bookingsDB.get(bookingId);
  if (!booking) throw new Error('Réservation non trouvée');

  bookingsDB.set(bookingId, {
    ...booking,
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    cancelReason: reason,
  });

  console.log(`❌ RDV annulé: ${booking.firstName} → ${booking.date} ${booking.time}`);
  return bookingsDB.get(bookingId);
}

/**
 * Met à jour le statut d'un RDV (completed, no_show, etc.)
 */
function updateBookingStatus(bookingId, status, notes = '') {
  const booking = bookingsDB.get(bookingId);
  if (!booking) throw new Error('Réservation non trouvée');
  bookingsDB.set(bookingId, { ...booking, status, notes, updatedAt: new Date().toISOString() });
  return bookingsDB.get(bookingId);
}

/**
 * Récupère tous les RDV (avec filtres optionnels)
 */
function getAllBookings({ status, date, upcoming } = {}) {
  let bookings = Array.from(bookingsDB.values());

  if (status) bookings = bookings.filter(b => b.status === status);
  if (date) bookings = bookings.filter(b => b.date === date);
  if (upcoming) bookings = bookings.filter(b => new Date(b.datetime) > new Date());

  return bookings.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
}

/**
 * Stats des RDV pour le dashboard
 */
function getBookingStats() {
  const all = Array.from(bookingsDB.values());
  const now = new Date();
  const todayStr = formatDate(now);

  return {
    total: all.length,
    confirmed: all.filter(b => b.status === 'confirmed').length,
    completed: all.filter(b => b.status === 'completed').length,
    cancelled: all.filter(b => b.status === 'cancelled').length,
    noShow: all.filter(b => b.status === 'no_show').length,
    today: all.filter(b => b.date === todayStr && b.status === 'confirmed').length,
    upcoming: all.filter(b => b.status === 'confirmed' && new Date(b.datetime) > now).length,
    byChannel: all.reduce((acc, b) => {
      acc[b.channel] = (acc[b.channel] || 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * Génère l'URL de réservation personnalisée pour un lead
 */
function generateBookingUrl(leadContactId, firstName = '') {
  const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 3000}`;
  const params = new URLSearchParams({
    lead: leadContactId,
    name: firstName,
    source: 'ai-agent',
  });
  return `${baseUrl}/booking?${params.toString()}`;
}

/**
 * Envoie les emails de confirmation (client + toi)
 */
async function sendConfirmationEmails(booking) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
    console.log('ℹ️  Email non configuré — confirmation non envoyée');
    return;
  }

  const transporter = nodemailer.createTransporter({
    host: process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
  });

  const dateFormatted = new Date(booking.datetime).toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeFormatted = booking.time;
  const botName = process.env.BOT_NAME || 'Notre équipe';
  const product = process.env.PRODUCT_NAME || '';

  // ── Email au CLIENT ──
  const clientHtml = `
    <!DOCTYPE html><html><head><meta charset="utf-8">
    <style>
      body{font-family:Arial,sans-serif;background:#f8fafc;margin:0;padding:20px}
      .card{background:white;max-width:560px;margin:0 auto;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)}
      .header{background:linear-gradient(135deg,#1e3a5f,#2563eb);padding:32px;text-align:center;color:white}
      .header h1{margin:0;font-size:22px}
      .header p{margin:8px 0 0;opacity:0.8;font-size:14px}
      .body{padding:32px}
      .detail{display:flex;gap:12px;align-items:center;padding:14px 0;border-bottom:1px solid #f1f5f9}
      .detail:last-child{border-bottom:none}
      .icon{width:36px;height:36px;background:#eff6ff;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
      .label{font-size:12px;color:#64748b;font-weight:500}
      .value{font-size:15px;color:#1e293b;font-weight:600;margin-top:2px}
      .footer{background:#f8fafc;padding:20px;text-align:center;font-size:12px;color:#94a3b8}
      .badge{display:inline-block;background:#dcfce7;color:#16a34a;padding:6px 16px;border-radius:20px;font-size:13px;font-weight:600;margin-bottom:20px}
    </style></head><body>
    <div class="card">
      <div class="header">
        <h1>✅ Rendez-vous confirmé !</h1>
        <p>${product}</p>
      </div>
      <div class="body">
        <div style="text-align:center;margin-bottom:24px">
          <span class="badge">🎉 Réservation confirmée</span>
          <p style="color:#64748b;font-size:14px">Bonjour <strong>${booking.firstName}</strong>, voici les détails de votre rendez-vous :</p>
        </div>
        <div class="detail">
          <div class="icon">📅</div>
          <div><div class="label">Date</div><div class="value">${dateFormatted}</div></div>
        </div>
        <div class="detail">
          <div class="icon">⏰</div>
          <div><div class="label">Heure</div><div class="value">${timeFormatted}</div></div>
        </div>
        <div class="detail">
          <div class="icon">👤</div>
          <div><div class="label">Nom</div><div class="value">${booking.firstName} ${booking.lastName}</div></div>
        </div>
        ${booking.message ? `
        <div class="detail">
          <div class="icon">💬</div>
          <div><div class="label">Votre message</div><div class="value">${booking.message}</div></div>
        </div>` : ''}
        <p style="text-align:center;color:#64748b;font-size:13px;margin-top:24px">
          Nous vous contacterons à l'heure prévue. En cas d'empêchement, répondez à cet email pour modifier votre RDV.
        </p>
      </div>
      <div class="footer">${botName} — ${product} | Référence: ${booking.id.substring(0,8)}</div>
    </div></body></html>
  `;

  // ── Email à TOI (notification) ──
  const adminHtml = `
    <h2>📅 Nouveau RDV réservé !</h2>
    <p><strong>Nom:</strong> ${booking.firstName} ${booking.lastName}</p>
    <p><strong>Email:</strong> ${booking.email}</p>
    <p><strong>Téléphone:</strong> ${booking.phone || 'Non renseigné'}</p>
    <p><strong>Date:</strong> ${dateFormatted} à ${timeFormatted}</p>
    <p><strong>Canal d'origine:</strong> ${booking.channel}</p>
    <p><strong>Message:</strong> ${booking.message || 'Aucun'}</p>
    <p><strong>ID réservation:</strong> ${booking.id}</p>
  `;

  try {
    // Email au client
    if (booking.email) {
      await transporter.sendMail({
        from: { name: botName, address: process.env.EMAIL_USER },
        to: `${booking.firstName} ${booking.lastName} <${booking.email}>`,
        subject: `✅ RDV confirmé — ${dateFormatted} à ${timeFormatted}`,
        html: clientHtml,
      });
    }

    // Notification à toi
    await transporter.sendMail({
      from: { name: 'SalesBot IA', address: process.env.EMAIL_USER },
      to: process.env.EMAIL_USER,
      subject: `🗓️ Nouveau RDV: ${booking.firstName} ${booking.lastName} — ${booking.date} ${booking.time}`,
      html: adminHtml,
    });

    console.log(`📧 Emails de confirmation envoyés pour ${booking.firstName}`);
  } catch (err) {
    console.error('Erreur email confirmation:', err.message);
  }
}

// ── HELPERS ──

function isSlotBooked(slotId) {
  for (const b of bookingsDB.values()) {
    if (b.slotId === slotId && b.status !== 'cancelled') return true;
  }
  return false;
}

function countBookingsForDate(dateStr) {
  return Array.from(bookingsDB.values())
    .filter(b => b.date === dateStr && b.status !== 'cancelled').length;
}

function formatDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function formatSlotLabel(date) {
  return date.toLocaleString('fr-FR', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

module.exports = {
  BOOKING_CONFIG,
  getAvailableSlots,
  createBooking,
  cancelBooking,
  updateBookingStatus,
  getAllBookings,
  getBookingStats,
  generateBookingUrl,
  bookingsDB,
};
