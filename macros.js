// Macros / canned replies with intent-aware suggestions.
//
// A macro is a reusable reply body, optionally tied to one intent. For a ticket,
// OpsDesk ranks macros by (1) the ticket's intent, (2) the intent the CONVERSATION
// points to when it differs (same rule-based suggester as intent re-check), and
// (3) generic macros, with a small keyword bonus from the latest messages. Every
// suggestion is a DRAFT: filling a macro only produces text for the agent to
// review and edit in the composer. Nothing is sent by this module.
// Ops only - requesters never see macros or suggestions.
const { db } = require('./db');
const { isOps } = require('./access');
const { INTENTS, suggestIntent, suggestConversation } = require('./intent');

db.exec(`CREATE TABLE IF NOT EXISTS macros(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  intent_id TEXT REFERENCES intents(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
  drafted_count INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);`);

const PLACEHOLDERS = {
  ticket_ref: (c) => 'T-' + c.t.id,
  booking_ref: (c) => c.t.tboh || '',
  requester_name: (c) => c.requester?.name || 'there',
  agency: (c) => c.t.agency_name || '',
  agent_name: (c) => c.user.name,
  intent: (c) => c.t.intent_label || '',
  check_in_date: (c) => c.t.check_in_date || '',
  last_cancel_date: (c) => c.t.lcd_date || '',
};

const DEFAULTS = [
  ['Refund: status check', 'refund_delay', 'Hi {{requester_name}}, thanks for your patience on {{ticket_ref}} (booking {{booking_ref}}). We have raised the refund with the supplier and are tracking it. We will update you as soon as there is a confirmed credit date. - {{agent_name}}'],
  ['Refund: need details', 'refund_delay', 'Hi {{requester_name}}, to chase the refund on booking {{booking_ref}} we need the cancellation date and the amount you expect back. Please reply with both. - {{agent_name}}'],
  ['Amendment: request received', 'booking_amendment', 'Hi {{requester_name}}, we have your amendment request for booking {{booking_ref}} ({{ticket_ref}}). We are checking supplier rules and fees and will confirm before changing anything. - {{agent_name}}'],
  ['Cancellation: deadline reminder', 'cancellation', 'Hi {{requester_name}}, for booking {{booking_ref}} the last free cancellation date is {{last_cancel_date}}. Please confirm if you still want to cancel before then. - {{agent_name}}'],
  ['Payment: under review', 'payment_issue', 'Hi {{requester_name}}, we are reviewing the payment issue on {{ticket_ref}} with finance. Please do not retry the payment until we confirm. - {{agent_name}}'],
  ['Inventory: checking with supplier', 'inventory_sync', 'Hi {{requester_name}}, we are checking availability for booking {{booking_ref}} with the supplier. We will confirm the live status shortly. - {{agent_name}}'],
  ['Special request: forwarded', 'special_request', 'Hi {{requester_name}}, your special request on booking {{booking_ref}} has been passed to the property. Requests are not guaranteed until the supplier confirms. - {{agent_name}}'],
  ['Documents: what we need', 'documentation', 'Hi {{requester_name}}, for {{ticket_ref}} we need clear copies of the traveller documents listed in the booking. Check-in is {{check_in_date}}, so earlier is better. - {{agent_name}}'],
  ['Supplier: chasing confirmation', 'supplier_confirmation', 'Hi {{requester_name}}, supplier confirmation for booking {{booking_ref}} is still pending. We have chased them and will update you on {{ticket_ref}}. - {{agent_name}}'],
  ['General: acknowledged', null, 'Hi {{requester_name}}, thanks for contacting us about {{ticket_ref}}. We are looking into it and will reply with next steps. - {{agent_name}}'],
  ['General: resolved, closing', null, 'Hi {{requester_name}}, we believe {{ticket_ref}} is now resolved. Reply here if anything is still open. - {{agent_name}}'],
];

module.exports = (app, { currentUser, getTicketScoped }) => {
  // Starter macros are inserted once, lazily, so they exist whether the app was
  // seeded before or after this module first loaded.
  const ensureDefaults = () => {
    if (db.prepare('SELECT COUNT(*) c FROM macros').get().c === 0 && db.prepare('SELECT COUNT(*) c FROM intents').get().c > 0) {
      const ins = db.prepare('INSERT INTO macros(name, intent_id, body) VALUES(?,?,?)');
      db.transaction(() => { for (const [n, i, b] of DEFAULTS) ins.run(n, i, b); })();
    }
  };
  ensureDefaults();

  const needOps = (req, res) => { if (!isOps(req.user)) { res.status(403).json({ error: 'Macros are for ops users' }); return false; } ensureDefaults(); return true; };

  function validate(b, partial) {
    const errors = [];
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const body = typeof b.body === 'string' ? b.body.trim() : '';
    if (!partial || b.name !== undefined) if (name.length < 3 || name.length > 80) errors.push('Name must be 3-80 characters');
    if (!partial || b.body !== undefined) if (body.length < 5 || body.length > 2000) errors.push('Body must be 5-2000 characters');
    if (b.intent_id !== undefined && b.intent_id !== null && !INTENTS.some(i => i.id === b.intent_id)) errors.push('Unknown intent');
    const unknown = [...(body.matchAll(/{{\s*([a-z_]+)\s*}}/g))].map(m => m[1]).filter(k => !PLACEHOLDERS[k]);
    if (unknown.length) errors.push('Unknown placeholder: ' + [...new Set(unknown)].join(', ') + '. Allowed: ' + Object.keys(PLACEHOLDERS).join(', '));
    return { errors, name, body };
  }

  function context(req, t) {
    const requester = db.prepare("SELECT id, name FROM users WHERE id=? AND role='requester'").get(t.created_by);
    return { t, requester, user: req.user };
  }
  function render(body, ctx) {
    const unresolved = [];
    const text = body.replace(/{{\s*([a-z_]+)\s*}}/g, (m, k) => {
      const v = PLACEHOLDERS[k] ? PLACEHOLDERS[k](ctx) : '';
      if (!v) unresolved.push(k);
      return v || `[${k.replace(/_/g, ' ')}]`;
    });
    return { text, unresolved: [...new Set(unresolved)] };
  }

  app.get('/api/macros', currentUser, (req, res) => {
    if (!needOps(req, res)) return;
    res.json({ macros: db.prepare('SELECT m.*, i.label intent_label FROM macros m LEFT JOIN intents i ON i.id=m.intent_id WHERE m.active=1 ORDER BY m.intent_id IS NULL, m.intent_id, m.name').all(), placeholders: Object.keys(PLACEHOLDERS), simulation: true });
  });
  app.post('/api/macros', currentUser, (req, res) => {
    if (!needOps(req, res)) return;
    const b = req.body || {}, v = validate(b, false);
    if (v.errors.length) return res.status(400).json({ errors: v.errors });
    const id = db.prepare('INSERT INTO macros(name, body, intent_id, created_by) VALUES(?,?,?,?)').run(v.name, v.body, b.intent_id || null, req.user.id).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT * FROM macros WHERE id=?').get(id));
  });
  app.put('/api/macros/:id', currentUser, (req, res) => {
    if (!needOps(req, res)) return;
    const m = db.prepare('SELECT * FROM macros WHERE id=? AND active=1').get(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'Macro not found' });
    const b = req.body || {}, v = validate(b, true);
    if (v.errors.length) return res.status(400).json({ errors: v.errors });
    db.prepare("UPDATE macros SET name=?, body=?, intent_id=?, updated_at=datetime('now') WHERE id=?")
      .run(b.name !== undefined ? v.name : m.name, b.body !== undefined ? v.body : m.body, b.intent_id !== undefined ? b.intent_id : m.intent_id, m.id);
    res.json(db.prepare('SELECT * FROM macros WHERE id=?').get(m.id));
  });
  app.delete('/api/macros/:id', currentUser, (req, res) => {
    if (!needOps(req, res)) return;
    const r = db.prepare('UPDATE macros SET active=0 WHERE id=? AND active=1').run(Number(req.params.id));
    if (!r.changes) return res.status(404).json({ error: 'Macro not found' });
    res.json({ ok: true });
  });

  // Ranked suggestions for a ticket, each with a rendered DRAFT preview.
  app.get('/api/tickets/:id/macro-suggestions', currentUser, (req, res) => {
    if (!needOps(req, res)) return;
    const { ticket: t, error } = getTicketScoped(req, Number(req.params.id));
    if (error) return res.status(error).json({ error: 'Ticket not accessible' });
    const msgs = db.prepare(`SELECT m.body FROM side_messages m JOIN side_threads st ON st.id=m.thread_id WHERE st.ticket_id=? ORDER BY m.id DESC LIMIT 12`).all(t.id).map(r => r.body.slice(0, 1000));
    const convo = msgs.join('\n');
    const sug = convo.trim() ? suggestConversation({ title: t.title, description: t.description, conversation: convo }) : suggestIntent(t.title, t.description || '');
    const convoIntent = !sug.abstain && sug.intent_id !== t.intent_id ? sug.intent_id : null;
    const words = new Set((msgs[0] || '').toLowerCase().match(/[a-z]{4,}/g) || []);
    const ctx = context(req, t);
    const scored = db.prepare('SELECT * FROM macros WHERE active=1').all().map(m => {
      let score = 0.1, reason = 'General reply';
      if (m.intent_id === t.intent_id) { score = 1; reason = `Matches ticket intent (${t.intent_label})`; }
      else if (convoIntent && m.intent_id === convoIntent) { score = 0.8; reason = `Conversation points to ${sug.label}, not the ticket intent. Review the intent first`; }
      else if (m.intent_id) score = 0;
      const overlap = [...new Set((m.name + ' ' + m.body).toLowerCase().match(/[a-z]{4,}/g) || [])].filter(w => words.has(w)).length;
      if (score > 0) score += Math.min(0.15, overlap * 0.03);
      return { m, score, reason };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.m.name.localeCompare(b.m.name)).slice(0, 5);
    res.json({
      ticket_intent: { id: t.intent_id, label: t.intent_label },
      conversation_intent: convoIntent ? { id: sug.intent_id, label: sug.label, confidence: sug.confidence } : null,
      intent_unclear: !!sug.abstain,
      suggestions: scored.map(({ m, score, reason }) => ({ macro_id: m.id, name: m.name, intent_id: m.intent_id, score: Math.round(score * 100) / 100, reason, preview: render(m.body, ctx).text })),
      draft_only: true,
    });
  });

  // Fill one macro for this ticket. Returns text only; sending stays a separate,
  // explicit step (the thread reply endpoint).
  app.post('/api/tickets/:id/macros/:macroId/draft', currentUser, (req, res) => {
    if (!needOps(req, res)) return;
    const { ticket: t, error } = getTicketScoped(req, Number(req.params.id));
    if (error) return res.status(error).json({ error: 'Ticket not accessible' });
    const m = db.prepare('SELECT * FROM macros WHERE id=? AND active=1').get(Number(req.params.macroId));
    if (!m) return res.status(404).json({ error: 'Macro not found' });
    db.prepare('UPDATE macros SET drafted_count=drafted_count+1 WHERE id=?').run(m.id);
    res.json({ macro_id: m.id, ...render(m.body, context(req, t)), draft_only: true });
  });
};
