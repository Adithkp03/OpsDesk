/* Webhooks admin, CSAT after resolve, macro suggestions. Layered on the existing
   views by wrapping their entry points (viewTicket, appendCollaboration, renderWho,
   viewQueue for the two new hash routes). Everything here is local/simulated:
   no email is sent, webhooks only reach this machine, macros only fill drafts. */
(function () {
  const isOpsUser = () => ['agent', 'em', 'lead'].includes(userById(me()).role);

  // ---- nav ----
  const _renderWho = renderWho;
  renderWho = function () {
    _renderWho();
    if (!isOpsUser() || !$who.innerHTML) return;
    $who.insertAdjacentHTML('afterbegin', `<a class="navlink" href="#/csat">CSAT</a><a class="navlink" href="#/webhooks">Webhooks</a>`);
  };

  // ---- routes (route() falls through to viewQueue for unknown hashes) ----
  const _viewQueue = viewQueue;
  viewQueue = function () {
    if (location.hash === '#/webhooks') return viewWebhooks();
    if (location.hash === '#/csat') return viewCsat();
    return _viewQueue.apply(this, arguments);
  };

  // ---- CSAT card on the ticket ----
  const _viewTicket = viewTicket;
  viewTicket = async function (id) {
    await _viewTicket(id);
    const grid = document.querySelector('.detail-grid');
    if (!grid) return;
    if (!document.getElementById('csat')) grid.insertAdjacentHTML('beforebegin', '<div id="csat" style="margin:0 0 16px"></div>');
    await renderCsat(id);
  };

  async function renderCsat(id) {
    const box = document.getElementById('csat'); if (!box) return;
    let d; try { d = await api(`/tickets/${id}/csat`); } catch { box.innerHTML = ''; return; }
    const ops = isOpsUser(), s = d.surveys;
    if (!s.length) { box.innerHTML = ''; return; }
    if (ops) {
      box.innerHTML = `<div class="card"><h2>Customer satisfaction (CSAT)</h2><p class="sub">Requested in-app when the ticket was resolved. Simulated, no email is sent.</p>${s.map(x => `<div class="csat-row"><span class="badge ${x.status}">${esc(x.status)}</span> ${x.status === 'answered' ? `<strong>${x.score}/5</strong> from ${esc(x.requester_name)}${x.comment ? ` - "${esc(x.comment)}"` : ''}` : x.status === 'pending' ? `Waiting for ${esc(x.requester_name)}` : 'Voided because the ticket was reopened'} <span class="sub">${fmtTs(x.answered_at || x.requested_at)}</span></div>`).join('')}</div>`;
      return;
    }
    const open = s.find(x => x.status === 'pending'), done = s.find(x => x.status === 'answered');
    if (open) {
      box.innerHTML = `<div class="card csat-card"><h2>How did we do?</h2><p class="sub">This ticket is resolved. One quick rating helps the team. (Demo: shown here in the app, nothing is emailed.)</p>
        <div class="csat-scale" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="csat-score" value="${n}"><span>${n}</span></label>`).join('')}</div>
        <div class="csat-legend"><span>Poor</span><span>Great</span></div>
        <label class="f">Comment (optional)<textarea class="f" id="csat-comment" maxlength="1000"></textarea></label>
        <button class="btn primary" onclick="submitCsat(${id})">Send rating</button><div class="error-box" id="csat-error" hidden></div></div>`;
    } else if (done) {
      box.innerHTML = `<div class="card csat-card"><h2>Thanks for rating</h2><p>You rated this ticket <strong>${done.score}/5</strong>.${done.comment ? ` "${esc(done.comment)}"` : ''}</p></div>`;
    } else box.innerHTML = '';
  }
  window.submitCsat = async function (id) {
    const v = document.querySelector('input[name="csat-score"]:checked');
    const err = document.getElementById('csat-error');
    if (!v) { err.hidden = false; err.textContent = 'Pick a rating from 1 to 5.'; return; }
    try { await api(`/tickets/${id}/csat`, { method: 'POST', body: { score: Number(v.value), comment: document.getElementById('csat-comment').value } }); await viewTicket(id); }
    catch (e) { err.hidden = false; err.textContent = e.message; }
  };

  // ---- macros in the thread reply forms ----
  const _appendCollaboration = appendCollaboration;
  appendCollaboration = async function (id) {
    await _appendCollaboration(id);
    if (!isOpsUser()) return;
    let d; try { d = await api(`/tickets/${id}/macro-suggestions`); } catch { return; }
    const forms = document.querySelectorAll('#collab form[onsubmit^="replyThread"]');
    if (!forms.length) return;
    const hint = d.conversation_intent
      ? `The conversation reads as <strong>${esc(d.conversation_intent.label)}</strong>, but the ticket intent is <strong>${esc(d.ticket_intent.label)}</strong>. Check the intent before replying.`
      : d.intent_unclear ? 'Intent is unclear from the conversation. Pick the macro that fits, or write your own.' : `Suggestions follow the ticket intent: <strong>${esc(d.ticket_intent.label)}</strong>.`;
    forms.forEach(form => {
      const m = form.getAttribute('onsubmit').match(/replyThread\(event,(\d+),(\d+)\)/); if (!m) return;
      const ta = form.querySelector('textarea');
      const bar = document.createElement('div'); bar.className = 'macro-bar';
      bar.innerHTML = `<div class="sub">${hint}</div><div class="macro-pick"><select class="f macro-sel" aria-label="Suggested macros">${d.suggestions.map(s => `<option value="${s.macro_id}">${esc(s.name)} - ${esc(s.reason)}</option>`).join('') || '<option value="">No macros match</option>'}</select><button type="button" class="btn small macro-go">Fill draft</button></div><div class="sub macro-note">Draft only. Edit it, then press the send button yourself.</div>`;
      form.insertBefore(bar, form.firstChild);
      bar.querySelector('.macro-go').onclick = async () => {
        const sel = bar.querySelector('.macro-sel').value; if (!sel) return;
        try {
          const r = await api(`/tickets/${id}/macros/${sel}/draft`, { method: 'POST', body: {} });
          if (ta.value.trim() && !confirm('Replace the text in this reply with the macro draft?')) return;
          ta.value = r.text; ta.focus();
          bar.querySelector('.macro-note').textContent = r.unresolved.length ? `Draft only. Fill in the [bracketed] gaps (${r.unresolved.join(', ')}) before sending.` : 'Draft only. Edit it, then press the send button yourself.';
        } catch (e) { alert(e.message); }
      };
    });
  };

  // ---- Webhooks admin ----
  window.viewWebhooks = async function () {
    if (!isOpsUser()) { $app.innerHTML = '<div class="empty">Ops only.</div>'; return; }
    const lead = userById(me()).role === 'lead';
    let w, dl;
    try { [w, dl] = await Promise.all([api('/webhooks'), api('/webhooks/deliveries')]); } catch (e) { $app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const sample = location.origin + '/webhook-sink';
    $app.innerHTML = `<div class="page-head"><div><h1>Webhooks</h1><p class="sub">Ticket create and update events, signed and retried. <strong>Local test only:</strong> deliveries can only go to this machine (localhost, 127.0.0.1, ::1). Payloads carry ids and state, never titles, messages or names.</p></div></div>
    <div id="wh-secret"></div>
    <div class="card"><h2>Endpoints</h2>
    ${w.endpoints.length ? `<table class="wh-table"><tr><th>URL</th><th>Events</th><th>State</th><th>Delivered</th><th>Pending</th><th>Failed</th>${lead ? '<th></th>' : ''}</tr>${w.endpoints.map(e => `<tr><td>${esc(e.url)}<br><span class="sub">${esc(e.description)}</span></td><td>${e.events.map(x => `<span class="badge intent">${esc(x)}</span>`).join(' ')}</td><td>${e.active ? 'Active' : 'Paused'}</td><td>${e.delivered}</td><td>${e.pending}</td><td>${e.failed}</td>${lead ? `<td class="wh-actions"><button class="btn small" onclick="whAct(${e.id},'test')">Send test</button><button class="btn small" onclick="whAct(${e.id},'${e.active ? 'pause' : 'resume'}')">${e.active ? 'Pause' : 'Resume'}</button><button class="btn small" onclick="whAct(${e.id},'rotate')">Rotate secret</button><button class="btn small danger" onclick="whAct(${e.id},'delete')">Delete</button></td>` : ''}</tr>`).join('')}</table>` : '<p class="sub">No endpoints yet.</p>'}
    ${lead ? `<form class="stack" onsubmit="whCreate(event)"><h3>Add endpoint</h3><label class="f">URL<input id="wh-url" class="f" required value="${esc(sample)}"></label><label class="f">Note<input id="wh-desc" class="f" maxlength="120" placeholder="What receives this?"></label><div class="wh-events"><label><input type="checkbox" id="wh-ev-c" checked> ticket.created</label><label><input type="checkbox" id="wh-ev-u" checked> ticket.updated</label></div><div><button class="btn primary">Create endpoint</button></div><div class="error-box" id="wh-error" hidden></div><p class="sub">The built-in receiver at ${esc(sample)} checks the signature, so you can see the whole flow offline. Add <code>?fail=2</code> to make it refuse the first two attempts and watch the retries. Only leads can change endpoints.</p></form>` : '<p class="sub">Only leads can add or change endpoints. You can read the delivery log.</p>'}</div>
    <div class="card" style="margin-top:16px"><h2>Delivery log</h2><p class="sub">At-least-once, not ordered. Up to ${dl.max_attempts} attempts with growing waits. Use the event id to de-duplicate.</p>
    ${dl.deliveries.length ? `<table class="wh-table"><tr><th>#</th><th>Event</th><th>Ticket</th><th>Status</th><th>Attempts</th><th>Last result</th><th>When</th>${lead ? '<th></th>' : ''}</tr>${dl.deliveries.map(d => `<tr><td>${d.id}</td><td>${esc(d.event)}</td><td>${d.ticket_id ? tid(d.ticket_id) : ''}</td><td><span class="badge ${d.status}">${esc(d.status)}</span></td><td>${d.attempts}</td><td>${esc(d.last_error || (d.last_status ? 'HTTP ' + d.last_status : ''))}</td><td>${fmtTs(d.created_at)}</td>${lead ? `<td>${d.status === 'failed' ? `<button class="btn small" onclick="whRedeliver(${d.id})">Redeliver</button>` : ''}</td>` : ''}</tr>`).join('')}</table>` : '<p class="sub">No deliveries yet.</p>'}</div>`;
  };
  window.whCreate = async function (ev) {
    ev.preventDefault();
    const events = [document.getElementById('wh-ev-c').checked && 'ticket.created', document.getElementById('wh-ev-u').checked && 'ticket.updated'].filter(Boolean);
    try {
      const r = await api('/webhooks', { method: 'POST', body: { url: document.getElementById('wh-url').value, description: document.getElementById('wh-desc').value, events } });
      await viewWebhooks(); showSecret(r.secret, 'Endpoint created.');
    } catch (e) { const b = document.getElementById('wh-error'); b.hidden = false; b.textContent = e.message; }
  };
  function showSecret(secret, lead) {
    document.getElementById('wh-secret').innerHTML = `<div class="card secret-note"><strong>${esc(lead)} Signing secret (shown once):</strong> <code>${esc(secret)}</code><p class="sub">Receivers verify <code>X-OpsDesk-Signature</code>: HMAC-SHA256 of "timestamp.body". This is a local test secret; do not paste it into chat.</p></div>`;
  }
  window.whAct = async function (id, act) {
    try {
      if (act === 'delete') { if (!confirm('Delete this endpoint and its delivery log?')) return; await api('/webhooks/' + id, { method: 'DELETE' }); }
      else if (act === 'test') await api(`/webhooks/${id}/test`, { method: 'POST', body: {} });
      else if (act === 'pause' || act === 'resume') await api(`/webhooks/${id}/active`, { method: 'POST', body: { active: act === 'resume' } });
      else if (act === 'rotate') { const r = await api(`/webhooks/${id}/rotate-secret`, { method: 'POST', body: {} }); await viewWebhooks(); showSecret(r.secret, 'Secret rotated.'); return; }
      await viewWebhooks();
      if (act === 'test') setTimeout(viewWebhooks, 1200);
    } catch (e) { alert(e.message); }
  };
  window.whRedeliver = async function (id) { try { await api(`/webhooks/deliveries/${id}/redeliver`, { method: 'POST', body: {} }); setTimeout(viewWebhooks, 800); } catch (e) { alert(e.message); } };

  // ---- CSAT summary ----
  window.viewCsat = async function () {
    if (!isOpsUser()) { $app.innerHTML = '<div class="empty">Ops only.</div>'; return; }
    let s; try { s = await api('/csat/summary'); } catch (e) { $app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const max = Math.max(1, ...s.distribution.map(d => d.count));
    $app.innerHTML = `<div class="page-head"><div><h1>Customer satisfaction</h1><p class="sub">Requester ratings after tickets are resolved. Simulated in-app prompts, no email.</p></div></div>
    <div class="csat-stats"><div class="card"><div class="stat">${s.average ?? '-'}</div><div class="sub">Average (of 5)</div></div><div class="card"><div class="stat">${s.answered}/${s.requested}</div><div class="sub">Answered</div></div><div class="card"><div class="stat">${s.response_rate === null ? '-' : s.response_rate + '%'}</div><div class="sub">Response rate</div></div><div class="card"><div class="stat">${s.pending}</div><div class="sub">Waiting</div></div></div>
    <div class="detail-grid" style="margin-top:16px"><div class="card"><h2>Scores</h2>${s.distribution.slice().reverse().map(d => `<div class="bar-row"><span>${d.score}</span><div class="bar"><i style="width:${d.count / max * 100}%"></i></div><span>${d.count}</span></div>`).join('')}</div>
    <div class="card"><h2>By intent</h2>${s.by_intent.length ? s.by_intent.map(x => `<div class="csat-row">${esc(x.label)} <strong>${x.average}</strong> <span class="sub">${x.responses} response${x.responses > 1 ? 's' : ''}</span></div>`).join('') : '<p class="sub">No responses yet.</p>'}<h2 style="margin-top:14px">By owner</h2>${s.by_owner.length ? s.by_owner.map(x => `<div class="csat-row">${esc(x.label)} <strong>${x.average}</strong> <span class="sub">${x.responses}</span></div>`).join('') : '<p class="sub">No responses yet.</p>'}</div></div>
    <div class="card" style="margin-top:16px"><h2>Low scores (1-2)</h2>${s.low_scores.length ? s.low_scores.map(x => `<div class="csat-row"><a href="#/ticket/${x.ticket_id}">${tid(x.ticket_id)}</a> ${esc(x.title)} - <strong>${x.score}/5</strong> ${esc(x.requester_name)}${x.comment ? ` - "${esc(x.comment)}"` : ''}</div>`).join('') : '<p class="sub">None.</p>'}</div>`;
  };
})();
