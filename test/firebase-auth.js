// Secured-mode authentication: verified bearer token maps to a server-owned users
// row; the X-User-Id demo header is rejected; every existing role/agency rule
// still applies. Uses the documented test-only stub verifier (OPSDESK_TOKEN_STUB=1);
// signature/cert verification against Google's public certs is covered by the
// production verifier reading the same uid, and is exercised live at wiring time.
process.env.OPSDESK_DB = require('path').join(require('os').tmpdir(), 'opsdesk-auth-' + Date.now() + '.db');
process.env.OPSDESK_AUTH_MODE = 'firebase';
process.env.OPSDESK_TOKEN_STUB = '1';
require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, '../seed.js')], { env: process.env });
const assert = require('assert'), app = require('../server'), { db } = require('../db');
let pass = 0; const ok = (n, v) => { assert(v, n); pass++; console.log('  ok - ' + n); };

db.prepare("UPDATE users SET firebase_uid='uid-ananya' WHERE id=1").run();
db.prepare("UPDATE users SET firebase_uid='uid-meera' WHERE id=3").run();
db.prepare("UPDATE users SET firebase_uid='uid-arjun' WHERE id=4").run();
db.prepare("UPDATE users SET firebase_uid='uid-priya' WHERE id=5").run();
db.prepare("INSERT INTO users(id,name,role,agency_id) VALUES(8,'Skyline colleague','requester',1)").run();
db.prepare("UPDATE users SET firebase_uid='uid-colleague' WHERE id=8").run();

const server = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, token, b, raw = false) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(base + '/api' + path, { method: b ? 'POST' : 'GET', headers, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: raw ? await r.text() : await r.json().catch(() => ({})) };
  };
  const demo = async (path) => {
    const r = await fetch(base + '/api' + path, { headers: { 'X-User-Id': '1' } });
    return r.status;
  };
  try {
    const boot = await (await fetch(base + '/api/bootstrap')).json();
    ok('bootstrap announces firebase mode', boot.auth_mode === 'firebase');

    ok('missing token rejected 401', (await call('/tickets', null)).status === 401);
    ok('garbage token rejected 401', (await call('/tickets', 'not-a-token')).status === 401);
    ok('demo header rejected in secured mode', (await demo('/tickets')) === 401);
    ok('demo header rejected on export', (await demo('/exports/tickets.csv')) === 401);
    ok('unprovisioned account rejected 401', (await call('/tickets', 'test-uid-stranger')).status === 401);

    ok('whoami maps token to Priya', (await call('/whoami', 'test-uid-priya')).data.id === 5);
    ok('whoami hides provider uid', !('firebase_uid' in (await call('/whoami', 'test-uid-priya')).data));

    const own = await call('/tickets', 'test-uid-priya');
    ok('requester list only own created tickets', own.status === 200 && own.data.tickets.every(t => t.created_by === 5 && t.agency_id === 1));
    ok('requester cross-agency detail denied', (await call('/tickets/1004', 'test-uid-priya')).status === 403);
    const col = await call('/tickets', 'test-uid-colleague', { title: 'Colleague private ticket', description: 'COLLEAGUE_PRIVATE_BODY', agency_id: 1, tboh: 'TBOH-88213', priority: 'P2', intent_id: 'refund_delay' });
    ok('colleague creates own ticket', col.status === 201);
    ok('requester cannot read same-agency colleague', (await call('/tickets/' + col.data.id, 'test-uid-priya')).status === 403);
    ok('requester cannot change status', (await call('/tickets/1003/status', 'test-uid-priya', { status: 'Resolved' })).status === 403);
    ok('requester cannot escalate', (await call('/tickets/1003/escalate', 'test-uid-priya', { reason: 'probe' })).status === 403);
    ok('requester cannot export', (await call('/exports/tickets.csv', 'test-uid-priya', undefined, true)).status === 403);
    ok('requester cannot lead report', (await call('/lead', 'test-uid-priya')).status === 403);
    ok('requester cannot insights', (await call('/insights', 'test-uid-priya')).status === 403);

    const em = await call('/tickets', 'test-uid-meera');
    ok('EM list restricted to escalation queue', em.status === 200 && em.data.tickets.every(t => t.work_queue === 'escalation'));
    ok('EM direct ordinary ticket denied', (await call('/tickets/1001', 'test-uid-meera')).status === 403);
    ok('EM lead report denied', (await call('/lead', 'test-uid-meera')).status === 403);

    ok('agent org list includes all agencies', (await call('/tickets', 'test-uid-ananya')).data.tickets.some(t => t.agency_id === 2));
    ok('agent lead report denied', (await call('/lead', 'test-uid-ananya')).status === 403);
    const lead = await call('/lead', 'test-uid-arjun');
    ok('lead report allowed for lead', lead.status === 200 && lead.data.counts.total >= 8);

    console.log('All ' + pass + ' secured-auth checks passed.');
    server.close();
  } catch (e) { console.error(e); process.exit(1); }
});
