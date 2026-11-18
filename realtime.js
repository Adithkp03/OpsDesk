// Real-time dashboard sync via Server-Sent Events (zero-dependency; polling fallback in the client).
// Every ticket mutation already funnels through logActivity, so the bus hooks there:
// publish() is called with the ticket id and event type, and each connected client
// receives the event ONLY if that ticket is visible to their role - org roles
// (agent/em/lead) get everything, requesters get events for their own created
// tickets only. The event payload is just {ticket, type, at}; clients re-fetch
// their own scoped views, so no cross-agency data ever travels the stream.
const { db, onActivity } = require('./db');

const clients = new Map(); // res -> { userId, role }
let seq = 0;

// Every ticket mutation funnels through logActivity; republish as live events.
onActivity((ticketId, type) => publish(ticketId, type));

function visibleTo(ticket, user) {
  if (['agent', 'em', 'lead'].includes(user.role)) return true;
  return ticket.created_by === user.userId; // requester scope: own created tickets only
}

function publish(ticketId, type) {
  const t = db.prepare('SELECT id, created_by FROM tickets WHERE id=?').get(ticketId);
  if (!t) return;
  const data = JSON.stringify({ ticket: t.id, type, at: new Date().toISOString() });
  for (const [res, user] of clients) {
    if (!visibleTo(t, user)) continue;
    try { res.write(`id: ${++seq}\nevent: ticket\ndata: ${data}\n\n`); } catch { clients.delete(res); }
  }
}

// Connections are bounded: the server ends each stream after MAX_AGE and the
// client reconnects with a fresh credential. Firebase ID tokens live 1 hour;
// ending at 55 minutes means a stream never outlives the token that authorized
// it, and a revoked/disabled account loses live access at the next reconnect
// (public-cert verification cannot call checkRevoked without a service account).
const MAX_AGE_MS = 55 * 60 * 1000;

function subscribe(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, max_age_ms: MAX_AGE_MS })}\n\n`);
  clients.set(res, { userId: user.id, role: user.role });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 25000);
  const bound = setTimeout(() => {
    try { res.write(`event: bye\ndata: ${JSON.stringify({ reason: 'max_age' })}\n\n`); res.end(); } catch { /* closed */ }
  }, MAX_AGE_MS);
  req.on('close', () => { clearInterval(ping); clearTimeout(bound); clients.delete(res); });
}

function clientCount() { return clients.size; }

module.exports = { publish, subscribe, clientCount };
