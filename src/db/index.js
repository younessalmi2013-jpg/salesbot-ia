const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return []; }
}

function save(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function createDb(col) {
  return {
    findAll:    ()        => load(col),
    findById:   (id)      => load(col).find(x => x.id === id) || null,
    findWhere:  (fn)      => load(col).filter(fn),
    findOne:    (fn)      => load(col).find(fn) || null,
    count:      ()        => load(col).length,
    countWhere: (fn)      => load(col).filter(fn).length,

    insert(data) {
      const arr = load(col);
      const item = { ...data, id: data.id || genId(), createdAt: new Date().toISOString() };
      arr.push(item);
      save(col, arr);
      return item;
    },

    update(id, updates) {
      const arr = load(col);
      const i = arr.findIndex(x => x.id === id);
      if (i === -1) return null;
      arr[i] = { ...arr[i], ...updates, updatedAt: new Date().toISOString() };
      save(col, arr);
      return arr[i];
    },

    upsert(query, data) {
      const existing = load(col).find(query);
      if (existing) return this.update(existing.id, data);
      return this.insert(data);
    },

    delete(id) {
      const arr = load(col);
      const filtered = arr.filter(x => x.id !== id);
      save(col, filtered);
      return filtered.length < arr.length;
    },

    deleteWhere(fn) {
      const arr = load(col);
      const filtered = arr.filter(x => !fn(x));
      save(col, filtered);
    },
  };
}

const db = {
  users:    createDb('users'),
  agents:   createDb('agents'),
  leads:    createDb('leads'),
  bookings: createDb('bookings'),
  configs:  createDb('configs'),
  calls:    createDb('calls'),
};

// Seed super admin
(function seed() {
  if (db.users.count() === 0) {
    const crypto = require('crypto');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.createHmac('sha256', salt).update('admin123').digest('hex');
    db.users.insert({
      id: 'superadmin',
      username: 'admin',
      password: `${salt}:${hash}`,
      role: 'superadmin',
      email: 'admin@salesbot.ia',
      active: true,
    });
    console.log('\x1b[32m✅ Super admin cree: admin / admin123\x1b[0m');
  }
})();

module.exports = db;
