const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.OPSDESK_DB || path.join(__dirname, 'opsdesk.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS agencies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  region TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('requester','agent','em','lead')),
  agency_id INTEGER REFERENCES agencies(id)
);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  agency_id INTEGER NOT NULL REFERENCES agencies(id),
  tboh TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'P3' CHECK (priority IN ('P1','P2','P3')),
  intent_id TEXT NOT NULL REFERENCES intents(id),
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New','Open','Pending','Escalated','Resolved','Closed')),
  check_in_date TEXT,
  lcd_date TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ticket_links (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  linked_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (ticket_id, linked_ticket_id),
  CHECK (ticket_id <> linked_ticket_id)
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Additive migration: link each demo user to a verified external auth account.
// Existing databases gain the column without reseeding; demo mode ignores it.
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'firebase_uid')) {
  db.exec('ALTER TABLE users ADD COLUMN firebase_uid TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid) WHERE firebase_uid IS NOT NULL');


const activityListeners = []; // realtime.js, webhooks.js...; keeps db.js dependency-free
function logActivity(ticketId, actorId, type, detail) {
  db.prepare('INSERT INTO activity (ticket_id, actor_id, type, detail) VALUES (?,?,?,?)')
    .run(ticketId, actorId, type, detail || '');
  for (const fn of activityListeners) { try { fn(ticketId, type); } catch { /* listeners never break writes */ } }
}

function linkTickets(a, b, reason, actorId) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const existing = db.prepare('SELECT id, reason FROM ticket_links WHERE ticket_id=? AND linked_ticket_id=?').get(lo, hi);
  if (existing) {
    if (!existing.reason.includes(reason)) {
      db.prepare('UPDATE ticket_links SET reason=? WHERE id=?').run(existing.reason + ' · ' + reason, existing.id);
    }
    return false;
  }
  db.prepare('INSERT INTO ticket_links (ticket_id, linked_ticket_id, reason) VALUES (?,?,?)').run(lo, hi, reason);
  if (actorId) {
    logActivity(a, actorId, 'linked', `Linked to T-${b}: ${reason}`);
    logActivity(b, actorId, 'linked', `Linked to T-${a}: ${reason}`);
  }
  return true;
}

module.exports = { db, logActivity, linkTickets, DB_PATH, onActivity: (fn) => { activityListeners.push(fn); } };
