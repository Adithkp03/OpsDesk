// CSAT after resolve (simulated, in-app).
//
// When ops move a ticket into Resolved/Closed, OpsDesk requests a one-question
// survey (1-5 + optional comment) from the requester who opened the ticket. The
// request is an in-app prompt on the ticket and a timeline entry - no email or
// SMS is sent. Rules:
//  - Only the requester who created the ticket can answer, only while the
//    ticket is Resolved/Closed, and only once per resolution.
//  - Reopening a ticket voids an unanswered survey; resolving again asks again.
//  - Tickets opened by ops staff have no requester to ask; that is logged
//    instead of asking an ops user to rate their own work.
//  - Ops see results and a summary; requesters only ever see their own survey.
const { db, logActivity } = require('./db');
const { isOps } = require('./access');

db.exec(`CREATE TABLE IF NOT EXISTS csat_surveys(
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  requester_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN('pending','answered','void')) DEFAULT 'pending',
  score INTEGER CHECK(score BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT(datetime('now')),
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_csat_ticket ON csat_surveys(ticket_id);`);

const DONE = ['Resolved', 'Closed'];

module.exports = (app, { currentUser, getTicketScoped }) => {
  function onStatusChange(ticket, next, actor) {
    const wasDone = DONE.includes(ticket.status), isDone = DONE.includes(next);
    if (wasDone && !isDone) {
      db.prepare("UPDATE csat_surveys SET status='void' WHERE ticket_id=? AND status='pending'").run(ticket.id);
      return;
    }
    if (!wasDone && isDone) {
      const creator = db.prepare('SELECT id, name, role FROM users WHERE id=?').get(ticket.created_by);
      if (!creator || creator.role !== 'requester') {
        logActivity(ticket.id, actor.id, 'csat_skipped', 'CSAT not requested: ticket was opened by ops staff, so there is no requester to ask');
        return;
      }
      db.prepare("INSERT INTO csat_surveys(ticket_id, requester_id, resolved_by) VALUES(?,?,?)").run(ticket.id, creator.id, actor.id);
      logActivity(ticket.id, actor.id, 'csat_requested', `CSAT requested from ${creator.name} (in-app prompt, simulated; no email sent)`);
    }
  }

  const view = (s, forOps) => ({
    id: s.id, ticket_id: s.ticket_id, status: s.status, score: s.score, comment: s.comment,
    requested_at: s.requested_at, answered_at: s.answered_at,
    ...(forOps ? { requester_name: s.requester_name } : {}),
  });

  app.get('/api/tickets/:id/csat', currentUser, (req, res) => {
    const { ticket: t, error } = getTicketScoped(req, Number(req.params.id));
    if (error) return res.status(error).json({ error: 'Ticket not accessible' });
    const rows = db.prepare('SELECT s.*, u.name requester_name FROM csat_surveys s JOIN users u ON u.id=s.requester_id WHERE s.ticket_id=? ORDER BY s.id DESC').all(t.id);
    if (isOps(req.user)) return res.json({ surveys: rows.map(r => view(r, true)), simulation: true });
    const mine = rows.filter(r => r.requester_id === req.user.id);
    res.json({ surveys: mine.map(r => view(r, false)), simulation: true });
  });

  app.post('/api/tickets/:id/csat', currentUser, (req, res) => {
    const { ticket: t, error } = getTicketScoped(req, Number(req.params.id));
    if (error) return res.status(error).json({ error: 'Ticket not accessible' });
    if (req.user.role !== 'requester' || t.created_by !== req.user.id) return res.status(403).json({ error: 'Only the requester who opened this ticket can answer its CSAT survey' });
    const b = req.body || {};
    if (!Number.isInteger(b.score) || b.score < 1 || b.score > 5) return res.status(400).json({ error: 'Score must be a whole number from 1 to 5' });
    if (b.comment !== undefined && (typeof b.comment !== 'string' || b.comment.length > 1000)) return res.status(400).json({ error: 'Comment must be text of at most 1000 characters' });
    if (!DONE.includes(t.status)) return res.status(409).json({ error: 'The survey opens when the ticket is resolved' });
    const survey = db.prepare("SELECT * FROM csat_surveys WHERE ticket_id=? AND requester_id=? AND status='pending' ORDER BY id DESC").get(t.id, req.user.id);
    if (!survey) return res.status(409).json({ error: 'No open survey for this ticket (already answered or not requested)' });
    // Conditional update makes a double submit race lose cleanly.
    const r = db.prepare("UPDATE csat_surveys SET status='answered', score=?, comment=?, answered_at=datetime('now') WHERE id=? AND status='pending'")
      .run(b.score, (b.comment || '').trim(), survey.id);
    if (!r.changes) return res.status(409).json({ error: 'Survey was already answered' });
    logActivity(t.id, req.user.id, 'csat_received', `CSAT ${b.score}/5 from ${req.user.name}`);
    res.status(201).json({ ok: true, score: b.score });
  });

  // Ops summary: response rate, average, distribution, by intent and current owner.
  app.get('/api/csat/summary', currentUser, (req, res) => {
    if (!isOps(req.user)) return res.status(403).json({ error: 'Ops only' });
    const rows = db.prepare(`SELECT s.*, t.intent_id, i.label intent_label, t.assigned_to, au.name owner_name, t.title, u.name requester_name
      FROM csat_surveys s JOIN tickets t ON t.id=s.ticket_id JOIN intents i ON i.id=t.intent_id JOIN users u ON u.id=s.requester_id
      LEFT JOIN users au ON au.id=t.assigned_to WHERE s.status<>'void'`).all();
    const answered = rows.filter(r => r.status === 'answered');
    const avg = a => a.length ? Math.round(a.reduce((x, r) => x + r.score, 0) / a.length * 100) / 100 : null;
    const group = (key, label) => {
      const m = new Map();
      for (const r of answered) { const k = r[key] ?? 'none'; if (!m.has(k)) m.set(k, { key: k, label: r[label] || 'Unassigned', rows: [] }); m.get(k).rows.push(r); }
      return [...m.values()].map(g => ({ key: g.key, label: g.label, responses: g.rows.length, average: avg(g.rows) })).sort((a, b) => b.responses - a.responses);
    };
    res.json({
      requested: rows.length, answered: answered.length, pending: rows.length - answered.length,
      response_rate: rows.length ? Math.round(answered.length / rows.length * 100) : null,
      average: avg(answered),
      distribution: [1, 2, 3, 4, 5].map(n => ({ score: n, count: answered.filter(r => r.score === n).length })),
      by_intent: group('intent_id', 'intent_label'), by_owner: group('assigned_to', 'owner_name'),
      low_scores: answered.filter(r => r.score <= 2).slice(-10).reverse().map(r => ({ ticket_id: r.ticket_id, title: r.title, score: r.score, comment: r.comment, requester_name: r.requester_name, answered_at: r.answered_at })),
      simulation: true,
    });
  });

  return { onStatusChange };
};
