/* Real-time dashboard sync: authenticated fetch() streaming (SSE format) with a
   polling fallback. Credentials travel ONLY in request headers (Authorization:
   Bearer in secured mode, X-User-Id in demo mode) - never in the URL, so tokens
   cannot leak through access logs or browser history. Each connection is
   role-scoped server-side: org roles receive all ticket events, requesters only
   their own created tickets. Event payloads carry only {ticket id, activity
   type}; the client re-fetches its own scoped views. The server bounds each
   stream (55 min, under the 1-hour Firebase token lifetime); on stream end the
   client reconnects with a fresh token (firebase.getIdToken() auto-refreshes
   near expiry), so live access tracks credential validity. If streaming keeps
   failing (old browser, proxy buffering), this module falls back to 15s
   authenticated polling and the header badge shows "Polling". */
let _pollTimer = null, _failures = 0, _running = false, _connecting = false, _controller = null;

function rtIndicator(state) {
  const el = document.getElementById('liveIndicator');
  if (!el) return;
  el.textContent = state;
  el.className = 'live ' + (state === 'Live' ? 'on' : 'off');
  el.title = state === 'Live' ? 'Real-time sync connected (authenticated stream)'
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

function rtHandleBlock(block) {
  let event = '', data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (event === 'hello') {
    _failures = 0;
    rtIndicator('Live');
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  } else if (event === 'ticket') {
    _failures = 0;
    try { rtRefresh(JSON.parse(data).ticket); } catch { rtRefresh(); }
  }
  // 'bye' (server max-age): the stream ends; the read loop exits and reconnects.
}

async function rtAuthHeaders(forceRefresh) {
  if (firebaseMode()) {
    let tok = authToken();
    if (window.firebase && firebase.auth() && firebase.auth().currentUser) {
      try { tok = await firebase.auth().currentUser.getIdToken(!!forceRefresh); setAuthToken(tok); } catch { /* keep stored token */ }
    }
    return { Authorization: 'Bearer ' + (tok || '') };
  }
  return { 'X-User-Id': me() || '' };
}

async function rtConnect(forceRefreshed) {
  if (_connecting || !_running) return;
  _connecting = true;
  try {
    _controller = new AbortController();
    const res = await fetch('/api/events', { headers: await rtAuthHeaders(forceRefreshed), signal: _controller.signal });
    if ((res.status === 401 || res.status === 403) && firebaseMode() && !forceRefreshed && window.firebase && firebase.auth().currentUser) {
      // Stored token expired or is inside the server's expiry margin: force one refresh and retry.
      _connecting = false;
      return rtConnect(true);
    }
    if (res.status === 401 || res.status === 403) { rtIndicator('Offline'); _running = false; return; } // signed out / expired
    if (!res.ok || !res.body || !res.body.getReader) throw new Error('stream unavailable');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        rtHandleBlock(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    if (!_running) return;
    throw new Error('stream ended'); // server max-age bound or drop: reconnect below
  } catch (e) {
    if (!_running) return;
    _failures++;
    rtIndicator('Reconnecting');
    if (_failures >= 3) { rtStartPolling(); return; }
    setTimeout(rtConnect, 2000 * _failures);
  } finally {
    _connecting = false;
  }
}

function rtStop() {
  _running = false;
  if (_controller) { try { _controller.abort(); } catch { /* already closed */ } _controller = null; }
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  _failures = 0;
  rtIndicator('Offline');
}

function rtStart() {
  if (_running) return;
  _running = true;
  if (typeof ReadableStream === 'undefined' || !authed()) { rtStartPolling(); return; }
  rtConnect();
}
