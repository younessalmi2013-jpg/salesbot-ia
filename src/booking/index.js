const manager = require('./manager');

const bookingAgent = {
  getBookings: manager.getAllBookings,
  createBooking: manager.createBooking,
  getAvailableSlots: manager.getAvailableSlots,
  updateBookingStatus: manager.updateBookingStatus,
  getBookingById: manager.getBookingById,
  deleteBooking: manager.deleteBooking,
};

module.exports = bookingAgent;
