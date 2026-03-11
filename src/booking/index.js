// src/booking/index.js — re-export depuis manager.js
const manager = require('./manager');

// Alias getBookings → getAllBookings pour la compatibilité server.js
manager.getBookings = manager.getAllBookings;

module.exports = manager;
