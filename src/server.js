require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const app = express();

app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// Dependencies
const db = require('./db');
const { auth, role, createToken, hashPassword, checkPassword } = require('./middleware/auth');
const waManager = require('./agents/whatsapp/manager');

let bookingMgr;
try {
  bookingMgr = require('./booking/manager');
} catch(e) {
  bookingMgr = null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Parse CSV string manually, handle quoted fields
function parseCSV(csvString) {
  const lines = csvString.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const fields = [];
    let currentField = '';
    let insideQuotes = false;

    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === ',' && !insideQuotes) {
        fields.push(currentField.trim().replace(/^"|"$/g, ''));
        currentField = '';
      } else {
        currentField += char;
      }
    }
    fields.push(currentField.trim().replace(/^"|"$/g, ''));

    const row = {};
    headers.forEach((header, idx) => {
      row[header] = fields[idx] || '';
    });
    rows.push(row);
  }

  return rows;
}

// Convert rows to CSV string
function convertToCSV(leads) {
  const headers = ['name', 'phone', 'email', 'status', 'score', 'channel', 'messageCount', 'createdAt'];
  const csvLines = [headers.join(',')];

  leads.forEach(lead => {
    const row = [
      `"${lead.name}"`,
      `"${lead.phone}"`,
      `"${lead.email}"`,
      lead.status,
      lead.score,
      lead.channel,
      lead.messages ? lead.messages.length : 0,
      new Date(lead.createdAt).toISOString().split('T')[0]
    ];
    csvLines.push(row.join(','));
  });

  return csvLines.join('\n');
}

// Get available booking slots (Mon-Fri, 9h-18h, 30-min slots)
function generateAvailableSlots(userId) {
  const slots = [];
  const now = new Date();

  for (let i = 1; i <= 14; i++) {
    const date = new Date(now);
    date.setDate(now.getDate() + i);
    const dayOfWeek = date.getDay();

    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    for (let hour = 9; hour < 18; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const slotTime = new Date(date);
        slotTime.setHours(hour, minute, 0, 0);

        // Check if already booked
        const existingBooking = db.bookings?.find(b =>
          b.userId === userId &&
          new Date(b.date).toISOString().split('T')[0] === date.toISOString().split('T')[0] &&
          b.time === `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
        );

        if (!existingBooking) {
          slots.push({
            date: date.toISOString().split('T')[0],
            time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
            available: true
          });
        }
      }
    }
  }

  return slots;
}

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Admin login
    if (username === 'admin' && process.env.SUPERADMIN_PASSWORD === password) {
      const token = createToken({ username: 'admin', role: 'superadmin', id: 'admin' });
      res.cookie('token', token, {
        httpOnly: true,
        maxAge: 7 * 24 * 3600 * 1000,
        sameSite: 'lax'
      });
      return res.json({ success: true, role: 'superadmin', username: 'admin' });
    }

    // Regular user login
    const user = db.users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const validPassword = await checkPassword(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = createToken({ username: user.username, role: user.role, id: user.id });
    res.cookie('token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 3600 * 1000,
      sameSite: 'lax'
    });

    return res.json({ success: true, role: user.role, username: user.username });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/auth/me', auth, (req, res) => {
  res.json({
    username: req.user.username,
    role: req.user.role,
    id: req.user.id,
    email: req.user.email || null
  });
});

// ============================================================================
// USERS ROUTES
// ============================================================================

app.get('/api/users', auth, role('superadmin'), (req, res) => {
  const users = db.users.map(user => ({
    ...user,
    agentCount: (db.agents || []).filter(a => a.userId === user.id).length,
    leadCount: (db.leads || []).filter(l => l.userId === user.id).length
  }));
  res.json(users);
});

app.post('/api/users', auth, role('superadmin'), async (req, res) => {
  try {
    const { username, password, role: userRole, email } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    if (db.users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await hashPassword(password);
    const newUser = {
      id: `user_${Date.now()}`,
      username,
      password: hashedPassword,
      role: userRole || 'user',
      email: email || '',
      createdAt: new Date()
    };

    db.users.push(newUser);
    db.saveData();

    res.json({ success: true, user: { ...newUser, password: undefined } });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/users/:id', auth, role('superadmin'), async (req, res) => {
  try {
    const { username, email, role: userRole } = req.body;
    const user = db.users.find(u => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (username) user.username = username;
    if (email) user.email = email;
    if (userRole) user.role = userRole;

    db.saveData();
    res.json({ success: true, user: { ...user, password: undefined } });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/users/:id', auth, role('superadmin'), (req, res) => {
  try {
    const userIdx = db.users.findIndex(u => u.id === req.params.id);
    if (userIdx === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = req.params.id;

    // Delete user's agents (and their clients)
    db.agents = (db.agents || []).filter(a => {
      if (a.userId === userId) {
        if (waManager && waManager.clients && waManager.clients[a.id]) {
          waManager.clients[a.id].destroy();
          delete waManager.clients[a.id];
        }
      }
      return a.userId !== userId;
    });

    // Delete user's leads
    db.leads = (db.leads || []).filter(l => l.userId !== userId);

    // Delete user's configs
    db.configs = (db.configs || []).filter(c => c.userId !== userId);

    // Delete user's bookings
    db.bookings = (db.bookings || []).filter(b => b.userId !== userId);

    // Delete user
    db.users.splice(userIdx, 1);
    db.saveData();

    res.json({ success: true });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.post('/api/users/:id/reset-password', auth, role('superadmin'), async (req, res) => {
  try {
    const { newPassword } = req.body;
    const user = db.users.find(u => u.id === req.params.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!newPassword) {
      return res.status(400).json({ error: 'New password required' });
    }

    user.password = await hashPassword(newPassword);
    db.saveData();

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ============================================================================
// AGENTS ROUTES
// ============================================================================

app.get('/api/agents', auth, (req, res) => {
  try {
    const agents = (db.agents || [])
      .filter(a => a.userId === req.user.id)
      .map(agent => {
        const status = waManager?.getStatus?.(agent.id) || 'disconnected';
        const qr = waManager?.getQR?.(agent.id) || null;
        const phone = waManager?.getPhone?.(agent.id) || null;

        return {
          ...agent,
          status,
          qr,
          phone
        };
      });

    res.json(agents);
  } catch (err) {
    console.error('Get agents error:', err);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

app.post('/api/agents', auth, (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Agent name required' });
    }

    const newAgent = {
      id: `agent_${Date.now()}`,
      userId: req.user.id,
      name,
      createdAt: new Date(),
      config: {}
    };

    db.agents.push(newAgent);

    // Initialize WhatsApp client
    if (waManager && waManager.initClient) {
      waManager.initClient(newAgent.id);
    }

    db.saveData();
    res.json({ success: true, agent: newAgent });
  } catch (err) {
    console.error('Create agent error:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

app.get('/api/agents/:id/qr', auth, (req, res) => {
  try {
    const agent = db.agents.find(a => a.id === req.params.id && a.userId === req.user.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const qr = waManager?.getQR?.(req.params.id) || null;
    const status = waManager?.getStatus?.(req.params.id) || 'disconnected';
    const phone = waManager?.getPhone?.(req.params.id) || null;

    res.json({ qr, status, phone });
  } catch (err) {
    console.error('Get QR error:', err);
    res.status(500).json({ error: 'Failed to get QR code' });
  }
});

app.post('/api/agents/:id/restart', auth, (req, res) => {
  try {
    const agent = db.agents.find(a => a.id === req.params.id && a.userId === req.user.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (waManager && waManager.restartClient) {
      waManager.restartClient(req.params.id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Restart agent error:', err);
    res.status(500).json({ error: 'Failed to restart agent' });
  }
});

app.post('/api/agents/:id/send', auth, (req, res) => {
  try {
    const { to, message } = req.body;
    const agent = db.agents.find(a => a.id === req.params.id && a.userId === req.user.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (!to || !message) {
      return res.status(400).json({ error: 'Recipient and message required' });
    }

    if (waManager && waManager.sendMessage) {
      waManager.sendMessage(req.params.id, to, message);
    }

    res.json({ success: true, message: 'Message sent' });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.delete('/api/agents/:id', auth, (req, res) => {
  try {
    const agentIdx = db.agents.findIndex(a => a.id === req.params.id && a.userId === req.user.id);

    if (agentIdx === -1) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const agentId = req.params.id;

    // Destroy WhatsApp client
    if (waManager && waManager.clients && waManager.clients[agentId]) {
      waManager.clients[agentId].destroy();
      delete waManager.clients[agentId];
    }

    db.agents.splice(agentIdx, 1);
    db.saveData();

    res.json({ success: true });
  } catch (err) {
    console.error('Delete agent error:', err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// ============================================================================
// LEADS ROUTES (CSV export BEFORE regular GET to avoid route conflict)
// ============================================================================

app.get('/api/leads/export', auth, (req, res) => {
  try {
    const leads = (db.leads || []).filter(l => l.userId === req.user.id);
    const csv = convertToCSV(leads);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Export leads error:', err);
    res.status(500).json({ error: 'Failed to export leads' });
  }
});

app.get('/api/leads', auth, (req, res) => {
  try {
    let leads = (db.leads || []).filter(l => l.userId === req.user.id);

    // Filter by search
    if (req.query.search) {
      const search = req.query.search.toLowerCase();
      leads = leads.filter(l =>
        l.name.toLowerCase().includes(search) ||
        l.phone.toLowerCase().includes(search) ||
        l.email.toLowerCase().includes(search)
      );
    }

    // Filter by status
    if (req.query.status) {
      leads = leads.filter(l => l.status === req.query.status);
    }

    // Filter by channel
    if (req.query.channel) {
      leads = leads.filter(l => l.channel === req.query.channel);
    }

    // Sort by lastContact descending
    leads.sort((a, b) => {
      const dateA = new Date(a.lastContact || a.createdAt || 0);
      const dateB = new Date(b.lastContact || b.createdAt || 0);
      return dateB - dateA;
    });

    res.json(leads);
  } catch (err) {
    console.error('Get leads error:', err);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

app.post('/api/leads', auth, (req, res) => {
  try {
    const { name, phone, email, status, score, channel, notes } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone required' });
    }

    const newLead = {
      id: `lead_${Date.now()}`,
      userId: req.user.id,
      name,
      phone,
      email: email || '',
      status: status || 'new',
      score: score || 0,
      channel: channel || 'whatsapp',
      notes: notes || '',
      messages: [],
      createdAt: new Date(),
      lastContact: new Date()
    };

    db.leads.push(newLead);
    db.saveData();

    res.json({ success: true, lead: newLead });
  } catch (err) {
    console.error('Create lead error:', err);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

app.put('/api/leads/:id', auth, (req, res) => {
  try {
    const lead = db.leads.find(l => l.id === req.params.id && l.userId === req.user.id);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const { name, phone, email, status, score, channel, notes } = req.body;

    if (name) lead.name = name;
    if (phone) lead.phone = phone;
    if (email) lead.email = email;
    if (status) lead.status = status;
    if (score !== undefined) lead.score = score;
    if (channel) lead.channel = channel;
    if (notes !== undefined) lead.notes = notes;

    db.saveData();
    res.json({ success: true, lead });
  } catch (err) {
    console.error('Update lead error:', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

app.put('/api/leads/:id/status', auth, (req, res) => {
  try {
    const { status } = req.body;
    const lead = db.leads.find(l => l.id === req.params.id && l.userId === req.user.id);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    lead.status = status;
    db.saveData();

    res.json({ success: true, lead });
  } catch (err) {
    console.error('Update lead status error:', err);
    res.status(500).json({ error: 'Failed to update lead status' });
  }
});

app.delete('/api/leads/:id', auth, (req, res) => {
  try {
    const leadIdx = db.leads.findIndex(l => l.id === req.params.id && l.userId === req.user.id);

    if (leadIdx === -1) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    db.leads.splice(leadIdx, 1);
    db.saveData();

    res.json({ success: true });
  } catch (err) {
    console.error('Delete lead error:', err);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

app.get('/api/leads/:id/messages', auth, (req, res) => {
  try {
    const lead = db.leads.find(l => l.id === req.params.id && l.userId === req.user.id);

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json({ messages: lead.messages || [] });
  } catch (err) {
    console.error('Get messages error:', err);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ============================================================================
// CSV IMPORT
// ============================================================================

app.post('/api/leads/import', auth, (req, res) => {
  try {
    const { csv } = req.body;

    if (!csv) {
      return res.status(400).json({ error: 'CSV data required' });
    }

    const rows = parseCSV(csv);
    const imported = [];
    let errors = 0;

    rows.forEach(row => {
      if (row.name && row.phone) {
        const newLead = {
          id: `lead_${Date.now()}_${Math.random()}`,
          userId: req.user.id,
          name: row.name,
          phone: row.phone,
          email: row.email || '',
          status: row.status || 'new',
          score: parseInt(row.score) || 0,
          channel: row.channel || 'whatsapp',
          notes: row.notes || '',
          messages: [],
          createdAt: new Date(),
          lastContact: new Date()
        };

        db.leads.push(newLead);
        imported.push(newLead);
      } else {
        errors++;
      }
    });

    db.saveData();
    res.json({ success: true, imported: imported.length, errors, leads: imported });
  } catch (err) {
    console.error('Import leads error:', err);
    res.status(500).json({ error: 'Failed to import leads' });
  }
});

// ============================================================================
// BOOKINGS ROUTES
// ============================================================================

app.get('/api/bookings', auth, (req, res) => {
  try {
    const bookings = (db.bookings || [])
      .filter(b => b.userId === req.user.id)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(bookings);
  } catch (err) {
    console.error('Get bookings error:', err);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

app.post('/api/bookings', auth, (req, res) => {
  try {
    const { leadName, phone, email, date, time, notes, status } = req.body;

    if (!leadName || !date || !time) {
      return res.status(400).json({ error: 'Lead name, date, and time required' });
    }

    const newBooking = {
      id: `booking_${Date.now()}`,
      userId: req.user.id,
      leadName,
      phone: phone || '',
      email: email || '',
      date,
      time,
      notes: notes || '',
      status: status || 'confirmed',
      createdAt: new Date()
    };

    db.bookings.push(newBooking);
    db.saveData();

    res.json({ success: true, booking: newBooking });
  } catch (err) {
    console.error('Create booking error:', err);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.put('/api/bookings/:id', auth, (req, res) => {
  try {
    const booking = db.bookings.find(b => b.id === req.params.id && b.userId === req.user.id);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const { leadName, phone, email, date, time, notes, status } = req.body;

    if (leadName) booking.leadName = leadName;
    if (phone) booking.phone = phone;
    if (email) booking.email = email;
    if (date) booking.date = date;
    if (time) booking.time = time;
    if (notes !== undefined) booking.notes = notes;
    if (status) booking.status = status;

    db.saveData();
    res.json({ success: true, booking });
  } catch (err) {
    console.error('Update booking error:', err);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

app.delete('/api/bookings/:id', auth, (req, res) => {
  try {
    const bookingIdx = db.bookings.findIndex(b => b.id === req.params.id && b.userId === req.user.id);

    if (bookingIdx === -1) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    db.bookings.splice(bookingIdx, 1);
    db.saveData();

    res.json({ success: true });
  } catch (err) {
    console.error('Delete booking error:', err);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

// ============================================================================
// BOOKING SLOTS
// ============================================================================

app.get('/api/booking/slots', auth, (req, res) => {
  try {
    const slots = generateAvailableSlots(req.user.id);
    res.json(slots);
  } catch (err) {
    console.error('Get slots error:', err);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

app.post('/api/booking/book', auth, (req, res) => {
  try {
    const { date, time, firstName, lastName, email, phone, notes } = req.body;

    if (!date || !time || !firstName || !lastName || !phone) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    // Check if slot is available
    const existingBooking = db.bookings?.find(b =>
      b.userId === req.user.id &&
      b.date === date &&
      b.time === time
    );

    if (existingBooking) {
      return res.status(400).json({ error: 'Slot already booked' });
    }

    const newBooking = {
      id: `booking_${Date.now()}`,
      userId: req.user.id,
      leadName: `${firstName} ${lastName}`,
      phone,
      email: email || '',
      date,
      time,
      notes: notes || '',
      status: 'confirmed',
      createdAt: new Date()
    };

    db.bookings.push(newBooking);
    db.saveData();

    res.json({ success: true, booking: newBooking });
  } catch (err) {
    console.error('Book slot error:', err);
    res.status(500).json({ error: 'Failed to book slot' });
  }
});

app.get('/api/booking/stats', auth, (req, res) => {
  try {
    const bookings = (db.bookings || []).filter(b => b.userId === req.user.id);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const stats = {
      total: bookings.length,
      confirmed: bookings.filter(b => b.status === 'confirmed').length,
      completed: bookings.filter(b => b.status === 'completed').length,
      cancelled: bookings.filter(b => b.status === 'cancelled').length,
      noShow: bookings.filter(b => b.status === 'noShow').length,
      todayCount: bookings.filter(b => new Date(b.date) >= today && new Date(b.date) < new Date(today.getTime() + 86400000)).length,
      upcomingCount: bookings.filter(b => new Date(b.date) > now).length
    };

    res.json(stats);
  } catch (err) {
    console.error('Get booking stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ============================================================================
// PUBLIC BOOKING ENDPOINTS
// ============================================================================

app.get('/api/booking/slots-public/:userId', (req, res) => {
  try {
    const slots = generateAvailableSlots(req.params.userId);
    res.json(slots);
  } catch (err) {
    console.error('Get public slots error:', err);
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

app.post('/api/booking/book-public/:userId', (req, res) => {
  try {
    const { date, time, firstName, lastName, email, phone, notes } = req.body;
    const userId = req.params.userId;

    if (!date || !time || !firstName || !lastName || !phone) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    const existingBooking = db.bookings?.find(b =>
      b.userId === userId &&
      b.date === date &&
      b.time === time
    );

    if (existingBooking) {
      return res.status(400).json({ error: 'Slot already booked' });
    }

    const newBooking = {
      id: `booking_${Date.now()}`,
      userId,
      leadName: `${firstName} ${lastName}`,
      phone,
      email: email || '',
      date,
      time,
      notes: notes || '',
      status: 'confirmed',
      createdAt: new Date()
    };

    db.bookings.push(newBooking);
    db.saveData();

    res.json({ success: true, booking: newBooking });
  } catch (err) {
    console.error('Book public slot error:', err);
    res.status(500).json({ error: 'Failed to book slot' });
  }
});

// ============================================================================
// PUBLIC BOOKING PAGE
// ============================================================================

app.get('/book/:userId', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RÃ©server un crÃ©neau</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0f;
      color: #ffffff;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      margin-bottom: 40px;
      padding-top: 20px;
    }
    .header h1 {
      font-size: 32px;
      margin-bottom: 10px;
      color: #ffffff;
    }
    .card {
      background: #12121a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      border: 1px solid #1f1f2e;
    }
    .section-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #7c3aed;
    }
    input[type="date"] {
      width: 100%;
      padding: 12px;
      background: #0a0a0f;
      border: 1px solid #1f1f2e;
      border-radius: 8px;
      color: #ffffff;
      font-size: 14px;
      margin-bottom: 20px;
      cursor: pointer;
    }
    input[type="date"]::-webkit-calendar-picker-indicator {
      filter: invert(1);
    }
    .slots-container {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
      gap: 8px;
      margin-bottom: 24px;
    }
    .slot-button {
      padding: 10px;
      background: #1f1f2e;
      border: 2px solid transparent;
      border-radius: 8px;
      color: #ffffff;
      cursor: pointer;
      font-size: 13px;
      text-align: center;
      transition: all 0.2s;
    }
    .slot-button:hover {
      border-color: #7c3aed;
      background: #1f1f2e;
    }
    .slot-button.selected {
      background: #7c3aed;
      border-color: #7c3aed;
    }
    .form-group {
      margin-bottom: 16px;
    }
    label {
      display: block;
      margin-bottom: 8px;
      font-size: 14px;
      font-weight: 500;
    }
    input[type="text"],
    input[type="email"],
    input[type="tel"],
    textarea {
      width: 100%;
      padding: 10px;
      background: #0a0a0f;
      border: 1px solid #1f1f2e;
      border-radius: 8px;
      color: #ffffff;
      font-size: 14px;
      font-family: inherit;
    }
    textarea {
      resize: vertical;
      min-height: 80px;
    }
    input:focus,
    textarea:focus {
      outline: none;
      border-color: #7c3aed;
    }
    .submit-button {
      width: 100%;
      padding: 12px;
      background: #7c3aed;
      border: none;
      border-radius: 8px;
      color: #ffffff;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .submit-button:hover:not(:disabled) {
      background: #6d28d9;
    }
    .submit-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .success-message {
      display: none;
      background: #10b981;
      color: #ffffff;
      padding: 16px;
      border-radius: 8px;
      margin-top: 20px;
      text-align: center;
    }
    .error-message {
      background: #ef4444;
      color: #ffffff;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 16px;
      display: none;
    }
    .loading {
      display: none;
      text-align: center;
      padding: 20px;
      color: #7c3aed;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>RÃ©server un crÃ©neau</h1>
      <p style="color: #999; margin-top: 8px;">Choisissez votre date et heure</p>
    </div>

    <div class="card">
      <div class="error-message" id="errorMsg"></div>

      <div class="section-title">Date</div>
      <input type="date" id="dateInput">

      <div class="section-title">Heure disponible</div>
      <div class="slots-container" id="slotsContainer">
        <p style="color: #999; grid-column: 1/-1;">Choisissez une date d'abord</p>
      </div>
    </div>

    <div class="card">
      <div class="section-title">Vos informations</div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div class="form-group">
          <label for="firstName">PrÃ©nom</label>
          <input type="text" id="firstName" placeholder="Jean">
        </div>
        <div class="form-group">
          <label for="lastName">Nom</label>
          <input type="text" id="lastName" placeholder="Dupont">
        </div>
      </div>

      <div class="form-group">
        <label for="email">Email</label>
        <input type="email" id="email" placeholder="jean@example.com">
      </div>

      <div class="form-group">
        <label for="phone">TÃ©lÃ©phone</label>
        <input type="tel" id="phone" placeholder="+33612345678">
      </div>

      <div class="form-group">
        <label for="notes">Notes (optionnel)</label>
        <textarea id="notes" placeholder="Ajoutez un message..."></textarea>
      </div>

      <div class="loading" id="loading">RÃ©servation en cours...</div>
      <button class="submit-button" id="submitBtn">Confirmer la rÃ©servation</button>
      <div class="success-message" id="successMsg">RÃ©servation confirmÃ©e! Vous recevrez un email de confirmation.</div>
    </div>
  </div>

  <script>
    const userId = '${req.params.userId}';
    let selectedSlot = null;

    document.getElementById('dateInput').addEventListener('change', loadSlots);
    document.getElementById('submitBtn').addEventListener('click', submitBooking);

    async function loadSlots() {
      const date = document.getElementById('dateInput').value;
      if (!date) return;

      try {
        const res = await fetch(\`/api/booking/slots-public/\${userId}\`);
        const allSlots = await res.json();

        const daySlots = allSlots.filter(s => s.date === date);
        const container = document.getElementById('slotsContainer');

        if (daySlots.length === 0) {
          container.innerHTML = '<p style="color: #999; grid-column: 1/-1;">Aucun crÃ©neau disponible</p>';
          return;
        }

        container.innerHTML = daySlots.map(slot =>
          \`<button class="slot-button" data-time="\${slot.time}" onclick="selectSlot('\${slot.time}')">\${slot.time}</button>\`
        ).join('');
      } catch (err) {
        console.error('Error loading slots:', err);
      }
    }

    function selectSlot(time) {
      document.querySelectorAll('.slot-button').forEach(btn => btn.classList.remove('selected'));
      event.target.classList.add('selected');
      selectedSlot = time;
    }

    async function submitBooking() {
      const date = document.getElementById('dateInput').value;
      const firstName = document.getElementById('firstName').value;
      const lastName = document.getElementById('lastName').value;
      const email = document.getElementById('email').value;
      const phone = document.getElementById('phone').value;
      const notes = document.getElementById('notes').value;
      const errorMsg = document.getElementById('errorMsg');
      const successMsg = document.getElementById('successMsg');
      const loading = document.getElementById('loading');

      errorMsg.style.display = 'none';
      successMsg.style.display = 'none';

      if (!date || !selectedSlot || !firstName || !lastName || !phone) {
        errorMsg.textContent = 'Veuillez remplir tous les champs obligatoires';
        errorMsg.style.display = 'block';
        return;
      }

      loading.style.display = 'block';

      try {
        const res = await fetch(\`/api/booking/book-public/\${userId}\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date, time: selectedSlot, firstName, lastName, email, phone, notes })
        });

        const data = await res.json();
        loading.style.display = 'none';

        if (res.ok) {
          document.getElementById('dateInput').value = '';
          document.getElementById('firstName').value = '';
          document.getElementById('lastName').value = '';
          document.getElementById('email').value = '';
          document.getElementById('phone').value = '';
          document.getElementById('notes').value = '';
          selectedSlot = null;
          document.getElementById('slotsContainer').innerHTML = '<p style="color: #999; grid-column: 1/-1;">Choisissez une date d\\'abord</p>';
          successMsg.style.display = 'block';
        } else {
          errorMsg.textContent = data.error || 'Erreur lors de la rÃ©servation';
          errorMsg.style.display = 'block';
        }
      } catch (err) {
        loading.style.display = 'none';
        errorMsg.textContent = 'Erreur serveur';
        errorMsg.style.display = 'block';
        console.error('Error:', err);
      }
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ============================================================================
// BROADCAST ROUTES
// ============================================================================

app.post('/api/broadcast', auth, async (req, res) => {
  try {
    const { agentId, leadIds, message } = req.body;

    if (!agentId || !leadIds || !Array.isArray(leadIds) || !message) {
      return res.status(400).json({ error: 'agentId, leadIds (array), and message required' });
    }

    const agent = db.agents.find(a => a.id === agentId && a.userId === req.user.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const leadId of leadIds) {
      const lead = db.leads.find(l => l.id === leadId && l.userId === req.user.id);
      if (!lead) continue;

      try {
        if (waManager && waManager.sendMessage) {
          await waManager.sendMessage(agentId, lead.phone, message);
          sent++;

          if (!lead.messages) lead.messages = [];
          lead.messages.push({
            type: 'outbound',
            text: message,
            timestamp: new Date()
          });

          lead.lastContact = new Date();
        }
      } catch (err) {
        failed++;
        errors.push({ leadId, error: err.message });
      }
    }

    db.saveData();
    res.json({ sent, failed, errors });
  } catch (err) {
    console.error('Broadcast error:', err);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

app.post('/api/broadcast/all', auth, async (req, res) => {
  try {
    const { agentId, message, filter } = req.body;

    if (!agentId || !message) {
      return res.status(400).json({ error: 'agentId and message required' });
    }

    const agent = db.agents.find(a => a.id === agentId && a.userId === req.user.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    let targetLeads = db.leads.filter(l => l.userId === req.user.id);

    if (filter === 'qualified') {
      targetLeads = targetLeads.filter(l => l.status === 'qualified');
    } else if (filter === 'new') {
      targetLeads = targetLeads.filter(l => l.status === 'new');
    } else if (filter === 'client') {
      targetLeads = targetLeads.filter(l => l.status === 'client');
    }

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const lead of targetLeads) {
      try {
        if (waManager && waManager.sendMessage) {
          await waManager.sendMessage(agentId, lead.phone, message);
          sent++;

          if (!lead.messages) lead.messages = [];
          lead.messages.push({
            type: 'outbound',
            text: message,
            timestamp: new Date()
          });

          lead.lastContact = new Date();
        }
      } catch (err) {
        failed++;
        errors.push({ leadId: lead.id, error: err.message });
      }
    }

    db.saveData();
    res.json({ sent, failed, errors });
  } catch (err) {
    console.error('Broadcast all error:', err);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// ============================================================================
// ANALYTICS ROUTES
// ============================================================================

app.get('/api/analytics', auth, (req, res) => {
  try {
    const leads = db.leads.filter(l => l.userId === req.user.id);
    const bookings = (db.bookings || []).filter(b => b.userId === req.user.id);
    const agents = db.agents.filter(a => a.userId === req.user.id);

    // Funnel
    const funnel = {
      new: leads.filter(l => l.status === 'new').length,
      qualified: leads.filter(l => l.status === 'qualified').length,
      booked: leads.filter(l => l.status === 'booked').length,
      client: leads.filter(l => l.status === 'client').length,
      lost: leads.filter(l => l.status === 'lost').length
    };

    // Conversion rates
    const conversionRates = {
      newToQualified: funnel.new > 0 ? Math.round((funnel.qualified / funnel.new) * 100) : 0,
      qualifiedToBooked: funnel.qualified > 0 ? Math.round((funnel.booked / funnel.qualified) * 100) : 0,
      bookedToClient: funnel.booked > 0 ? Math.round((funnel.client / funnel.booked) * 100) : 0,
      overallClosing: leads.length > 0 ? Math.round((funnel.client / leads.length) * 100) : 0
    };

    // Leads by channel
    const ledByChannel = {};
    leads.forEach(l => {
      ledByChannel[l.channel] = (ledByChannel[l.channel] || 0) + 1;
    });

    // Leads by day (last 30 days)
    const leadsByDay = {};
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(now.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      leadsByDay[dateStr] = 0;
    }

    leads.forEach(l => {
      const dateStr = new Date(l.createdAt).toISOString().split('T')[0];
      if (leadsByDay[dateStr] !== undefined) {
        leadsByDay[dateStr]++;
      }
    });

    const leadsByDayArray = Object.entries(leadsByDay).map(([date, count]) => ({ date, count }));

    // Booking stats
    const bookingStats = {
      total: bookings.length,
      confirmed: bookings.filter(b => b.status === 'confirmed').length,
      completed: bookings.filter(b => b.status === 'completed').length,
      cancelled: bookings.filter(b => b.status === 'cancelled').length,
      noShow: bookings.filter(b => b.status === 'noShow').length
    };

    // Top agents
    const topAgents = agents.map(agent => ({
      name: agent.name,
      leadCount: leads.filter(l => l.assignedAgentId === agent.id).length,
      connectedLeads: leads.filter(l => l.assignedAgentId === agent.id && l.status !== 'new').length
    })).sort((a, b) => b.leadCount - a.leadCount);

    // Response stats
    const totalMessages = leads.reduce((sum, l) => sum + (l.messages?.length || 0), 0);
    const responseStats = {
      avgMessagesPerLead: leads.length > 0 ? (totalMessages / leads.length).toFixed(1) : 0,
      totalMessages
    };

    // Summary
    const summary = {
      totalLeads: leads.length,
      totalClients: funnel.client,
      closingRate: conversionRates.overallClosing,
      avgScore: leads.length > 0 ? Math.round(leads.reduce((sum, l) => sum + (l.score || 0), 0) / leads.length) : 0
    };

    res.json({
      funnel,
      conversionRates,
      ledByChannel,
      leadsByDay: leadsByDayArray,
      bookingStats,
      topAgents,
      responseStats,
      summary
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ============================================================================
// CONFIG ROUTES
// ============================================================================

app.get('/api/config', auth, (req, res) => {
  try {
    let config = (db.configs || []).find(c => c.userId === req.user.id);

    if (!config) {
      config = {
        userId: req.user.id,
        welcomeMessage: 'Bonjour! Comment puis-je vous aider?',
        autoQualify: false,
        followUpDelay: 24,
        timezone: 'Europe/Paris'
      };
    }

    res.json(config);
  } catch (err) {
    console.error('Get config error:', err);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

app.put('/api/config', auth, (req, res) => {
  try {
    let config = (db.configs || []).find(c => c.userId === req.user.id);

    if (!config) {
      config = { userId: req.user.id };
      db.configs.push(config);
    }

    Object.assign(config, req.body);
    db.saveData();

    res.json({ success: true, config });
  } catch (err) {
    console.error('Update config error:', err);
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// ============================================================================
// SYSTEM ROUTES
// ============================================================================

app.get('/api/integrations', auth, (req, res) => {
  res.json({
    whatsapp: { connected: waManager ? true : false, status: 'active' },
    booking: { connected: bookingMgr ? true : false, status: 'active' },
    csv: { connected: true, status: 'active' }
  });
});

app.get('/api/status', (req, res) => {
  const uptime = process.uptime();
  res.json({
    uptime: Math.floor(uptime),
    version: '3.0.0',
    userCount: db.users.length,
    agentCount: (db.agents || []).length,
    leadCount: (db.leads || []).length,
    bookingCount: (db.bookings || []).length,
    status: 'healthy'
  });
});

app.get('/api/dashboard', auth, (req, res) => {
  try {
    const leads = db.leads.filter(l => l.userId === req.user.id);
    const agents = db.agents.filter(a => a.userId === req.user.id);
    const bookings = (db.bookings || []).filter(b => b.userId === req.user.id);

    res.json({
      leadsTotal: leads.length,
      leadsNew: leads.filter(l => l.status === 'new').length,
      leadsQualified: leads.filter(l => l.status === 'qualified').length,
      leadsConverted: leads.filter(l => l.status === 'client').length,
      agentsConnected: agents.filter(a => waManager?.getStatus?.(a.id) === 'connected').length,
      agentsTotal: agents.length,
      bookingsConfirmed: bookings.filter(b => b.status === 'confirmed').length,
      bookingsTotal: bookings.length,
      avgLeadScore: leads.length > 0 ? Math.round(leads.reduce((s, l) => s + (l.score || 0), 0) / leads.length) : 0
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

// ============================================================================
// STATIC ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// SERVER START
// ============================================================================


// WhatsApp API routes (QR code SSE + login)
const { setupWhatsAppRoutes } = require('./routes/whatsapp-api');
setupWhatsAppRoutes(app);

app.listen(PORT, () => {
  console.log(`SalesBot IA v3.0 running on port ${PORT}`);
});

module.exports = app;
