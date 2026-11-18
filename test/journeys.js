// End-to-end walk of the five demo journeys (A to E) against the demo seed.
// Drives the real server over HTTP as the same demo users the README script uses.
process.env.OPSDESK_DB = require('path').join(require('os').tmpdir(), 'opsdesk-journeys-' + Date.now() + '.db');
process.env.PORT = '0';
require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, '..', 'seed.js'), '--demo'], { stdio: 'pipe', env: process.env });
const assert = require('assert');
const app = require('../server');
const { sla } = require('../sla');
const { db } = require('../db');

const server = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = u => ({ 'Content-Type': 'application/json', 'X-User-Id': String(u) });
  const get = (u, p) => fetch(base + p, { headers: H(u) });
  const post = (u, p, b) => fetch(base + p, { method: 'POST', headers: H(u), body: JSON.stringify(b || {}) });
  let pass = 0;
  const ok = (name, v) => { assert(v, name); pass++; console.log('  ok - ' + name); };
  const ANANYA = 1, ROHIT = 2, MEERA = 3, ARJUN = 4, PRIYA = 5, OMAR = 6, INGRID = 7;
  try {
    console.log('Journey A - context and linkage');
    let r = await post(PRIYA, '/api/tickets', { title: 'Refund query for TBOH-88213', description: 'Refund still not received for the cancelled Dubai tour.', agency_id: 1, tboh: 'TBOH-88213', priority: 'P2', intent_id: 'refund_delay' });
    const a = await r.json();
    ok('A: requester creates a refund ticket (status ' + r.status + ')', r.status === 201 || r.status === 200);
    const aid = a.id || (a.ticket && a.ticket.id);
    const ad = await (await get(ANANYA, '/api/tickets/' + aid)).json();
    ok('A: agent sees the three earlier contacts on the same booking', [1001, 1002, 1003].every(id => ad.links.some(l => (l.id || l.ticket_id || l.other_id) === id || JSON.stringify(l).includes('T-' + id) || JSON.stringify(l).includes(String(id)))));
    ok('A: link reasons name the booking', ad.links.every(l => String(l.reason).includes('TBOH-88213')));
    ok('A: intent is classified as refund delay', (ad.ticket || ad).intent_id === 'refund_delay');

    console.log('Journey B - routing');
    r = await post(OMAR, '/api/tickets', { title: 'Urgent: group cancellation terms', description: 'Need cancellation terms for TBOH-90210 before check-in.', agency_id: 2, tboh: 'TBOH-90299', priority: 'P1', intent_id: 'cancellation', check_in_date: new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10) });
    const b = await r.json(); const bid = b.id || (b.ticket && b.ticket.id);
    r = await post(ARJUN, '/api/tickets/' + bid + '/route');
    const route = await r.json();
    ok('B: auto-route assigns the MEA agent (Rohit)', route.assigned_to === ROHIT);
    ok('B: routing reason names region, priority and load', /MEA region match/.test(route.reason) && /P1/.test(route.reason) && /load/.test(route.reason));
    const au = await (await get(ARJUN, '/api/tickets/' + bid + '/routing')).json();
    ok('B: reason is stored in the routing audit', au.audit.some(x => x.reason === route.reason));
    await post(ARJUN, '/api/routing/agents/2', { available: false });
    r = await post(ARJUN, '/api/tickets/' + bid + '/route');
    const re = await r.json();
    ok('B: with Rohit unavailable the next route falls back and says so', /fallback|region/.test(re.reason) && re.assigned_to === ANANYA);
    await post(ARJUN, '/api/routing/agents/2', { available: true });

    console.log('Journey C - side conversation survives a transfer');
    const th = await (await get(ANANYA, '/api/tickets/1008/threads')).json();
    const threads = th.threads || th;
    ok('C: seeded ticket 1008 has an external supplier thread', threads.length === 1 && threads[0].visibility === 'external');
    const t1 = await (await get(ANANYA, '/api/tickets/1008/threads/' + threads[0].id)).json();
    const names = t1.recipients.map(x => x.name).sort().join(',');
    ok('C: recipients are the supplier desk and the requester (' + names + ')', t1.recipients.length === 2 && /Skyline Travels supplier desk/.test(names) && /Priya Menon/.test(names));
    ok('C: ticket already changed owner from Rohit to Ananya', db.prepare('SELECT assigned_to FROM tickets WHERE id=1008').get().assigned_to === ANANYA && db.prepare('SELECT COUNT(*) n FROM routing_audit WHERE ticket_id=1008').get().n >= 2);
    ok('C: supplier reply arrived through the portal path', t1.messages.some(m => m.via === 'portal'));
    await post(ARJUN, '/api/tickets/1008/assign', { agent_id: ROHIT, reason: 'demo: second transfer' });
    r = await post(ROHIT, '/api/tickets/1008/threads/' + threads[0].id + '/messages', { body: 'Taking this back after the handover, voucher received.' });
    ok('C: new owner can post to the thread (status ' + r.status + ')', r.status === 201 || r.status === 200);
    const t2 = await (await get(ROHIT, '/api/tickets/1008/threads/' + threads[0].id)).json();
    ok('C: recipients unchanged after the second transfer', t2.recipients.map(x => x.id).sort().join() === t1.recipients.map(x => x.id).sort().join());
    ok('C: last message snapshot lists the same two recipients', JSON.parse(t2.messages[t2.messages.length - 1].recipient_snapshot).length === 2);
    ok('C: requester on the thread can read it', (await get(PRIYA, '/api/tickets/1008/threads/' + threads[0].id)).status === 200);
    ok('C: another agency cannot reach the ticket', (await get(OMAR, '/api/tickets/1008')).status >= 403);

    console.log('Journey D - SLA, escalate, work from the queue');
    const lead = await (await get(ARJUN, '/api/lead')).json();
    ok("D: lead view shows 3 tickets at risk or breached (" + lead.counts.at_risk + " at risk, " + lead.counts.breached + " breached)", lead.counts.at_risk === 2 && lead.counts.breached === 1);
    const seven = await (await get(ANANYA, '/api/tickets/1007')).json();
    const s7 = sla((seven.ticket || seven));
    ok('D: ticket 1007 is near check-in and not on track (' + s7.state + ')', s7.state !== 'on_track');
    const q0 = await (await get(MEERA, '/api/tickets')).json();
    const q0t = q0.tickets || q0;
    ok('D: Escalation Manager queue starts with the seeded ticket 1009', q0t.length === 1 && q0t[0].id === 1009);
    r = await post(ANANYA, '/api/tickets/1007/escalate', { reason: 'Check-in in two days, agency needs terms today' });
    const es = await r.json();
    ok('D: agent escalates 1007 to the Escalation Manager (' + r.status + ')', r.status === 200 && es.assigned_to === MEERA && es.work_queue === 'escalation');
    const q1 = await (await get(MEERA, '/api/tickets')).json();
    ok('D: queue now holds 1007 and 1009', (q1.tickets || q1).map(t => t.id).sort().join() === '1007,1009');
    ok('D: Escalation Manager cannot open a non-escalated ticket', (await get(MEERA, '/api/tickets/1004')).status >= 403);
    r = await post(MEERA, '/api/tickets/1009/status', { status: 'Pending', note: 'Letter requested from supplier, chasing every hour' });
    ok('D: Escalation Manager works the ticket (' + r.status + ')', r.status === 200);
    const tl = await (await get(MEERA, '/api/tickets/1007')).json();
    ok('D: escalation is a first-class timeline event', tl.timeline.some(e => e.type === 'escalated'));

    console.log('Journey E - insights and export');
    const ins = await (await get(ARJUN, '/api/insights')).json();
    const themes = ins.themes || ins.groups || [];
    ok('E: insights list themes for this week (' + themes.length + ')', themes.length >= 3);
    ok('E: ops theme tags show up (refund delay counted from a tagged ticket)', themes.some(t => t.id === 'refund_delay' && t.count >= 1));
    ok('E: requesters cannot open insights', (await get(PRIYA, '/api/insights')).status === 403);
    const cv = ins.conversation;
    ok('E: conversation insights are present with coverage', cv && cv.coverage.tickets_read >= 9 && cv.coverage.with_thread_messages >= 2);
    const refundTheme = cv.themes.find(t => t.id === 'refund_delay');
    const s1002 = refundTheme && refundTheme.samples.find(x => x.id === 1002);
    ok('E: ticket 1002 is hand-tagged "other" but its wording says refund delay, flagged not tagged yet with evidence', s1002 && s1002.not_tagged === true && s1002.evidence.length > 0);
    const inv = cv.themes.find(t => t.id === 'inventory_sync');
    ok('E: inventory sync theme for 1006 is read from the side conversation', inv && inv.samples.some(x => x.id === 1006 && x.from_thread));
    ok('E: recurring phrase across tickets is surfaced (supplier allotment)', cv.recurring_phrases.some(p => p.phrase === 'supplier allotment' && p.tickets >= 2));
    ok('E: ambiguous tickets abstain instead of forcing a theme', cv.coverage.abstained >= 1);
    const fb2 = await (await get(ARJUN, '/api/tickets/1002/feedback')).json();
    ok('E: suggestions never change saved tags', JSON.stringify(fb2.themes) === JSON.stringify(['other']));
    ok('E: EM sees conversation insights only for the escalation queue', (await (await get(MEERA, '/api/insights')).json()).conversation.coverage.tickets_in_week <= 2);
    // Scale guard: link fan-out is capped (same agency + intent links at most 5 recent open tickets).
    let last;
    for (let i = 0; i < 8; i++) last = await (await post(PRIYA, '/api/tickets', { title: 'Visa letter query ' + i, description: 'Visa support letter has not arrived', agency_id: 1, priority: 'P3', intent_id: 'documentation' })).json();
    ok('Scale: intent links are capped at 5 per new ticket (got ' + last.linked.length + ')', last.linked.length > 0 && last.linked.length <= 5);
    const csv = await (await get(ARJUN, '/api/exports/tickets.csv')).text();
    const rows = csv.trim().split('\n').length - 1;
    ok('E: CSV export returns every ticket (' + rows + ' rows)', rows >= 10);
    ok('E: data policy is exposed to ops', (await get(ARJUN, '/api/data-policy')).status === 200);

    console.log('\njourneys: ' + pass + ' checks passed');
    server.close(); process.exit(0);
  } catch (e) { console.error('FAIL:', e.message); server.close(); process.exit(1); }
});
