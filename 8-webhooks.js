// Outbound webhooks for ticket create / update - LOCAL / TEST ONLY.
//
// Every ticket mutation already logs an activity row. Each one becomes an event:
//   ticket.created  - the ticket was opened
//   ticket.updated  - anything else (status, owner, intent, link, thread, CSAT...)
//                     with change.type naming the activity.
// Deliveries are signed, retried and logged. Hard guarantees of this build:
//  * Destinations are restricted to this machine (localhost / 127.0.0.1 / ::1).
//    Any other host is rejected when the endpoint is saved AND again at send
//    time, and redirects are never followed. Nothing leaves the machine.
//  * Payloads carry identifiers and state only (ticket id, status, priority,
//    intent id, agency id, owner id, change type). No titles, descriptions,
//    messages, names or contact details.
//  * Each endpoint has its own random signing secret, shown once. Requests carry
//    X-OpsDesk-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">; receivers
//    should reject old timestamps. Management is lead-only; ops can read the log.
//  * Delivery is at-least-once, not ordered. Use event id to de-duplicate.
// A built-in receiver at POST /webhook-sink verifies signatures so the whole flow
// can be exercised offline, including forced failures to watch retries.
const crypto = require('crypto');
const { db, onActivity } = require('./db');
const { isOps } = require('./access');

db.exec(`CREATE TABLE IF NOT EXISTS webhook_endpoints(
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["ticket.created","ticket.updated"]',
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT(datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_deliveries(
  id INTEGER PRIMARY KEY,
  endpoint_id INTEGER NOT NULL REFERENCES webhook_endpoints(id),
  event_id TEXT NOT NULL,
  event TEXT NOT NULL,
  ticket_id INTEGER,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('pending','delivered','failed')) DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wh_due ON webhook_deliveries(status, next_attempt_at);`);

const EVENTS = ['ticket.created', 'ticket.updated'];
const MAX_ATTEMPTS = Number(process.env.OPSDESK_WEBHOOK_MAX_ATTEMPTS) || 4;
const BACKOFF = (process.env.OPSDESK_WEBHOOK_BACKOFF_MS || '2000,10000,60000').split(',').map(Number).filter(n => n >= 0);
const TIMEOUT_MS = Number(process.env.OPSDESK_WEBHOOK_TIMEOUT_MS) || 3000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { error: 'Enter a full URL, for example http://127.0.0.1:4173/webhook-sink' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'Only http(s) URLs are allowed' };
  if (u.username || u.password) return { error: 'Credentials in the URL are not allowed' };
  if (!LOCAL_HOSTS.has(u.hostname)) return { error: 'This build only delivers to this machine (localhost, 127.0.0.1 or ::1). External destinations are not enabled.' };
  return { url: u.toString() };
}

const sign = (secret, t, body) => crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
const newSecret = () => 'whsec_' + crypto.randomBytes(24).toString('hex');

function enqueue(event, ticketId, change, onlyEndpointId) {
  const t = db.prepare('SELECT id, status, priority, intent_id, agency_id, assigned_to FROM tickets WHERE id=?').get(ticketId);
  if (!t) return;
  const eps = db.prepare('SELECT * FROM webhook_endpoints WHERE active=1' + (onlyEndpointId ? ' AND id=?' : '')).all(...(onlyEndpointId ? [onlyEndpointId] : []));
  const ins = db.prepare('INSERT INTO webhook_deliveries(endpoint_id,event_id,event,ticket_id,payload,next_attempt_at) VALUES(?,?,?,?,?,?)');
  for (const ep of eps) {
    if (!JSON.parse(ep.events).includes(event) && event !== 'webhook.test') continue;
    const eventId = 'evt_' + crypto.randomBytes(12).toString('hex');
    const payload = JSON.stringify({ id: eventId, event, created_at: new Date().toISOString(), ticket: t, change: { type: change } });
    ins.run(ep.id, eventId, event, t.id, payload, Date.now());
  }
  kick();
}

onActivity((ticketId, type) => {
  if (!db.prepare('SELECT 1 FROM webhook_endpoints WHERE active=1 LIMIT 1').get()) return;
  enqueue(type === 'created' ? 'ticket.created' : 'ticket.updated', ticketId, type);
});

let busy = false, timer = null;
function kick() { setImmediate(processDue); }

async function attempt(d) {
  const ep = db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(d.endpoint_id);
  const fail = (msg, code) => {
    const attempts = d.attempts + 1;
    if (!ep || !ep.active || attempts >= MAX_ATTEMPTS || msg.startsWith('blocked')) {
      db.prepare("UPDATE webhook_deliveries SET status='failed', attempts=?, last_status=?, last_error=? WHERE id=?").run(attempts, code ?? null, msg, d.id);
    } else {
      const wait = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)] ?? 1000;
      db.prepare('UPDATE webhook_deliveries SET attempts=?, last_status=?, last_error=?, next_attempt_at=? WHERE id=?').run(attempts, code ?? null, msg, Date.now() + wait, d.id);
    }
  };
  if (!ep || !ep.active) return fail('endpoint disabled or removed');
  if (checkUrl(ep.url).error) return fail('blocked: destination is not local');
  const t = Math.floor(Date.now() / 1000);
  try {
    const r = await fetch(ep.url, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json', 'User-Agent': 'OpsDesk-Webhooks/1',
        'X-OpsDesk-Event': d.event, 'X-OpsDesk-Delivery': String(d.id), 'X-OpsDesk-Endpoint': String(ep.id),
        'X-OpsDesk-Signature': `t=${t},v1=${sign(ep.secret, t, d.payload)}`,
      },
      body: d.payload,
    });
    if (r.status >= 200 && r.status < 300) {
      db.prepare("UPDATE webhook_deliveries SET status='delivered', attempts=?, last_status=?, last_error=NULL, delivered_at=datetime('now') WHERE id=?").run(d.attempts + 1, r.status, d.id);
    } else fail(r.status >= 300 && r.status < 400 ? 'redirect not followed' : `HTTP ${r.status}`, r.status);
  } catch (e) { fail(e.name === 'TimeoutError' ? 'timeout' : 'connection error: ' + (e.cause?.code || e.message).toString().slice(0, 80)); }
}

async function processDue() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const d = db.prepare("SELECT * FROM webhook_deliveries WHERE status='pending' AND next_attempt_at<=? ORDER BY id LIMIT 1").get(Date.now());
      if (!d) break;
      // Lease the row for one timeout window so a crash mid-send retries later.
      db.prepare('UPDATE webhook_deliveries SET next_attempt_at=? WHERE id=?').run(Date.now() + TIMEOUT_MS + 2000, d.id);
      await attempt(d);
    }
  } finally { busy = false; }
}

module.exports = (app, { currentUser }) => {
  if (!timer) { timer = setInterval(processDue, 500); timer.unref(); }

  const lead = (req, res) => { if (req.user.role !== 'lead') { res.status(403).json({ error: 'Only leads manage webhooks' }); return false; } return true; };
  const ops = (req, res) => { if (!isOps(req.user)) { res.status(403).json({ error: 'Ops only' }); return false; } return true; };
  const epView = (e) => {
    const s = db.prepare("SELECT status, COUNT(*) c FROM webhook_deliveries WHERE endpoint_id=? GROUP BY status").all(e.id);
    const count = (k) => s.find(x => x.status === k)?.c || 0;
    return { id: e.id, url: e.url, description: e.description, events: JSON.parse(e.events), active: !!e.active, created_at: e.created_at, delivered: count('delivered'), pending: count('pending'), failed: count('failed') };
  };

  app.get('/api/webhooks', currentUser, (req, res) => {
    if (!ops(req, res)) return;
    res.json({ endpoints: db.prepare('SELECT * FROM webhook_endpoints ORDER BY id').all().map(epView), events: EVENTS, local_only: true, max_attempts: MAX_ATTEMPTS });
  });

  app.post('/api/webhooks', currentUser, (req, res) => {
    if (!lead(req, res)) return;
    const b = req.body || {}, c = checkUrl(b.url);
    if (c.error) return res.status(400).json({ error: c.error });
    const events = b.events === undefined ? EVENTS : b.events;
    if (!Array.isArray(events) || !events.length || events.some(e => !EVENTS.includes(e))) return res.status(400).json({ error: 'events must be a non-empty list of: ' + EVENTS.join(', ') });
    const description = typeof b.description === 'string' ? b.description.trim().slice(0, 120) : '';
    const secret = newSecret();
    const id = db.prepare('INSERT INTO webhook_endpoints(url,description,secret,events,created_by) VALUES(?,?,?,?,?)').run(c.url, description, secret, JSON.stringify([...new Set(events)]), req.user.id).lastInsertRowid;
    res.status(201).json({ ...epView(db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(id)), secret, secret_note: 'Shown once. Rotate to get a new one.' });
  });

  const endpoint = (req, res) => { const e = db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(Number(req.params.id)); if (!e) res.status(404).json({ error: 'Endpoint not found' }); return e; };

  app.post('/api/webhooks/:id/active', currentUser, (req, res) => {
    if (!lead(req, res)) return; const e = endpoint(req, res); if (!e) return;
    if (typeof (req.body || {}).active !== 'boolean') return res.status(400).json({ error: 'active must be true or false' });
    db.prepare('UPDATE webhook_endpoints SET active=? WHERE id=?').run(req.body.active ? 1 : 0, e.id);
    res.json(epView(db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(e.id)));
  });
  app.post('/api/webhooks/:id/rotate-secret', currentUser, (req, res) => {
    if (!lead(req, res)) return; const e = endpoint(req, res); if (!e) return;
    const secret = newSecret();
    db.prepare('UPDATE webhook_endpoints SET secret=? WHERE id=?').run(secret, e.id);
    res.json({ id: e.id, secret, secret_note: 'Shown once. Pending retries are signed with the new secret.' });
  });
  app.delete('/api/webhooks/:id', currentUser, (req, res) => {
    if (!lead(req, res)) return; const e = endpoint(req, res); if (!e) return;
    db.transaction(() => { db.prepare('DELETE FROM webhook_deliveries WHERE endpoint_id=?').run(e.id); db.prepare('DELETE FROM webhook_endpoints WHERE id=?').run(e.id); })();
    res.json({ ok: true });
  });
  app.post('/api/webhooks/:id/test', currentUser, (req, res) => {
    if (!lead(req, res)) return; const e = endpoint(req, res); if (!e) return;
    const t = db.prepare('SELECT id FROM tickets ORDER BY id LIMIT 1').get();
    if (!t) return res.status(409).json({ error: 'No ticket to describe in a test event' });
    enqueue('webhook.test', t.id, 'test', e.id);
    res.status(202).json({ queued: true });
  });

  app.get('/api/webhooks/deliveries', currentUser, (req, res) => {
    if (!ops(req, res)) return;
    const q = req.query, where = [], params = [];
    if (q.endpoint_id) { where.push('endpoint_id=?'); params.push(Number(q.endpoint_id)); }
    if (['pending', 'delivered', 'failed'].includes(q.status)) { where.push('status=?'); params.push(q.status); }
    const rows = db.prepare(`SELECT id,endpoint_id,event_id,event,ticket_id,status,attempts,last_status,last_error,created_at,delivered_at,next_attempt_at FROM webhook_deliveries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 100`).all(...params);
    res.json({ deliveries: rows.map(r => ({ ...r, next_attempt_at: r.status === 'pending' ? new Date(r.next_attempt_at).toISOString() : null })), max_attempts: MAX_ATTEMPTS });
  });
  app.post('/api/webhooks/deliveries/:id/redeliver', currentUser, (req, res) => {
    if (!lead(req, res)) return;
    const d = db.prepare('SELECT * FROM webhook_deliveries WHERE id=?').get(Number(req.params.id));
    if (!d) return res.status(404).json({ error: 'Delivery not found' });
    if (d.status !== 'failed') return res.status(409).json({ error: 'Only failed deliveries can be redelivered' });
    db.prepare("UPDATE webhook_deliveries SET status='pending', attempts=0, next_attempt_at=?, last_error=NULL WHERE id=?").run(Date.now(), d.id);
    kick();
    res.status(202).json({ queued: true });
  });

  // ---- Built-in local receiver (test sink) ----
  // Verifies the signature with the endpoint's secret, so a green row proves the
  // signing works end to end. ?fail=N answers 500 to the first N attempts of each
  // delivery to demonstrate retries. Keeps the last 50 verified events in memory.
  const received = [], failCount = new Map();
  app.post('/webhook-sink', (req, res) => {
    const ep = db.prepare('SELECT * FROM webhook_endpoints WHERE id=?').get(Number(req.get('X-OpsDesk-Endpoint')));
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.get('X-OpsDesk-Signature') || '');
    if (!ep || !m || !req.rawBody) return res.status(401).json({ error: 'bad signature' });
    const expected = Buffer.from(sign(ep.secret, m[1], req.rawBody.toString('utf8')), 'hex');
    const got = Buffer.from(m[2], 'hex');
    if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return res.status(401).json({ error: 'bad signature' });
    if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return res.status(401).json({ error: 'stale timestamp' });
    const delivery = req.get('X-OpsDesk-Delivery');
    const n = Math.min(Number(req.query.fail) || 0, 10);
    if (n) { const c = (failCount.get(delivery) || 0) + 1; failCount.set(delivery, c); if (failCount.size > 500) failCount.clear(); if (c <= n) return res.status(500).json({ error: 'simulated failure ' + c }); }
    received.unshift({ delivery, event: req.get('X-OpsDesk-Event'), event_id: req.body.id, ticket: req.body.ticket?.id, change: req.body.change?.type, verified: true, at: new Date().toISOString() });
    received.length = Math.min(received.length, 50);
    res.json({ ok: true });
  });
  app.get('/api/webhooks/sink/received', currentUser, (req, res) => { if (!ops(req, res)) return; res.json({ received }); });
};
module.exports.checkUrl = checkUrl;
