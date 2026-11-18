/* OpsDesk stage 1: linked tickets + shared case timeline (PS MVP-1) on a JSON API.
   Demo auth: a user picker stores the demo user id in localStorage and sends it as X-User-Id.
   ?as=<userId> preselects a demo user (documented demo convenience, not security). */
const $app = document.getElementById('app');
const $who = document.getElementById('whoami');
let boot = null,preselected=false;

function me() { return parseInt(localStorage.getItem('opsdesk_user') || '', 10) || null; }
function setMe(id) { id ? localStorage.setItem('opsdesk_user', id) : localStorage.removeItem('opsdesk_user'); }
function authToken() { return localStorage.getItem('opsdesk_token') || null; }
function setAuthToken(t) { t ? localStorage.setItem('opsdesk_token', t) : localStorage.removeItem('opsdesk_token'); }
function firebaseMode() { return boot && boot.auth_mode === 'firebase'; }
function authed() { return firebaseMode() ? !!authToken() : !!me(); }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (firebaseMode()) headers.Authorization = 'Bearer ' + (authToken() || '');
  else headers['X-User-Id'] = me() || '';
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || (data.errors || []).join('; ') || res.statusText), { status: res.status, data });
  return data;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tid = (id) => 'T-' + id;
const fmtDate = (s) => s ? new Date(s + (s.length === 10 ? 'T00:00:00Z' : '')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
const fmtTs = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const userById = (id) => (boot.users.find(u => u.id === id) || {});

function signOut() {
  rtStop();
  setMe(null); setAuthToken(null); preselected = true;
  history.replaceState(null, '', location.pathname + location.hash); route();
}

function renderWho() {
  const u = userById(me());
  $who.innerHTML = u.role
    ? `<span><strong>${esc(u.name)}</strong> · ${u.role === 'requester' ? 'Agency: ' + esc(u.agency_name) : u.role.toUpperCase()}</span>
       <button class="btn small" onclick="signOut()">${firebaseMode() ? 'Sign out' : 'Switch user'}</button>`
    : '';
}

function ticketRow(t) {
  return `<div class="ticket-row" onclick="location.hash='#/ticket/${t.id}'">
    <div class="tid">${tid(t.id)}</div>
    <div>
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-meta">
        <span>${esc(t.agency_name)}</span>
        ${t.tboh ? `<span>${esc(t.tboh)}</span>` : ''}
        <span class="badge intent">${esc(t.intent_label)}</span>
        ${t.sla ? slaBadge(t.sla) : ''}<span class="badge">${esc(t.work_queue||'operations')} queue</span>
        ${t.link_count ? `<span class="badge case">Case · ${t.link_count + 1}</span>` : ''}
        ${t.check_in_date ? `<span>Check-in ${fmtDate(t.check_in_date)}</span>` : ''}
        <span>${t.assigned_to_name ? '→ ' + esc(t.assigned_to_name) : 'Unassigned'}</span>
      </div>
    </div>
    <div class="t-right"><span class="badge ${t.priority}">${t.priority}</span><span class="status ${t.status}">${t.status}</span></div>
  </div>`;
}

async function viewLogin() {
  renderWho();
  if (firebaseMode()) {
    $app.innerHTML = `<div class="login-wrap">
      <h1>Sign in to OpsDesk</h1>
      <p class="sub" style="color:var(--ink2)">Verified sign-in (Firebase Authentication, email + password). Roles and agency access are still enforced by this server for every request. All accounts are synthetic demo accounts provisioned by an administrator; self-registration is disabled.</p>
      <div class="form-row" style="max-width:360px;margin:18px auto;text-align:left">
        <label class="f">Email<input class="f" id="loginEmail" type="email" autocomplete="username"></label>
        <label class="f">Password<input class="f" id="loginPassword" type="password" autocomplete="current-password"></label>
        <button class="btn" id="loginBtn" onclick="firebaseLogin()">Sign in</button>
        <div class="error-box" id="loginError" hidden></div>
      </div>
    </div>`;
    return;
  }
  const groups = [['agent', 'Ops agents'], ['em', 'Escalation manager'], ['lead', 'Ops lead'], ['requester', 'Agency requesters']];
  $app.innerHTML = `<div class="login-wrap">
    <h1>Choose a demo user</h1>
    <p class="sub" style="color:var(--ink2)">Demo auth for the hackathon, as the brief allows. Requesters see only tickets they created. Agents see org queues; Escalation Managers see the escalation queue; leads get org reporting. All names and accounts are synthetic.</p>
    ${groups.map(([role, label]) => `
      <p class="section-title" style="margin-top:18px">${label}</p>
      <div class="login-grid">${boot.users.filter(u => u.role === role).map(u => `
        <div class="login-card" onclick="setMe(${u.id});location.hash='#/queue';route()">
          <div class="lc-name">${esc(u.name)}</div>
          <div class="lc-role">${u.role}${u.agency_name ? ' · ' + esc(u.agency_name) : ''}</div>
        </div>`).join('')}
      </div>`).join('')}
  </div>`;
}

let queueFilter = 'all';
async function viewTicket(id) {
  const u = userById(me());
  let data;
  try { data = await api('/tickets/' + id); }
  catch (e) { $app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const { ticket: t, links, timeline } = data;
  const opsUsers = boot.users.filter(x => ['agent', 'em', 'lead'].includes(x.role));
  const others = (await api('/tickets')).tickets.filter(x => x.id !== t.id);
  $app.innerHTML = `
    <div class="page-head">
      <div><h1>${tid(t.id)} · ${esc(t.title)}</h1>
      <div class="sub">Opened ${fmtTs(t.created_at)} by ${esc(t.created_by_name)}</div></div>
      <a class="btn" href="#/queue">← Queue</a>
    </div>
    ${links.length ? `<div class="link-case-banner">This ticket is part of a case with ${links.length} linked ticket${links.length > 1 ? 's' : ''} — repeat contacts stay connected instead of becoming isolated tickets.</div>` : ''}
    <div class="detail-grid">
      <div class="card">
        <dl class="kv">
          <dt>Agency</dt><dd>${esc(t.agency_name)} (${esc(t.agency_country)} · ${esc(t.agency_region)})</dd>
          <dt>Booking</dt><dd>${esc(t.tboh) || '—'}</dd>
          <dt>Intent</dt><dd><span class="badge intent">${esc(t.intent_label)}</span></dd>
          <dt>Priority</dt><dd><span class="badge ${t.priority}">${t.priority}</span></dd>
          <dt>Status</dt><dd><span class="status ${t.status}">${t.status}</span></dd>
          <dt>Check-in</dt><dd>${fmtDate(t.check_in_date)}</dd>
          <dt>Last cancel (LCD)</dt><dd>${fmtDate(t.lcd_date)}</dd>
          <dt>SLA</dt><dd>${slaBadge(t.sla)}<br><small>Due ${esc(new Date(t.sla.deadline).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'})+' UTC')}</small></dd>
          <dt>Queue</dt><dd>${esc(t.work_queue)}</dd>
          <dt>Owner</dt><dd>${esc(t.assigned_to_name) || 'Unassigned'}</dd>
        </dl>
        <p style="font-size:13px;color:var(--ink2);line-height:1.55">${esc(t.description)}</p>
        <div class="sla-policy"><strong>Demo SLA policy</strong><p>${esc(t.sla.reason)}</p><small>${esc(t.sla.policy)}</small></div>
        <div class="actions" style="margin-top:10px"><button class="btn small" onclick="resuggestIntent(${t.id})">Re-check intent from conversation</button></div>
        <div id="intentResuggest"></div>
        <div class="error-box" id="routing-error" hidden></div>
        ${u.role!=='requester'?`<div class="actions">
          <select class="f" id="statusSel" style="padding:7px 10px">
            ${['Open', 'Pending', 'Resolved', 'Closed'].filter(s => s !== t.status).map(s => `<option>${s}</option>`).join('')}
          </select>
          <button class="btn" onclick="changeStatus(${t.id})">Move status</button>
          <select class="f" id="assignSel" style="padding:7px 10px">
            <option value="">Unassigned</option>
            ${opsUsers.map(x => `<option value="${x.id}" ${t.assigned_to === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
          </select>
          <input class="f" id="ownerReason" placeholder="Ownership reason" style="max-width:220px"><button class="btn" onclick="assign(${t.id})">Set owner</button><button class="btn" onclick="autoRoute(${t.id})" ${u.role==='em'?'hidden':''}>Auto-route</button>
        </div>
        <div class="actions"><input class="f" id="escalationReason" placeholder="Reason for Escalation Manager" maxlength="500"><button class="btn danger" id="escalateBtn" onclick="escalateTicket(${t.id})">Escalate to Escalation Manager</button></div><div id="escalationError" class="error-box" hidden></div>
        <div class="actions">
          <select class="f" id="linkSel" style="padding:7px 10px">
            ${others.map(x => `<option value="${x.id}">${tid(x.id)} · ${esc(x.title.slice(0, 50))}</option>`).join('')}
          </select>
          <input class="f" id="linkReason" placeholder="Link reason (e.g. same supplier issue)" style="padding:7px 10px">
          <button class="btn" onclick="addLink(${t.id})">Link ticket</button>
        </div>`:''}
      </div>
      <div>
        <div class="card" style="margin-bottom:16px">
          <div class="section-title">Linked case (${links.length + 1} ticket${links.length ? 's' : ''})</div>
          <div class="case-ticket" style="border-color:var(--teal);cursor:default">
            <div class="ct-title">${tid(t.id)} · ${esc(t.title)}</div>
            <div class="ct-meta"><span class="status ${t.status}">${t.status}</span><span>this ticket</span></div>
          </div>
          ${links.map(l => `
          <div class="case-ticket" onclick="location.hash='#/ticket/${l.id}'">
            <div class="ct-title">${tid(l.id)} · ${esc(l.title)}</div>
            <div class="ct-reason">${esc(l.reason)}</div>
            <div class="ct-meta"><span class="status ${l.status}">${l.status}</span><span>${l.tboh ? esc(l.tboh) + ' · ' : ''}${fmtTs(l.created_at)}</span></div>
          </div>`).join('') || ''}
        </div>
        <div class="card">
          <div class="section-title">Case activity timeline</div>
          <ul class="timeline">
            ${timeline.map(e => `<li class="t-${e.type}">
              <div class="tl-detail">${esc(e.detail)}</div>
              <div class="tl-meta">T-${e.ticket_id} · ${esc(e.actor_name)} · ${fmtTs(e.created_at)}</div>
            </li>`).join('')}
          </ul>
        </div>
      </div>
    </div><div id="feedback" style="margin-top:18px"></div><div id="collab" style="margin-top:18px"></div>`;
  renderWho();
  await appendCollaboration(id);
  if(u.role!=='requester')await renderFeedback(id);
}

async function viewNew() {
  const u = userById(me());
  if(u.role==='em'){$app.innerHTML='<div class="empty">Escalation Managers work tickets handed to the escalation queue. <a href="#/queue">Back to queue</a></div>';return;}
  const isRequester = u.role === 'requester';
  $app.innerHTML = `
    <div class="page-head"><div><h1>New ticket</h1>
    <div class="sub">Intent auto-suggests from the text; you can always override it. New tickets auto-link into existing cases.</div></div>
    <a class="btn" href="#/queue">← Queue</a></div>
    <div id="formErr"></div>
    <form class="stack" onsubmit="return createTicket(event)">
      ${isRequester ? `<input type="hidden" id="f-agency" value="${u.agency_id}">`
        : `<label class="f">Agency<select class="f" id="f-agency">${boot.agencies.map(a => `<option value="${a.id}">${esc(a.name)} (${esc(a.country)})</option>`).join('')}</select></label>`}
      <label class="f">Title<input class="f" id="f-title" maxlength="200" required placeholder="e.g. Refund pending for cancelled booking"></label>
      <label class="f">Description<textarea class="f" id="f-desc" placeholder="What happened, booking details, what the agency needs"></textarea></label>
      <div class="form-row">
        <label class="f">Booking ref (TBOH)<input class="f" id="f-tboh" maxlength="40" placeholder="TBOH-…"></label>
        <label class="f">Priority<select class="f" id="f-priority"><option>P3</option><option>P2</option><option>P1</option></select></label>
      </div>
      <div class="form-row">
        <label class="f">Check-in date<input class="f" id="f-checkin" type="date"></label>
        <label class="f">Last cancellation date (LCD)<input class="f" id="f-lcd" type="date"></label>
      </div>
      <label class="f">Intent
        <select class="f" id="f-intent">${boot.intents.map(i => `<option value="${i.id}" ${i.id === 'other' ? 'selected' : ''}>${esc(i.label)}</option>`).join('')}</select>
      </label>
      <div class="suggest-box" id="suggestBox"></div>
      <div><button type="button" class="btn" onclick="suggest()">Suggest intent from text</button>
      <button class="btn primary" type="submit">Create ticket</button></div>
    </form>`;
  renderWho();
}

async function suggest() {
  const title = document.getElementById('f-title').value;
  const description = document.getElementById('f-desc').value;
  const box = document.getElementById('suggestBox');
  const s = await api('/intents/suggest', { method: 'POST', body: { title, description } });
  box.className = 'suggest-box show';
  if (!s.abstain) {
    document.getElementById('f-intent').value = s.intent_id;
    box.innerHTML = `Suggested: <strong>${esc(s.label)}</strong> (model score ${Math.round(s.confidence * 100)}%, not measured accuracy). Evidence: ${s.matched.map(esc).join(', ')}. Offline example-trained classifier; override anytime.`;
  } else {
    box.innerHTML = `<strong>Manual selection needed.</strong> ${esc(s.reason)}. Your current selection is unchanged.${s.alternatives?.length ? ' Review: ' + s.alternatives.map(a => esc(a.label)).join(' / ') + '.' : ''}`;
  }
}

async function createTicket(ev) {
  ev.preventDefault();
  const body = {
    title: document.getElementById('f-title').value,
    description: document.getElementById('f-desc').value,
    agency_id: parseInt(document.getElementById('f-agency').value, 10),
    tboh: document.getElementById('f-tboh').value,
    priority: document.getElementById('f-priority').value,
    intent_id: document.getElementById('f-intent').value,
    check_in_date: document.getElementById('f-checkin').value || null,
    lcd_date: document.getElementById('f-lcd').value || null,
  };
  try {
    const r = await api('/tickets', { method: 'POST', body });
    location.hash = '#/ticket/' + r.id;
    route();
  } catch (e) {
    document.getElementById('formErr').innerHTML = `<div class="error-box">${esc((e.data.errors || [e.message]).join('<br>'))}</div>`;
  }
  return false;
}

// Feature: conversation-weighted intent. The server aggregates the thread
// messages the caller may read, suggests, and only ops or the ticket creator
// can apply a change (enforced server-side too).
async function resuggestIntent(id) {
  const el = document.getElementById('intentResuggest');
  el.textContent = 'Reading conversation…';
  try {
    const r = await api(`/tickets/${id}/intent-resuggest`, { method: 'POST', body: {} });
    const s = r.suggestion, t = (await api('/tickets/' + id)).ticket;
    const u = userById(me());
    const canApply = u.role !== 'requester' || t.created_by === u.id;
    if (s.abstain) {
      el.innerHTML = `<div class="suggest-box show" style="margin-top:8px"><strong>Manual review.</strong> ${esc(s.reason)}${r.sources.thread_messages_used ? '' : ' No conversation text yet; used title and description only.'}</div>`;
      return;
    }
    el.innerHTML = `<div class="suggest-box show" style="margin-top:8px">Conversation suggests <strong>${esc(s.label)}</strong> (model score ${Math.round(s.confidence * 100)}%, not measured accuracy)${r.sources.thread_messages_used ? ` from ${r.sources.thread_messages_used} recent thread message${r.sources.thread_messages_used > 1 ? 's' : ''}` : ''}. Evidence: ${s.matched.map(esc).join(', ') || '—'}.${r.differs && canApply ? ` <button class="btn small" onclick="applyIntent(${id},'${s.intent_id}')">Apply</button>` : r.differs ? ' Only ops or the ticket creator can apply this.' : ' Matches the current intent.'}</div>`;
  } catch (e) { el.innerHTML = `<div class="error-box">${esc(e.message)}</div>`; }
}
async function applyIntent(id, intentId) {
  try { await api(`/tickets/${id}/intent`, { method: 'POST', body: { intent_id: intentId } }); viewTicket(id); }
  catch (e) { alert(e.message); }
}

async function changeStatus(id) {
  const status = document.getElementById('statusSel').value;
  const note = prompt('Optional note for the timeline:') || '';
  await api(`/tickets/${id}/status`, { method: 'POST', body: { status, note } });
  viewTicket(id);
}
async function addLink(id) {
  const other = parseInt(document.getElementById('linkSel').value, 10);
  const reason = document.getElementById('linkReason').value;
  await api(`/tickets/${id}/links`, { method: 'POST', body: { ticket_id: other, reason } });
  viewTicket(id);
}

async function route() {
  const qs = new URLSearchParams(location.search);
  if (!preselected&&qs.get('as')) { setMe(parseInt(qs.get('as'), 10)); }
  preselected=true;
  if (!boot) boot = await api('/bootstrap');
  renderWho();
  const h = location.hash || '#/queue';
  if (!authed()) return viewLogin();
  if (firebaseMode() && !me()) {
    try { const w = await api('/whoami'); setMe(w.id); renderWho(); }
    catch (e) { setAuthToken(null); return viewLogin(); }
  }
  rtStart();
  if (h.startsWith('#/ticket/')) return viewTicket(parseInt(h.split('/')[2], 10));
  if (h === '#/lead') return viewLead();
  if (h === '#/data') return viewDataPolicy();
  if (h === '#/insights') return viewInsights();
  if (h === '#/new') return viewNew();
  return viewQueue();
}
window.addEventListener('hashchange', route);

// Secured mode: verified sign-in through Firebase Authentication. The provider
// proves identity; this server still enforces role and agency scope per request.
let _fbApp = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load the sign-in library. Check your connection.'));
    document.head.append(s);
  });
}
async function firebaseLogin() {
  const err = document.getElementById('loginError');
  err.hidden = true;
  try {
    if (!window.firebase) {
      await loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js');
    }
    if (!_fbApp) _fbApp = firebase.initializeApp(boot.firebase_client_config);
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const cred = await firebase.auth().signInWithEmailAndPassword(email, password);
    setAuthToken(await cred.user.getIdToken());
    const w = await api('/whoami');
    setMe(w.id);
    location.hash = '#/queue';
    route();
  } catch (e) {
    err.textContent = e && e.code === 'auth/invalid-credential' ? 'Wrong email or password.' : (e.message || 'Sign-in failed');
    err.hidden = false;
  }
}
