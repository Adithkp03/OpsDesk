/* Real-time dashboard sync: Server-Sent Events with a polling fallback.
   EventSource cannot send auth headers, so it passes the same credential as a
   query parameter on /api/events - the only route that accepts it; every other
   API call stays header-strict. Each connection is role-scoped server-side:
   org roles receive all ticket events, requesters only their own created
   tickets. Event payloads carry only {ticket id, activity type}; the client
   re-fetches its own scoped views, so nothing cross-agency travels the stream.
   If the stream keeps failing (old browser, proxy buffering), this module
   falls back to 15s polling and the header badge shows "Polling". */
let _es = null, _pollTimer = null, _failures = 0;

function rtIndicator(state) {
  const el = document.getElementById('liveIndicator');
  if (!el) return;
  el.textContent = state;
  el.className = 'live ' + (state === 'Live' ? 'on' : 'off');
  el.title = state === 'Live' ? 'Real-time sync connected (server-sent events)'
    : state === 'Polling' ? 'Real-time stream unavailable; refreshing every 15s'
    : state === 'Reconnecting' ? 'Real-time stream interrupted; reconnecting' : 'Real-time sync off';
}

function rtRefresh(ticketId) {
  const h = location.hash || '#/queue';
  if (h === '#/queue' || h === '#/') viewQueue();
  const m = /^#\/ticket\/(\d+)/.exec(h);
  if (m && (!ticketId || Number(m[1]) === Number(ticketId))) viewTicket(Number(m[1]));
}

function rtStartPolling() {
  if (_pollTimer) return;
  rtIndicator('Polling');
  _pollTimer = setInterval(() => { if (authed()) rtRefresh(); }, 15000);
}

function rtStop() {
  if (_es) { _es.close(); _es = null; }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _failures = 0;
  rtIndicator('Offline');
}

function rtStart() {
  if (_es || _pollTimer) { if (_es) rtIndicator('Live'); return; }
  if (typeof EventSource === 'undefined' || !authed()) { rtStartPolling(); return; }
  const q = firebaseMode()
    ? 'token=' + encodeURIComponent(authToken() || '')
    : 'user=' + encodeURIComponent(me() || '');
  const es = new EventSource('/api/events?' + q);
  _es = es;
  es.addEventListener('hello', () => {
    _failures = 0;
    rtIndicator('Live');
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  });
  es.addEventListener('ticket', (ev) => {
    _failures = 0;
    try { rtRefresh(JSON.parse(ev.data).ticket); } catch { rtRefresh(); }
  });
  es.onerror = () => {
    _failures++;
    rtIndicator('Reconnecting');
    if (_failures >= 3) { es.close(); _es = null; rtStartPolling(); }
  };
}
