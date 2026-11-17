// Stage-1 smoke test: boots the real server against a temp DB and exercises the API.
process.env.OPSDESK_DB = require('path').join(require('os').tmpdir(), 'opsdesk-smoke-' + Date.now() + '.db');
process.env.PORT = '0';
const { execSync } = require('child_process');
execSync('node ' + require('path').join(__dirname, '..', 'seed.js'), { stdio: 'pipe', env: process.env });
const app = require('../server');
const assert = require('assert');

const server = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const H = (u) => ({ 'Content-Type': 'application/json', 'X-User-Id': String(u) });
  const J = (r) => r.json();
  let pass = 0;
  const ok = (name, cond) => { assert(cond, name); pass++; console.log('  ok -', name); };

  try {
    const boot = await fetch(base + '/api/bootstrap').then(J);
    ok('bootstrap lists users/agencies/intents', boot.users.length === 7 && boot.agencies.length === 3 && boot.intents.length >= 8);

    // 1. Seeded case: T-1003 is linked to the two earlier refund contacts.
    const d = await fetch(base + '/api/tickets/1003', { headers: H(1) }).then(J);
    ok('refund case has 2 linked tickets', d.links.length === 2);
    ok('link reason names the booking', d.links.every(l => l.reason.includes('TBOH-88213')));
    ok('timeline records creation', d.timeline.some(e => e.type === 'created'));

    // 2. Auto-link on create: a fourth contact about the same refund joins the case.
    const created = await fetch(base + '/api/tickets', {
      method: 'POST', headers: H(5),
      body: JSON.stringify({
        title: 'Fourth contact: same refund TBOH-88213', description: 'Refund still not received, client furious.',
        tboh: 'TBOH-88213', priority: 'P1', intent_id: 'refund_delay', check_in_date: '2026-11-21',
      }),
    }).then(J);
    ok('new ticket auto-linked to all 3 prior contacts', created.linked.length === 3);
    const dNew = await fetch(base + '/api/tickets/' + created.id, { headers: H(1) }).then(J);
    ok('case view shows 3 linked from the new ticket', dNew.links.length === 3);
    ok('link events on the timeline', dNew.timeline.filter(e => e.type === 'linked').length >= 3);

    // 3. Agency scoping: Skyline requester cannot see Desert Rose tickets.
    const priya = await fetch(base + '/api/tickets', { headers: H(5) }).then(J);
    ok('requester sees only own agency', priya.tickets.length > 0 && priya.tickets.every(t => t.agency_name === 'Skyline Travels'));
    const forbidden = await fetch(base + '/api/tickets/1004', { headers: H(5) });
    ok('requester blocked from another agency ticket (403)', forbidden.status === 403);

    // 4. Status flow + timeline.
    const st = await fetch(base + '/api/tickets/1003/status', { method: 'POST', headers: H(1), body: JSON.stringify({ status: 'Open', note: 'Picked up' }) }).then(J);
    ok('status moves New -> Open', st.status === 'Open');
    const d2 = await fetch(base + '/api/tickets/1003', { headers: H(1) }).then(J);
    ok('status change logged on timeline', d2.timeline.some(e => e.type === 'status_changed' && e.detail.includes('New -> Open')));

    // 5. Assignment logs to the timeline.
    await fetch(base + '/api/tickets/1003/assign', { method: 'POST', headers: H(1), body: JSON.stringify({ agent_id: 2 }) }).then(J);
    const d3 = await fetch(base + '/api/tickets/1003', { headers: H(1) }).then(J);
    ok('assignment logged', d3.ticket.assigned_to_name === 'Rohit Sharma' && d3.timeline.some(e => e.type === 'assigned'));

    // 6. Rules-based intent suggestion.
    const sug = await fetch(base + '/api/intents/suggest', { method: 'POST', headers: H(1), body: JSON.stringify({ title: 'Refund not received for cancelled tour', description: 'agency wants money back' }) }).then(J);
    ok('suggests refund_delay with confidence', sug.intent_id === 'refund_delay' && sug.confidence > 0);

    // 7. Validation rejects bad input.
    const bad = await fetch(base + '/api/tickets', { method: 'POST', headers: H(1), body: JSON.stringify({ title: 'x', priority: 'P9', intent_id: 'nope', agency_id: 1 }) });
    ok('invalid create rejected (400)', bad.status === 400);

    // 8. Persistence: a fresh connection to the same file still sees the queue.
    const { db: db2 } = (() => { delete require.cache[require.resolve('../db')]; return require('../db'); })();
    ok('tickets persist on disk', db2.prepare('SELECT COUNT(*) c FROM tickets').get().c >= 8);


    // 9. Transitive case: A-B and B-C manually linked puts A, B, C in ONE case.
    const mk = (title) => fetch(base + '/api/tickets', {
      method: 'POST', headers: H(1),
      body: JSON.stringify({ title, description: 'chain test', agency_id: 2, tboh: '', priority: 'P3', intent_id: 'other' }),
    }).then(J).then(r => r.id);
    const A = await mk('Chain ticket alpha'), B = await mk('Chain ticket bravo'), C = await mk('Chain ticket charlie');
    await fetch(base + `/api/tickets/${A}/links`, { method: 'POST', headers: H(1), body: JSON.stringify({ ticket_id: B, reason: 'chain test' }) });
    await fetch(base + `/api/tickets/${B}/links`, { method: 'POST', headers: H(1), body: JSON.stringify({ ticket_id: C, reason: 'chain test' }) });
    const caseA = await fetch(base + '/api/tickets/' + A, { headers: H(1) }).then(J);
    const caseIds = caseA.links.map(l => l.id);
    ok('transitive case shows A, B, C from A', caseIds.includes(B) && caseIds.includes(C) && caseA.links.length === 2);

    // 10. Cross-agency links are refused, so cases cannot leak between agencies.
    const cross = await fetch(base + '/api/tickets/1001/links', { method: 'POST', headers: H(1), body: JSON.stringify({ ticket_id: 1004, reason: 'should fail' }) });
    ok('cross-agency link refused (400)', cross.status === 400);
    const dAgency = await fetch(base + '/api/tickets/1001', { headers: H(5) }).then(J);
    ok('requester case view carries only own-agency tickets', dAgency.links.every(l => l.reason && !String(l.title).includes('charged twice')));

    console.log(`\nAll ${pass} smoke checks passed.`);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
});
