// Simulated supplier portal (demo-only).
//
// An ops user creates a token link for a supplier recipient of an external side
// thread. Opening the link shows that ONE thread and accepts replies as that
// supplier contact. The token is the capability: anyone holding the link acts as
// the supplier. That is labeled on the page and acceptable for this offline
// synthetic demo - there is no real portal and nothing leaves OpsDesk.
//
// Deliberate data minimization: the portal view carries only the thread subject,
// a ticket reference, and sanitized messages (author display name, body, time).
// No recipient lists, no internal threads, no ticket fields, no user accounts.
const { db } = require('./db');
const realtime = require('./realtime');

const TOKEN_RE = /^[0-9a-f]{48}$/;

module.exports = (app) => {
  function linkByToken(token) {
    const tok = String(token || '');
    if (!TOKEN_RE.test(tok)) return null;
    return db.prepare(`SELECT pl.thread_id, pl.contact_id, st.ticket_id, st.subject, c.name AS contact_name
      FROM portal_links pl
      JOIN side_threads st ON st.id = pl.thread_id
      JOIN side_contacts c ON c.id = pl.contact_id
      WHERE pl.token = ? AND st.visibility = 'external'`).get(tok);
  }

  function threadJson(link) {
    const messages = db.prepare(`SELECT m.id, m.via, m.body, m.created_at, u.name AS ops_name, c.name AS contact_name
      FROM side_messages m
      LEFT JOIN users u ON u.id = m.author_id
      LEFT JOIN side_contacts c ON c.id = m.author_contact_id
      WHERE m.thread_id = ? ORDER BY m.id`).all(link.thread_id)
      .map(m => ({ id: m.id, via: m.via, author: m.ops_name || m.contact_name || 'OpsDesk', body: m.body, created_at: m.created_at }));
    return { subject: link.subject, ticket_ref: 'T-' + link.ticket_id, contact_name: link.contact_name, messages, simulation: true };
  }

  app.get('/portal/api/:token', (req, res) => {
    const link = linkByToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'Unknown or expired portal link' });
    res.json(threadJson(link));
  });

  app.post('/portal/api/:token/messages', (req, res) => {
    const link = linkByToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'Unknown or expired portal link' });
    const body = typeof (req.body || {}).body === 'string' ? req.body.body.trim() : '';
    if (!body || body.length > 2000) return res.status(400).json({ error: 'Message required, at most 2000 characters' });
    const recipients = db.prepare('SELECT c.* FROM side_recipients r JOIN side_contacts c ON c.id = r.contact_id WHERE r.thread_id = ? ORDER BY c.id').all(link.thread_id);
    db.prepare("INSERT INTO side_messages (thread_id, author_id, author_contact_id, via, body, recipient_snapshot) VALUES (?, NULL, ?, 'portal', ?, ?)")
      .run(link.thread_id, link.contact_id, body, JSON.stringify(recipients));
    realtime.publish(link.ticket_id, 'thread_reply'); // wakes ops dashboards live
    res.status(201).json(threadJson(link));
  });

  app.get('/portal/:token', (req, res) => {
    if (!linkByToken(req.params.token)) return res.status(404).send('Unknown or expired portal link.');
    res.send(PAGE);
  });
};

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Supplier portal (simulated) · OpsDesk</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f4f5f7; color: #1f2937; }
  header { background: #fff; border-bottom: 1px solid #e5e7eb; padding: 12px 20px; }
  .brand { font-weight: 700; }
  .banner { background: #fffbeb; border: 1px solid #f59e0b; color: #92400e; border-radius: 8px; padding: 8px 12px; margin: 14px auto; max-width: 720px; font-size: 13px; }
  main { max-width: 720px; margin: 0 auto; padding: 0 16px 40px; }
  h1 { font-size: 19px; margin: 10px 0 2px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 14px; }
  .msg { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
  .msg.portal { border-left: 3px solid #0d9488; }
  .msg .meta { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
  .msg p { margin: 0; white-space: pre-wrap; }
  form { margin-top: 16px; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 14px; }
  textarea { width: 100%; min-height: 80px; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; font: inherit; box-sizing: border-box; }
  button { margin-top: 8px; background: #0d9488; color: #fff; border: 0; border-radius: 8px; padding: 8px 16px; font: inherit; cursor: pointer; }
  .err { color: #b91c1c; font-size: 13px; margin-top: 6px; }
</style>
</head>
<body>
<header><span class="brand">OpsDesk supplier portal</span></header>
<div class="banner">Simulated portal for demo purposes only. This is not a real supplier system; messages stay inside the OpsDesk demo and nothing is emailed or sent anywhere.</div>
<main>
  <h1 id="subject">Loading…</h1>
  <div class="sub" id="refline"></div>
  <div id="messages"></div>
  <form id="replyForm">
    <textarea id="replyBody" maxlength="2000" required placeholder="Write a reply as the supplier contact…"></textarea>
    <button type="submit">Send reply</button>
    <div class="err" id="err" hidden></div>
  </form>
</main>
<script>
const token = location.pathname.split('/').pop();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (s) => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
let lastId = 0;
async function load() {
  const res = await fetch('/portal/api/' + token);
  if (!res.ok) { document.getElementById('subject').textContent = 'Unknown or expired portal link.'; return; }
  const d = await res.json();
  document.getElementById('subject').textContent = d.subject;
  document.getElementById('refline').textContent = 'Ticket ' + d.ticket_ref + ' · replying as ' + d.contact_name + ' (simulated)';
  document.getElementById('messages').innerHTML = d.messages.map(m =>
    '<div class="msg ' + (m.via === 'portal' ? 'portal' : '') + '"><div class="meta"><strong>' + esc(m.author) + '</strong>' +
    (m.via === 'portal' ? ' · via portal' : ' · OpsDesk') + ' · ' + fmt(m.created_at) + '</div><p>' + esc(m.body) + '</p></div>').join('');
  if (d.messages.length) lastId = d.messages[d.messages.length - 1].id;
}
document.getElementById('replyForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = document.getElementById('err');
  err.hidden = true;
  const body = document.getElementById('replyBody').value;
  const res = await fetch('/portal/api/' + token + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
  if (!res.ok) { const d = await res.json().catch(() => ({})); err.textContent = d.error || 'Could not send'; err.hidden = false; return; }
  document.getElementById('replyBody').value = '';
  await load();
});
load();
setInterval(load, 10000);
</script>
</body>
</html>`;
