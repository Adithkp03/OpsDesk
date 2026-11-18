// Regression and access-boundary checks for conversation insights, paged queue/filter/export,
// and the automatic link caps. Temp demo DB only; never touches the user's database.
process.env.OPSDESK_DB = require('path').join(require('os').tmpdir(), 'opsdesk-bounds-' + Date.now() + '.db');
process.env.PORT = '0';
require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, '..', 'seed.js'), '--demo'], { stdio: 'pipe', env: process.env });
const assert = require('assert');
const app = require('../server');
const { db } = require('../db');

const server = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = u => ({ 'Content-Type': 'application/json', 'X-User-Id': String(u) });
  const get = (u, p) => fetch(base + p, { headers: H(u) });
  const post = (u, p, b) => fetch(base + p, { method: 'POST', headers: H(u), body: JSON.stringify(b || {}) });
  let pass = 0;
  const ok = (name, v) => { assert(v, name); pass++; console.log('  ok - ' + name); };
  const ANANYA = 1, MEERA = 3, ARJUN = 4, PRIYA = 5, OMAR = 6, INGRID = 7;
  try {
    console.log('Conversation insight access boundaries');
    const lead = await (await get(ARJUN, '/api/insights')).json();
    const leadText = JSON.stringify(lead.conversation);
    ok('lead (organization-wide ops) sees phrases mined from internal threads', leadText.includes('supplier allotment') && lead.conversation.coverage.with_thread_messages >= 2);
    for (const u of [PRIYA, OMAR, INGRID]) ok('requester ' + u + ' cannot open insights (403)', (await get(u, '/api/insights')).status === 403);
    const em = await (await get(MEERA, '/api/insights')).json();
    const escIds = new Set(db.prepare("SELECT id FROM tickets WHERE work_queue='escalation'").all().map(r => r.id));
    const emIds = [];
    for (const th of em.conversation.themes) for (const s of th.samples) emIds.push(s.id);
    for (const p of em.conversation.recurring_phrases) emIds.push(...p.sample_ids);
    ok('EM insight samples and phrase tickets are all escalation-queue tickets', emIds.every(id => escIds.has(id)));
    ok('EM insight reads no more tickets than the escalation queue holds', em.conversation.coverage.tickets_read <= escIds.size);
    const nonEscPhrase = lead.conversation.recurring_phrases.filter(p => p.sample_ids.some(id => !escIds.has(id)));
    ok('phrases that depend on non-escalated tickets do not appear for EM', nonEscPhrase.every(p => !em.conversation.recurring_phrases.some(x => x.phrase === p.phrase && x.tickets >= p.tickets)));
    ok('EM response has no title of a non-escalated ticket', !db.prepare("SELECT title FROM tickets WHERE work_queue<>'escalation'").all().some(r => JSON.stringify(em).includes(r.title)));
    // Requesters never receive internal thread text through any list or suggestion route.
    const reqCalls = [await (await get(PRIYA, '/api/tickets')).text(), await (await get(OMAR, '/api/tickets/1007')).text(), await (await get(OMAR, '/api/tickets/1007/threads')).text(), await (await get(PRIYA, '/api/tickets/1006/threads')).text()];
    const internalBodies = db.prepare("SELECT m.body FROM side_messages m JOIN side_threads st ON st.id=m.thread_id WHERE st.visibility='internal'").all().map(r => r.body.slice(0, 40));
    ok('requesters never receive internal-thread message text or the internal phrase "allotment" (' + internalBodies.length + ' internal messages checked)', internalBodies.length >= 2 && reqCalls.every(t => !/allotment/i.test(t) && internalBodies.every(b => !t.includes(JSON.stringify(b).slice(1, -1)))));
    const rs = await post(OMAR, '/api/tickets/1007/intent-resuggest');
    ok('requester re-suggest on an internal-only thread uses no internal text', !/allotment|refund pending/i.test(await rs.text()));
    ok('mining output carries no message bodies or recipients, only short matched words', !/recipient|body|snapshot/i.test(leadText));

    console.log('Paged queue, filters and export');
    const dbTotal = db.prepare('SELECT COUNT(*) n FROM tickets').get().n;
    const p1 = await (await get(ARJUN, '/api/tickets?limit=4&offset=0')).json();
    const p2 = await (await get(ARJUN, '/api/tickets?limit=4&offset=4')).json();
    const p3 = await (await get(ARJUN, '/api/tickets?limit=4&offset=8')).json();
    const ids = [...p1.tickets, ...p2.tickets, ...p3.tickets].map(t => t.id);
    ok('lead total equals database ticket count', p1.total === dbTotal && p2.total === dbTotal);
    ok('pages are disjoint and together cover the whole queue', new Set(ids).size === ids.length && ids.length === dbTotal);
    ok('has_more is true on a full middle page and false at the end', p1.has_more === true && p3.has_more === (dbTotal > 12));
    const beyond = await (await get(ARJUN, '/api/tickets?limit=4&offset=' + (dbTotal + 50))).json();
    ok('offset beyond the end returns an empty page with total intact', beyond.tickets.length === 0 && beyond.total === dbTotal && beyond.has_more === false);
    ok('limit is clamped (huge -> 1000, negative -> 1) and junk falls back to default', (await (await get(ARJUN, '/api/tickets?limit=99999')).json()).limit === 1000 && (await (await get(ARJUN, '/api/tickets?limit=-5')).json()).limit === 1 && (await (await get(ARJUN, '/api/tickets?limit=abc')).json()).limit === 200);
    const st = db.prepare("SELECT status, COUNT(*) n FROM tickets GROUP BY status").all()[0];
    const fs = await (await get(ARJUN, '/api/tickets?status=' + encodeURIComponent(st.status))).json();
    ok('status filter total matches the database and returns only that status', fs.total === st.n && fs.tickets.every(t => t.status === st.status));
    const sl = await (await get(ARJUN, '/api/tickets?sla=breached')).json();
    const slPaged = [...(await (await get(ARJUN, '/api/tickets?sla=breached&limit=1&offset=0')).json()).tickets];
    ok('clock-based SLA filter applies before paging (total counts all matches, page holds one)', sl.total >= 1 && slPaged.length === 1 && sl.tickets.every(t => t.sla.state === 'breached'));
    const linked = await (await get(ARJUN, '/api/tickets?view=linked')).json();
    ok('linked view only lists tickets that have linked cases', linked.total >= 1 && linked.tickets.every(t => t.link_count > 0));
    const emList = await (await get(MEERA, '/api/tickets?limit=1000')).json();
    ok('EM paged list stays inside the escalation queue', emList.total === escIds.size && emList.tickets.every(t => escIds.has(t.id)));
    const reqList = await (await get(OMAR, '/api/tickets')).json();
    ok('requester paged list stays inside own agency and own tickets', reqList.tickets.every(t => t.created_by === OMAR) && reqList.total === db.prepare('SELECT COUNT(*) n FROM tickets WHERE created_by=?').get(OMAR).n);
    const csv = await (await get(ARJUN, '/api/exports/tickets.csv')).text();
    ok('CSV export is not limited by queue paging (every ticket exported)', csv.trim().split('\n').length - 1 === dbTotal);
    ok('requesters cannot export', (await get(PRIYA, '/api/exports/tickets.csv')).status === 403);

    console.log('Automatic link caps');
    // 25 older tickets with the same booking in agency 1, plus the same booking number in agency 2.
    const ins = db.prepare("INSERT INTO tickets(title,description,agency_id,tboh,priority,intent_id,created_by,status) VALUES(?,?,?,?,?,?,?,?)");
    for (let i = 0; i < 25; i++) ins.run('Older booking contact ' + i, 'x', 1, 'TBOH-CAP-1', 'P3', 'other', PRIYA, 'Open');
    const otherAgency = ins.run('Other agency same booking', 'x', 2, 'TBOH-CAP-1', 'P3', 'other', OMAR, 'Open').lastInsertRowid;
    const a = await (await post(PRIYA, '/api/tickets', { title: 'Booking follow up', description: 'Following up', agency_id: 1, tboh: 'TBOH-CAP-1', priority: 'P3', intent_id: 'other' })).json();
    const rows = db.prepare('SELECT * FROM ticket_links WHERE ticket_id=? OR linked_ticket_id=?').all(a.id, a.id);
    const peers = rows.map(r => r.ticket_id === a.id ? r.linked_ticket_id : r.ticket_id);
    const byBooking = rows.filter(r => /Same booking/.test(r.reason));
    ok('same-booking links are capped at 20 (got ' + byBooking.length + ')', byBooking.length === 20);
    ok('same-booking links never cross the agency boundary (same TBOH in another agency is not linked)', !peers.includes(Number(otherAgency)) && peers.every(id => db.prepare('SELECT agency_id FROM tickets WHERE id=?').get(id).agency_id === 1));
    ok('the 20 same-booking links are the most recent ones', byBooking.every(r => (r.ticket_id === a.id ? r.linked_ticket_id : r.ticket_id) > Number(otherAgency) - 21));
    // Intent links: closed and older-than-90-day tickets are excluded, same agency only.
    const old = ins.run('Old visa case', 'x', 3, '', 'P3', 'documentation', INGRID, 'Open').lastInsertRowid;
    db.prepare("UPDATE tickets SET created_at=datetime('now','-120 days') WHERE id=?").run(old);
    const closed = ins.run('Closed visa case', 'x', 3, '', 'P3', 'documentation', INGRID, 'Closed').lastInsertRowid;
    const fresh = ins.run('Fresh visa case', 'x', 3, '', 'P3', 'documentation', INGRID, 'Open').lastInsertRowid;
    const other = ins.run('Visa case other agency', 'x', 1, '', 'P3', 'documentation', PRIYA, 'Open').lastInsertRowid;
    const b = await (await post(INGRID, '/api/tickets', { title: 'Visa letter again', description: 'Visa letter missing', agency_id: 3, priority: 'P3', intent_id: 'documentation' })).json();
    const lids = db.prepare('SELECT * FROM ticket_links WHERE ticket_id=? OR linked_ticket_id=?').all(b.id, b.id).map(r => r.ticket_id === b.id ? r.linked_ticket_id : r.ticket_id);
    ok('intent links include recent open same-agency tickets', lids.includes(Number(fresh)));
    ok('intent links exclude closed tickets, tickets older than 90 days, and other agencies', !lids.includes(Number(closed)) && !lids.includes(Number(old)) && !lids.includes(Number(other)));
    ok('intent links never exceed 5', lids.length <= 5);

    console.log('\nboundaries: ' + pass + ' checks passed');
    server.close(); process.exit(0);
  } catch (e) { console.error('FAIL:', e.message); server.close(); process.exit(1); }
});
