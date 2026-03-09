// ============================================================
// FICHIER: src/booking/routes.js
// ROLE: Routes Express pour l'API de réservation
// ============================================================

const express = require('express');
const router = express.Router();
const {
  getAvailableSlots,
  createBooking,
  cancelBooking,
  updateBookingStatus,
  getAllBookings,
  getBookingStats,
} = require('./manager');

// ── GET /api/slots → liste des créneaux disponibles ──
router.get('/slots', (req, res) => {
  try {
    const { days } = req.query;
    const slots = getAvailableSlots(days ? parseInt(days) : undefined);
    res.json({ total: slots.length, slots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/book → créer une réservation ──
router.post('/book', async (req, res) => {
  try {
    const { slotId, firstName, lastName, email, phone, message, leadId, channel } = req.body;

    if (!slotId || !firstName || !email) {
      return res.status(400).json({
        error: 'Champs obligatoires manquants',
        required: ['slotId', 'firstName', 'email'],
      });
    }

    const booking = await createBooking({
      slotId, firstName, lastName: lastName || '',
      email, phone, message, leadId, channel: channel || 'direct',
    });

    res.json({ success: true, booking });
  } catch (err) {
    if (err.message.includes('déjà réservé') || err.message.includes('pas disponible')) {
      res.status(409).json({ error: err.message });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── GET /api/bookings → tous les RDV ──
router.get('/bookings', (req, res) => {
  try {
    const { status, date, upcoming } = req.query;
    const bookings = getAllBookings({
      status,
      date,
      upcoming: upcoming === 'true',
    });
    res.json({ total: bookings.length, bookings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/bookings/stats → statistiques ──
router.get('/bookings/stats', (req, res) => {
  res.json(getBookingStats());
});

// ── PATCH /api/bookings/:id/cancel → annuler ──
router.patch('/bookings/:id/cancel', (req, res) => {
  try {
    const booking = cancelBooking(req.params.id, req.body.reason);
    res.json({ success: true, booking });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── PATCH /api/bookings/:id/status → changer statut ──
router.patch('/bookings/:id/status', (req, res) => {
  try {
    const { status, notes } = req.body;
    const booking = updateBookingStatus(req.params.id, status, notes);
    res.json({ success: true, booking });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
