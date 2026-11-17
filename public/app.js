/* OpsDesk stage 1: linked tickets + shared case timeline (PS MVP-1) on a JSON API.
   Demo auth: a user picker stores the demo user id in localStorage and sends it as X-User-Id.
   ?as=<userId> preselects a demo user (documented demo convenience, not security). */
const $app = document.getElementById('app');
const $who = document.getElementById('whoami');
let boot = null;

function me() { return parseInt(localStorage.getItem('opsdesk_user') || '', 10) || null; }
function setMe(id) { id ? localStorage.setItem('opsdesk_user', id) : localStorage.removeItem('opsdesk_user'); }

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': me() || '' },
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

function renderWho() {
  const u = userById(me());
  $who.innerHTML = u
    ? `<span><strong>${esc(u.name)}</strong> · ${u.role === 'requester' ? 'Agency: ' + esc(u.agency_name) : u.role.toUpperCase()}</span>
       <button class="btn small" onclick="setMe(null);route()">Switch user</button>`
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
  const groups = [['agent', 'Ops agents'], ['em', 'Escalation manager'], ['lead', 'Ops lead'], ['requester', 'Agency requesters']];
  $app.innerHTML = `<div class="login-wrap">
    <h1>Choose a demo user</h1>
    <p class="sub" style="color:var(--ink2)">Demo auth for the hackathon, as the brief allows. Requesters only see their own agency's tickets.</p>
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
async function viewQueue() {
  const u = userById(me());
  const { tickets } = await api('/tickets');
  const statuses = ['all', 'New', 'Open', 'Pending', 'Escalated', 'Resolved', 'Closed'];
  const shown = tickets.filter(t =>
    queueFilter === 'all' ? true : queueFilter === 'mine' ? t.assigned_to === u.id : t.status === queueFilter);
  $app.innerHTML = `
    <div class="page-head">
      <div><h1>${u.role === 'requester' ? esc(u.agency_name) + ' tickets' : 'Triage queue'}</h1>
      <div class="sub">${shown.length} of ${tickets.length} tickets · cases link repeat contacts automatically</div></div>
      <a class="btn primary" href="#/new">+ New ticket</a>
    </div>
    <div class="chips">
      ${statuses.map(s => `<span class="chip ${queueFilter === s ? 'on' : ''}" onclick="queueFilter='${s}';viewQueue()">${s === 'all' ? 'All' : s}</span>`).join('')}
      ${u.role !== 'requester' ? `<span class="chip ${queueFilter === 'mine' ? 'on' : ''}" onclick="queueFilter='mine';viewQueue()">My queue</span>` : ''}
    </div>
    <div class="queue">${shown.length ? shown.map(ticketRow).join('') : '<div class="empty">No tickets in this view.</div>'}</div>`;
  renderWho();
}

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
          <dt>Owner</dt><dd>${esc(t.assigned_to_name) || 'Unassigned'}</dd>
        </dl>
        <p style="font-size:13px;color:var(--ink2);line-height:1.55">${esc(t.description)}</p>
        <div class="actions">
          <select class="f" id="statusSel" style="padding:7px 10px">
            ${['Open', 'Pending', 'Escalated', 'Resolved', 'Closed'].filter(s => s !== t.status).map(s => `<option>${s}</option>`).join('')}
          </select>
          <button class="btn" onclick="changeStatus(${t.id})">Move status</button>
          ${u.role !== 'requester' ? `
          <select class="f" id="assignSel" style="padding:7px 10px">
            <option value="">Unassigned</option>
            ${opsUsers.map(x => `<option value="${x.id}" ${t.assigned_to === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
          </select>
          <button class="btn" onclick="assign(${t.id})">Set owner</button>` : ''}
        </div>
        <div class="actions">
          <select class="f" id="linkSel" style="padding:7px 10px">
            ${others.map(x => `<option value="${x.id}">${tid(x.id)} · ${esc(x.title.slice(0, 50))}</option>`).join('')}
          </select>
          <input class="f" id="linkReason" placeholder="Link reason (e.g. same supplier issue)" style="padding:7px 10px">
          <button class="btn" onclick="addLink(${t.id})">Link ticket</button>
        </div>
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
    </div>`;
  renderWho();
}

async function viewNew() {
  const u = userById(me());
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
    box.innerHTML = `<strong>Manual selection needed.</strong> ${esc(s.reason)}. Your current selection is unchanged. Review: ${(s.alternatives || []).map(a => esc(a.label)).join(' / ')}.`;
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

async function changeStatus(id) {
  const status = document.getElementById('statusSel').value;
  const note = prompt('Optional note for the timeline:') || '';
  await api(`/tickets/${id}/status`, { method: 'POST', body: { status, note } });
  viewTicket(id);
}
async function assign(id) {
  const v = document.getElementById('assignSel').value;
  await api(`/tickets/${id}/assign`, { method: 'POST', body: { agent_id: v === '' ? null : parseInt(v, 10) } });
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
  if (qs.get('as')) { setMe(parseInt(qs.get('as'), 10)); }
  if (!boot) boot = await api('/bootstrap');
  renderWho();
  const h = location.hash || '#/queue';
  if (!me()) return viewLogin();
  if (h.startsWith('#/ticket/')) return viewTicket(parseInt(h.split('/')[2], 10));
  if (h === '#/new') return viewNew();
  return viewQueue();
}
window.addEventListener('hashchange', route);
route();
