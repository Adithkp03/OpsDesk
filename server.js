const express = require('express');
const path = require('path');
const { db, logActivity, linkTickets } = require('./db');
const { INTENTS, suggestIntent, suggestConversation } = require('./intent');
const {sla}=require('./travel');
const {isOps,canRead,scope}=require('./access');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.use(express.static(path.join(__dirname, 'public')));

const STATUSES = ['New', 'Open', 'Pending', 'Escalated', 'Resolved', 'Closed'];
const PRIORITIES = ['P1', 'P2', 'P3'];

// Auth: demo header by default, verified Firebase identity when OPSDESK_AUTH_MODE=firebase.
// Role and agency checks below are identical in both modes (see access.js).
const { MODE: AUTH_MODE, currentUser, clientConfig } = require('./auth');
const canSeeAll = isOps;

function getTicketScoped(req, id) {
  const t = db.prepare(`
    SELECT t.*, a.name AS agency_name, a.country AS agency_country, a.region AS agency_region,
           i.label AS intent_label, cu.name AS created_by_name, au.name AS assigned_to_name
    FROM tickets t
    JOIN agencies a ON a.id = t.agency_id
    JOIN intents i ON i.id = t.intent_id
    JOIN users cu ON cu.id = t.created_by
    LEFT JOIN users au ON au.id = t.assigned_to
    WHERE t.id = ?`).get(id);
  if (!t) return { error: 404 };
  if (!canRead(req.user,t)) return { error: 403 };
  return { ticket: t };
}

// --- Bootstrap: demo users, agencies, intents ---
app.get('/api/bootstrap', (req, res) => {
  res.json({
    users: db.prepare('SELECT u.id, u.name, u.role, u.agency_id, a.name AS agency_name FROM users u LEFT JOIN agencies a ON a.id=u.agency_id ORDER BY u.role, u.id').all(),
    agencies: db.prepare('SELECT * FROM agencies ORDER BY name').all(),
    intents: INTENTS.map(({ id, label }) => ({ id, label })),
    statuses: STATUSES,
    priorities: PRIORITIES,
    auth_mode: AUTH_MODE,
    firebase_client_config: clientConfig(),
  });
});

// Current signed-in user (never leaks the external provider uid).
app.get('/api/whoami', currentUser, (req, res) => {
  const { firebase_uid, ...u } = req.user;
  res.json(u);
});

// --- Real-time sync (SSE). Header-authenticated like every other route - no
// credentials in query strings (URLs end up in logs). The client streams this
// endpoint with fetch() + Authorization/X-User-Id headers and falls back to
// authenticated polling when streaming is unavailable. Events are role-scoped
// per connection: org roles receive all ticket events; requesters only their
// own created tickets (see realtime.js). Payloads carry ids only; clients
// re-fetch their own scoped views. Connections are bounded (see realtime.js)
// so a stream never outlives the credential that authorized it by much.
const realtime = require('./realtime');
app.get('/api/events', currentUser, (req, res) => realtime.subscribe(req, res, req.user));

// --- Intent suggestion (rules-based, overridable) ---
app.post('/api/intents/suggest', currentUser, (req, res) => {
  const { title, description, conversation } = req.body || {};
  if (typeof title !== 'string' || typeof description !== 'string') {
    return res.status(400).json({ error: 'title and description strings required' });
  }
  if (typeof conversation === 'string' && conversation.trim()) {
    return res.json(suggestConversation({ title: title.slice(0, 500), description: description.slice(0, 5000), conversation: conversation.slice(0, 8000) }));
  }
  res.json(suggestIntent(title.slice(0, 500), description.slice(0, 5000)));
});

// Re-suggest a ticket's intent from its accumulated conversation (side-thread
// messages the caller is allowed to read, plus ticket text). Suggestion only -
// applying it is a separate, permission-checked call. Requesters contribute only
// the external threads they are recipients of; ops see every thread.
app.post('/api/tickets/:id/intent-resuggest', currentUser, (req, res) => {
  const { ticket: t, error } = getTicketScoped(req, Number(req.params.id));
  if (error) return res.status(error).json({ error: 'Ticket not accessible' });
  const rows = isOps(req.user)
    ? db.prepare(`SELECT m.body FROM side_messages m JOIN side_threads st ON st.id=m.thread_id WHERE st.ticket_id=? ORDER BY m.id DESC LIMIT 12`).all(t.id)
    : db.prepare(`SELECT m.body FROM side_messages m JOIN side_threads st ON st.id=m.thread_id
        JOIN side_recipients r ON r.thread_id=st.id JOIN side_contacts c ON c.id=r.contact_id
        WHERE st.ticket_id=? AND st.visibility='external' AND c.user_id=? ORDER BY m.id DESC LIMIT 12`).all(t.id, req.user.id);
  const conversation = rows.map(r => r.body.slice(0, 1000)).join('\n');
  const suggestion = conversation.trim()
    ? suggestConversation({ title: t.title, description: t.description, conversation })
    : suggestIntent(t.title, t.description || '');
  res.json({ suggestion, current_intent_id: t.intent_id, differs: suggestion.intent_id !== t.intent_id && !suggestion.abstain, sources: { thread_messages_used: rows.length } });
});

// Apply an intent to an existing ticket: ops roles, or the requester who created
// it (the same manual-select owner as at creation). Logged on the timeline.
app.post('/api/tickets/:id/intent', currentUser, (req, res) => {
  const { ticket: t, error } = getTicketScoped(req, Number(req.params.id));
  if (error) return res.status(error).json({ error: 'Ticket not accessible' });
  if (!isOps(req.user) && t.created_by !== req.user.id) return res.status(403).json({ error: 'Only ops or the ticket creator can change the intent' });
  const intent = INTENTS.find(i => i.id === (req.body || {}).intent_id);
  if (!intent) return res.status(400).json({ error: 'Choose a valid intent' });
  if (intent.id !== t.intent_id) {
    db.prepare("UPDATE tickets SET intent_id=?, updated_at=datetime('now') WHERE id=?").run(intent.id, t.id);
    logActivity(t.id, req.user.id, 'intent_changed', `Intent ${t.intent_label} -> ${intent.label}`);
  }
  res.json({ id: t.id, intent_id: intent.id, intent_label: intent.label });
});

// --- Queue ---
app.get('/api/tickets', currentUser, (req, res) => {
  const access=scope(req.user),peerAccess=scope(req.user,'peer');
  const rows = db.prepare(`
    SELECT t.id, t.title, t.agency_id, a.name AS agency_name, a.region AS agency_region,
           t.tboh, t.priority, t.intent_id, i.label AS intent_label, t.status,
           t.check_in_date, t.lcd_date, t.assigned_to, au.name AS assigned_to_name,
           t.created_at, t.updated_at, t.completed_at,t.work_queue,t.created_by,
           (WITH RECURSIVE component(id) AS (
             SELECT t.id UNION
             SELECT CASE WHEN l.ticket_id=c.id THEN l.linked_ticket_id ELSE l.ticket_id END
             FROM component c JOIN ticket_links l ON l.ticket_id=c.id OR l.linked_ticket_id=c.id
             JOIN tickets peer ON peer.id=CASE WHEN l.ticket_id=c.id THEN l.linked_ticket_id ELSE l.ticket_id END
             WHERE peer.agency_id=t.agency_id AND ${peerAccess.sql}
           ) SELECT COUNT(*)-1 FROM component) AS link_count
    FROM tickets t
    JOIN agencies a ON a.id = t.agency_id
    JOIN intents i ON i.id = t.intent_id
    LEFT JOIN users au ON au.id = t.assigned_to
    WHERE ${access.sql}
    ORDER BY CASE t.priority WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 ELSE 2 END, t.updated_at DESC
  `).all(access.params);
  let tickets=rows;
  const q=req.query;
  if(q.view==='triage')tickets=tickets.filter(t=>t.assigned_to===null);
  if(q.view==='mine')tickets=tickets.filter(t=>t.assigned_to===req.user.id);
  if(q.region)tickets=tickets.filter(t=>t.agency_region===q.region);
  if(q.intent)tickets=tickets.filter(t=>t.intent_id===q.intent);
  if(q.view==='linked')tickets=tickets.filter(t=>t.link_count>0);
  if(q.view==='escalation')tickets=tickets.filter(t=>t.work_queue==='escalation');
  if(q.view==='operations')tickets=tickets.filter(t=>t.work_queue==='operations');
  tickets=tickets.map(t=>({...t,sla:sla(t)}));
  if(q.sla)tickets=tickets.filter(t=>t.sla.state===q.sla);
  res.json({ tickets });
});

// --- Create ticket: validates input, auto-links by TBOH/agency/intent, logs activity ---
app.post('/api/tickets', currentUser, (req, res) => {
  if(req.user.role==='em')return res.status(403).json({error:'Escalation Managers work the escalation queue; agents and requesters create tickets'});
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const tboh = String(b.tboh || '').trim().slice(0, 40);
  const errors = [];
  if (title.length < 4 || title.length > 200) errors.push('Title must be 4-200 characters');
  if (description.length > 5000) errors.push('Description too long');
  if (!PRIORITIES.includes(b.priority)) errors.push('Priority must be P1, P2 or P3');
  const intent = INTENTS.find(i => i.id === b.intent_id);
  if (!intent) errors.push('Choose a valid intent');
  let agencyId;
  if (canSeeAll(req.user)) {
    agencyId = parseInt(b.agency_id, 10);
    if (!db.prepare('SELECT id FROM agencies WHERE id=?').get(agencyId)) errors.push('Choose a valid agency');
  } else {
    agencyId = req.user.agency_id; // requesters can only file for their own agency
  }
  const dateOk = (v) => v === undefined || v === null || v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v);
  if (!dateOk(b.check_in_date) || !dateOk(b.lcd_date)) errors.push('Dates must be YYYY-MM-DD');
  if (errors.length) return res.status(400).json({ errors });

  const info = db.prepare(`
    INSERT INTO tickets (title, description, agency_id, tboh, priority, intent_id, check_in_date, lcd_date, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    title, description, agencyId, tboh, b.priority, intent.id,
    b.check_in_date || null, b.lcd_date || null, req.user.id);
  const id = info.lastInsertRowid;
  logActivity(id, req.user.id, 'created', `${req.user.name} opened the ticket (${intent.label}, ${b.priority})`);

  // First-class linkage (PS Problem 1): same booking, then same agency + intent
  const linked = [];
  if (tboh) {
    for (const m of db.prepare('SELECT id FROM tickets WHERE agency_id=? AND tboh=? AND id<>?').all(agencyId, tboh, id)) {
      if (linkTickets(id, m.id, `Same booking (TBOH ${tboh})`, req.user.id)) linked.push({ id: m.id, reason: `Same booking (TBOH ${tboh})` });
    }
  }
  for (const m of db.prepare('SELECT id FROM tickets WHERE agency_id=? AND intent_id=? AND id<>?').all(agencyId, intent.id, id)) {
    if (linkTickets(id, m.id, `Same agency + intent (${intent.label})`, req.user.id)) linked.push({ id: m.id, reason: `Same agency + intent (${intent.label})` });
  }
  res.status(201).json({ id, linked:linked.filter(l=>canRead(req.user,db.prepare('SELECT * FROM tickets WHERE id=?').get(l.id))) });
});

// --- Ticket detail with case view + timeline ---
app.get('/api/tickets/:id', currentUser, (req, res) => {
  const { ticket, error } = getTicketScoped(req, parseInt(req.params.id, 10));
  if (error) return res.status(error).json({ error: error === 404 ? 'Ticket not found' : 'Ticket not accessible to this role' });
  // One case = the connected component of the link graph (A-B and B-C means A, B, C
  // share a case), not only directly linked pairs. Requesters never see nodes or edges
  // belonging to another agency, even if a link somehow exists.
  
  const seen = new Set([ticket.id]);
  const queue = [ticket.id];
  const edgeMap = new Map();
  while (queue.length) {
    const cur = queue.shift();
    for (const e of db.prepare('SELECT * FROM ticket_links WHERE ticket_id=? OR linked_ticket_id=?').all(cur, cur)) {
      const other = e.ticket_id === cur ? e.linked_ticket_id : e.ticket_id;
      const peer=db.prepare('SELECT * FROM tickets WHERE id=?').get(other);
      if(!peer||peer.agency_id!==ticket.agency_id||!canRead(req.user,peer))continue;
      edgeMap.set(e.id,e);
      if (!seen.has(other)) { seen.add(other); queue.push(other); }
    }
  }
  const nodeRows = seen.size > 1 ? db.prepare(`
    SELECT o.id, o.title, o.status, o.priority, o.tboh, o.agency_id, o.created_by,o.work_queue,o.created_at,
           i.label AS intent_label, au.name AS assigned_to_name
    FROM tickets o JOIN intents i ON i.id = o.intent_id LEFT JOIN users au ON au.id = o.assigned_to
    WHERE o.id IN (${[...seen].join(',')}) ORDER BY o.created_at`).all() : [];
  const nodes = nodeRows.filter(o => o.id !== ticket.id && canRead(req.user,o));
  const nodeIds = new Set(nodes.map(n => n.id));
  const edges = [...edgeMap.values()].filter(e => (e.ticket_id === ticket.id || nodeIds.has(e.ticket_id)) && (e.linked_ticket_id === ticket.id || nodeIds.has(e.linked_ticket_id)));
  const links = nodes.map(n => ({
    ...n,
    reason: [...new Set(edges.filter(e => e.ticket_id === n.id || e.linked_ticket_id === n.id).flatMap(e => e.reason.split(' · ')))].join(' · '),
  }));
  const timeline = db.prepare(`
    SELECT ac.ticket_id, ac.type, ac.detail, ac.created_at, u.name AS actor_name, u.role AS actor_role
    FROM activity ac JOIN users u ON u.id = ac.actor_id
    WHERE ac.ticket_id IN (${[ticket.id, ...nodeIds].join(',')}) ORDER BY ac.created_at, ac.id`).all();
  const visibleTimeline=timeline.filter(e=>{if(e.type!=='linked')return true;const m=e.detail.match(/Linked to T-(\d+)/);if(!m)return false;const other=db.prepare('SELECT * FROM tickets WHERE id=?').get(Number(m[1]));return other&&canRead(req.user,other);});
  res.json({ ticket:{...ticket,sla:sla(ticket)}, links, timeline:visibleTimeline });
});

const {ownership} = require('./collaboration')(app,{currentUser,canSeeAll,getTicketScoped});
require('./portal')(app); // simulated supplier portal: token links for external threads
const {escalate}=require('./travel').setup(app,{currentUser,canSeeAll,getTicketScoped,ownership});

// --- Status flow: New -> Open -> Pending -> Escalated -> Resolved -> Closed ---
app.post('/api/tickets/:id/status', currentUser, (req, res) => {
  if(!isOps(req.user))return res.status(403).json({error:'Only ops users change status'});
  const { ticket, error } = getTicketScoped(req, parseInt(req.params.id, 10));
  if (error) return res.status(error).json({ error: 'Ticket not found or not accessible' });
  const next = String((req.body || {}).status || '');
  const note = String((req.body || {}).note || '').slice(0, 500);
  if (!STATUSES.includes(next)) return res.status(400).json({ error: `Status must be one of ${STATUSES.join(', ')}` });
  if(next==='Escalated'){if(!canSeeAll(req.user))return res.status(403).json({error:'Only ops users escalate'});const r=escalate(ticket,req.user.id,note);return res.status(r.code||200).json(r);}
  if (next === ticket.status) return res.status(400).json({ error: `Already ${next}` });
  db.prepare("UPDATE tickets SET status=?,completed_at=CASE WHEN ? IN('Resolved','Closed') THEN COALESCE(completed_at,datetime('now')) ELSE NULL END,updated_at=datetime('now') WHERE id=?").run(next,next,ticket.id);
  // Escalated was handled above as an atomic EM handover.
  const type = 'status_changed';
  logActivity(ticket.id, req.user.id, type, `${ticket.status} -> ${next}${note ? ': ' + note : ''}`);
  res.json({ id: ticket.id, status: next });
});


// Manual assignment and automatic routing share one atomic ownership audit.
app.post('/api/tickets/:id/assign', currentUser, (req,res)=>{
 if(!canSeeAll(req.user))return res.status(403).json({error:'Only ops users assign tickets'});
 const {ticket:t,error}=getTicketScoped(req,Number(req.params.id));
 if(error)return res.status(error).json({error:'Ticket not accessible'});
 const b=req.body||{},id=b.agent_id;
 const target=id===null?null:db.prepare("SELECT * FROM users WHERE id=? AND role IN('agent','em','lead')").get(Number(id));
 if(id!==null&&!target)return res.status(400).json({error:'Choose an ops owner or explicit null to unassign'});
 const action=id===null?'Unassigned':`${t.assigned_to?'Reassigned':'Assigned'} to ${target.name}`;
 const reason=`${action}; manual by ${req.user.name}${typeof b.reason==='string'&&b.reason.trim()?': '+b.reason.trim().slice(0,300):''}`;
 ownership(t,id===null?null:target.id,req.user.id,reason);
 res.json({id:t.id,assigned_to:id===null?null:target.id,assigned_to_name:target?.name||null,reason});
});

// --- Manual link ---
app.post('/api/tickets/:id/links', currentUser, (req, res) => {
  if(!isOps(req.user))return res.status(403).json({error:'Only ops users link tickets'});
  const { ticket, error } = getTicketScoped(req, parseInt(req.params.id, 10));
  if (error) return res.status(error).json({ error: 'Ticket not found or not accessible' });
  const otherId = parseInt((req.body || {}).ticket_id, 10);
  const reason = String((req.body || {}).reason || '').trim().slice(0, 160) || 'Manually linked';
  const other = db.prepare('SELECT * FROM tickets WHERE id=?').get(otherId);
  if (!other || other.id === ticket.id) return res.status(400).json({ error: 'Choose another existing ticket' });
  if (other.agency_id !== ticket.agency_id) return res.status(400).json({ error: 'Cases stay within one agency: cross-agency links would leak data between agencies' });
  if (!canRead(req.user,other)) return res.status(403).json({ error: 'Not your agency\'s ticket' });
  linkTickets(ticket.id, other.id, reason, req.user.id);
  res.json({ id: ticket.id, linked_to: other.id, reason });
});

require('./data-access')(app,{currentUser});

const PORT = process.env.PORT || 4173;
if (require.main === module) {
  app.listen(PORT, () => {
    const { MODE } = require('./auth');
    if (MODE === 'firebase') {
      console.log(`OpsDesk listening on http://localhost:${PORT}`);
      console.log('[auth] SECURED mode: Firebase-verified sign-in required; X-User-Id demo header is rejected.');
    } else {
      console.log(`OpsDesk listening on http://localhost:${PORT}`);
      console.log('[auth] WARNING: running the IMPERSONABLE offline demo auth (X-User-Id header selects any user).');
      console.log('[auth] This is intentional for the offline hackathon demo. For verified sign-in run: npm run start:secured');
    }
  });
}
module.exports = app;
