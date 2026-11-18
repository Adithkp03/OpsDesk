// Local scale and sync benchmark on SYNTHETIC data. Not part of npm test (it takes a minute).
// Usage: node bench/scale.js [ticketCount]   (default 50000)
// It uses its own temp database file and a loopback server. It never touches opsdesk.db.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const N = Number(process.argv[2] || 50000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opsdesk-bench-'));
const DB = path.join(dir, 'bench.db'), PORT = 4300 + Math.floor(Math.random() * 500);
const env = { ...process.env, OPSDESK_DB: DB, PORT: String(PORT) };
const root = path.join(__dirname, '..');
execFileSync('node', ['seed.js', '--wipe'], { cwd: root, env, stdio: 'ignore' });

const t0 = Date.now();
{
  process.env.OPSDESK_DB = DB;
  const { db } = require('../db'); require('../collaboration'); require('../travel');
  const ins = db.prepare("INSERT INTO tickets(id,title,description,agency_id,tboh,priority,intent_id,status,created_by,assigned_to,work_queue,check_in_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const intents = db.prepare('SELECT id FROM intents').all().map(r => r.id);
  const st = ['New', 'Open', 'Pending', 'Resolved', 'Closed'];
  const reqByAgency = { 1: 5, 2: 6, 3: 7 };
  const now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const ag = 1 + (i % 3), pr = ['P1', 'P2', 'P3'][i % 3 === 0 ? 0 : i % 5 === 0 ? 1 : 2];
      const created = new Date(now - (i % (30 * 24)) * 3600000).toISOString().replace('T', ' ').slice(0, 19);
      const status = st[i % 5];
      const chk = new Date(now + ((i % 20) - 4) * 86400000).toISOString().slice(0, 10);
      ins.run(100000 + i, `Synthetic ticket ${i}: refund query for booking`, 'Synthetic benchmark ticket. Refund pending, please confirm the supplier voucher.', ag, 'TBOH-' + (80000 + (i % 4000)), pr, intents[i % intents.length], status, reqByAgency[ag], i % 7 === 0 ? null : 1 + (i % 2), 'operations', chk, created, created);
    }
  })();
  console.log(`seeded ${N} tickets in ${((Date.now() - t0) / 1000).toFixed(2)} s`);
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  console.log(`db file ${(fs.statSync(DB).size / 1e6).toFixed(1)} MB`);
}

const get = (p, uid) => new Promise((resolve, reject) => {
  const t = process.hrtime.bigint(); let bytes = 0;
  http.get({ port: PORT, path: p, headers: { 'X-User-Id': String(uid) } }, res => {
    res.on('data', c => { bytes += c.length; });
    res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t) / 1e6, bytes, status: res.statusCode }));
  }).on('error', reject);
});
const post = (p, uid, body) => new Promise((resolve, reject) => {
  const t = process.hrtime.bigint(); const data = JSON.stringify(body);
  const r = http.request({ port: PORT, path: p, method: 'POST', headers: { 'X-User-Id': String(uid), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ ms: Number(process.hrtime.bigint() - t) / 1e6, status: res.statusCode, body: b }));
  }); r.on('error', reject); r.end(data);
});
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rss = pid => { try { const s = fs.readFileSync(`/proc/${pid}/status`, 'utf8'); return { rss: +/VmRSS:\s+(\d+)/.exec(s)[1] / 1024, peak: +/VmHWM:\s+(\d+)/.exec(s)[1] / 1024 }; } catch { return { rss: NaN, peak: NaN }; } };

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: root, env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await get('/api/whoami', 1); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
  const out = { tickets: N, node: process.version, cpus: os.cpus().length, platform: os.platform() };
  const timed = async (name, p, uid, reps = Number(process.env.BENCH_REPS || 3)) => {
    const r = []; let last;
    for (let i = 0; i < reps; i++) { last = await get(p, uid); r.push(last.ms); }
    out[name] = { status: last.status, ms_median: Math.round(pct(r, 0.5)), ms_max: Math.round(Math.max(...r)), MB: +(last.bytes / 1e6).toFixed(2) };
    console.log(name, JSON.stringify(out[name]));
  };
  await timed('queue_default_page_200', '/api/tickets', 1);
  await timed('queue_page_50', '/api/tickets?limit=50', 1);
  await timed('lead_overview (/api/lead)', '/api/lead', 4);
  await timed('insights (/api/insights)', '/api/insights', 4);
  await timed('export_csv_all', '/api/exports/tickets.csv', 4, 1);
  out.server_memory_MB = rss(srv.pid); console.log('server memory MB', JSON.stringify(out.server_memory_MB));

  // write latency
  const w = [];
  for (let i = 0; i < Number(process.env.BENCH_CREATES || 100); i++) { const r = await post('/api/tickets', 5, { title: 'Bench create ' + i, description: 'Refund pending for booking', agency_id: 1, priority: 'P2', intent_id: 'refund_delay', tboh: 'TBOH-' + (80000 + i) }); w.push(r.ms); if (i === 0 && r.status >= 300) console.log('create status', r.status, r.body.slice(0, 120)); }
  out.create_ticket_ms = { p50: Math.round(pct(w, 0.5)), p95: Math.round(pct(w, 0.95)) }; console.log('create', JSON.stringify(out.create_ticket_ms));

  // realtime fan-out: K SSE clients, change a ticket's status, time to the event arriving at every client
  const K = 50, got = new Map(); let ready = 0; const reqs = [];
  await new Promise(resolve => {
    for (let i = 0; i < K; i++) {
      const r = http.get({ port: PORT, path: '/api/events', headers: { 'X-User-Id': i % 2 ? '1' : '2' } }, res => {
        res.on('data', c => { const s = c.toString(); if (s.includes('event: hello')) { if (++ready === K) resolve(); } const m = /"ticket":(\d+),"type":"([^"]+)"/.exec(s); if (m && s.includes('event: ticket')) got.set(i + ':' + m[1] + m[2], process.hrtime.bigint()); gotCb && gotCb(i, s); });
      }); reqs.push(r);
    }
  });
  var gotCb;
  const lat = [];
  for (let n = 0; n < 20; n++) {
    const id = 100000 + n * 5; const seen = new Set(); let tStart;
    const done = new Promise(res => { gotCb = (i, s) => { if (s.includes('event: ticket') && s.includes(`"ticket":${id},`)) { seen.add(i); if (seen.size === K) res(process.hrtime.bigint()); } }; });
    tStart = process.hrtime.bigint();
    const r = await post(`/api/tickets/${id}/status`, 1, { status: 'Open', note: 'bench' });
    if (r.status >= 300) { console.log('status change failed', r.status, r.body.slice(0, 100)); break; }
    const tEnd = await Promise.race([done, new Promise(res => setTimeout(() => res(null), 5000))]);
    if (tEnd) lat.push(Number(tEnd - tStart) / 1e6);
  }
  out.sse_fanout = { clients: K, samples: lat.length, ms_p50: Math.round(pct(lat, 0.5)), ms_p95: Math.round(pct(lat, 0.95)) }; console.log('sse', JSON.stringify(out.sse_fanout));
  reqs.forEach(r => r.destroy());
  out.server_memory_MB_end = rss(srv.pid);
  srv.kill();
  fs.writeFileSync(path.join(__dirname, 'last-result.json'), JSON.stringify(out, null, 2));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nresult written to bench/last-result.json');
  process.exit(0);
})();
