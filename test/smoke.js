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

    // 5b. Full status flow chain: New -> Open -> Pending -> Escalated -> Resolved -> Closed.
    // T-1003 is already Open from test 4; walk it the rest of the way.
    for (const s of ['Pending', 'Escalated', 'Resolved', 'Closed']) {
      const r = await fetch(base + '/api/tickets/1003/status', { method: 'POST', headers: H(1), body: JSON.stringify({ status: s, note: s === 'Escalated' ? 'client threatening to leave' : '' }) });
      assert(r.status === 200, 'status move to ' + s + ' accepted');
    }
    const dFlow = await fetch(base + '/api/tickets/1003', { headers: H(1) }).then(J);
    ok('full status chain reaches Closed', dFlow.ticket.status === 'Closed');
    const esc = dFlow.timeline.find(e => e.type === 'escalated');
    ok('escalation is a first-class timeline event with actor and time', !!esc && esc.detail.includes('Pending -> Escalated') && esc.actor_name === 'Ananya Rao' && !!esc.created_at);
    const same = await fetch(base + '/api/tickets/1003/status', { method: 'POST', headers: H(1), body: JSON.stringify({ status: 'Closed' }) });
    ok('no-op status move rejected (400)', same.status === 400);

    // 6. Rules-based intent suggestion.
    const sug = await fetch(base + '/api/intents/suggest', { method: 'POST', headers: H(1), body: JSON.stringify({ title: 'Refund not received for cancelled tour', description: 'agency wants money back' }) }).then(J);
    ok('suggests refund_delay with confidence', sug.intent_id === 'refund_delay' && sug.confidence > 0);
    ok('suggestion lists matched terms', sug.matched.length > 0 && sug.matched.includes('refund'));
    const sugPay = await fetch(base + '/api/intents/suggest', { method: 'POST', headers: H(1), body: JSON.stringify({ title: 'Charged twice on my card', description: '' }) }).then(J);
    ok('suggests payment_issue for card text', sugPay.intent_id === 'payment_issue');
    const sugCx = await fetch(base + '/api/intents/suggest', { method: 'POST', headers: H(1), body: JSON.stringify({ title: 'Please cancel this booking', description: '' }) }).then(J);
    ok('suggests cancellation', sugCx.intent_id === 'cancellation');
    const sugHy = await fetch(base + '/api/intents/suggest', { method: 'POST', headers: H(1), body: JSON.stringify({ title: 'Money-back still not received', description: '' }) }).then(J);
    ok('hyphenated wording still matches (money-back = money back)', sugHy.intent_id === 'refund_delay');
    const sugNone = await fetch(base + '/api/intents/suggest', { method: 'POST', headers: H(1), body: JSON.stringify({ title: 'qz xj wobble', description: 'fnord' }) }).then(J);
    ok('unknown wording abstains instead of choosing an intent', sugNone.intent_id === 'other' && sugNone.abstain === true);

    // 7. Validation rejects bad input.
    const bad = await fetch(base + '/api/tickets', { method: 'POST', headers: H(1), body: JSON.stringify({ title: 'x', priority: 'P9', intent_id: 'nope', agency_id: 1 }) });
    ok('invalid create rejected (400)', bad.status === 400);

    // 8. Persistence: a fresh connection to the same file still sees the queue.
    const { db: db2 } = (() => { delete require.cache[require.resolve('../db')]; return require('../db'); })();
    ok('tickets persist on disk', db2.prepare('SELECT COUNT(*) c FROM tickets').get().c >= 8);


    // 9. Transitive case: A-B and B-C manually linked puts A, B, C in ONE case.
    require('../db').db.prepare("INSERT INTO agencies(id,name,country,region) VALUES (99,'Test agency','IN','APAC')").run();
    const mk = (title, intent_id) => fetch(base + '/api/tickets', {
      method: 'POST', headers: H(1),
      body: JSON.stringify({ title, description: 'chain test', agency_id: 99, tboh: '', priority: 'P3', intent_id }),
    }).then(J).then(r => r.id);
    const A = await mk('Chain ticket alpha', 'documentation'), B = await mk('Chain ticket bravo', 'special_request'), C = await mk('Chain ticket charlie', 'cancellation');
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

    // Held-out phrasings, not copies of the model's training rows.
    const intentCases = [
      ["Do not cancel, only change the dates", 'booking_amendment'],
      ['Not a cancellation but a refund', 'refund_delay'],
      ['No refund needed, cancel the reservation', 'cancellation'],
      ['No need to cancel. Change the guest name', 'booking_amendment'],
      ['Client has been waiting for money back for ten days', 'refund_delay'],
      ['Please arrange wheelchair support at the airport', 'special_request'],
      ['Send the embassy visa letter please', 'documentation'],
      ['Cancel the booking and refund the amount', null],
      ['Card charged but no confirmation and voucher not received', null],
      ['Need a voucher and wheelchair assistance', null],
      ['payment failed and visa letter required', null],
      ['hotel issue', null], ['', null],
      ['Do not cancel the hotel', null], ['do not cancel and do not refund', null],
      ['I am not asking for a refund', null], ['refund refund refund but do not refund', null],
      ['The sky is blue and I like sandwiches', null], ['I have no idea what happened', null],
      ['qzxj zxjx zxjxx unknown sentence', null],
    ];
    for (const [text, want] of intentCases) {
      const r = await fetch(base + '/api/intents/suggest', { method: 'POST', headers: H(1), body: JSON.stringify({ title: text, description: '' }) }).then(J);
      ok('intent regression: ' + text, want ? !r.abstain && r.intent_id === want : r.abstain === true);
    }
    for (const date of ['2026-02-30', '2026-13-02', 'tomorrow']) {
      const r = await fetch(base + '/api/tickets', { method:'POST', headers:H(1), body:JSON.stringify({title:'Invalid date test',agency_id:1,priority:'P2',intent_id:'other',check_in_date:date}) });
      ok('rejects impossible/malformed travel date ' + date, r.status === 400);
    }
    const shared = await fetch(base + '/api/tickets/1001', {headers:H(1)}).then(J);
    ok('case timeline includes events on linked tickets', shared.timeline.some(e => e.ticket_id === 1003 && e.type === 'escalated'));
    ok('timeline events include actor and time', shared.timeline.every(e => e.actor_name && e.created_at));
    const pair = await fetch(base + '/api/tickets/' + A, {headers:H(1)}).then(J);
    ok('transitive nodes have link reasons', pair.links.every(l => l.reason));
    const override = await fetch(base + '/api/tickets', {method:'POST',headers:H(1),body:JSON.stringify({title:'refund delayed but manually classified',agency_id:99,priority:'P2',intent_id:'other',tboh:'MANUAL-1',check_in_date:'2028-02-29',lcd_date:'2028-02-28'})}).then(J);
    const overrideD = await fetch(base + '/api/tickets/'+override.id,{headers:H(1)}).then(J);
    ok('manual taxonomy choice survives model disagreement', overrideD.ticket.intent_id === 'other');
    ok('all travel fields persist including leap date and LCD', overrideD.ticket.check_in_date === '2028-02-29' && overrideD.ticket.lcd_date === '2028-02-28');

    console.log(`\nAll ${pass} smoke checks passed.`);
    process.exit(0);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
});
