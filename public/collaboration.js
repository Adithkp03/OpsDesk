// MVP2+3 UI: explicit ownership and independent side-conversation audiences.
let queueRegion='', queueIntent='',queueSla='';
async function routingPanel(){
 const {agents}=await api('/routing/agents');
 return `<div class="card" style="margin-bottom:16px"><div class="section-title">Routing signals · simulated availability</div><p class="sub">Available agents first, then agency region match, then lowest active load. Queue ranked P1 → P2 → P3. No FIFO/LIFO-only routing.</p><div class="chips">${agents.map(a=>`<button class="btn small" onclick="toggleAvailability(${a.user_id},${!a.available})">${esc(a.name)} · ${esc(a.regions.join('/'))} · ${a.load} active · ${a.available?'Available':'Away'} (toggle)</button>`).join('')}</div></div>`;
}
async function toggleAvailability(id,available){try{await api('/routing/agents/'+id,{method:'POST',body:{available}});await viewQueue();}catch(e){alert(e.message);}}
async function viewQueue(){
 const u=userById(me()),isOps=u.role!=='requester';
 const params=new URLSearchParams();
 if(['triage','mine','linked','escalation','operations'].includes(queueFilter))params.set('view',queueFilter);
 if(queueRegion)params.set('region',queueRegion);
 if(queueIntent)params.set('intent',queueIntent);
 if(queueSla)params.set('sla',queueSla);
 const {tickets}=await api('/tickets?'+params);
 const statuses=u.role==='em'?['escalation','mine','linked','New','Open','Pending','Escalated','Resolved','Closed']:['all','triage','mine','linked','New','Open','Pending','Escalated','Resolved','Closed','operations','escalation'];
 const shown=['New','Open','Pending','Escalated','Resolved','Closed'].includes(queueFilter)?tickets.filter(t=>t.status===queueFilter):tickets;
 $app.innerHTML=`<div class="page-head"><div><h1>${isOps?(u.role==='em'?'Escalation Manager queue':queueFilter==='triage'?'Triage · unassigned':queueFilter==='mine'?'My queue':queueFilter==='linked'?'Linked cases':queueFilter==='escalation'?'Escalation Manager queue':queueFilter==='operations'?'Operations queue':'All tickets'):'My tickets · '+esc(u.agency_name)}</h1><div class="sub">${shown.length} tickets · ranked by priority P1 → P2 → P3</div></div>${isOps?'<a class="btn" href="#/insights">Weekly insights</a>':''}${u.role==='lead'?'<a class="btn" href="#/lead">Lead overview</a>':''}${u.role!=='em'?'<a class="btn primary" href="#/new">+ New ticket</a>':''}</div>
 <div class="role-scope">${esc(({requester:'Your created tickets only. Colleague tickets and other agencies are not accessible.',agent:'Agent access: organization queues and ticket actions.',em:'Escalation Manager access: escalation-queue tickets only, with escalation and hand-back actions.',lead:'Lead access: organization queues, lead overview, insights and data export.'})[u.role])}</div>${['agent','lead'].includes(u.role)?await routingPanel():''}
 <div class="chips">${statuses.filter(s=>isOps||!['triage','mine','escalation','operations'].includes(s)).map(s=>`<button class="chip ${queueFilter===s?'on':''}" onclick="queueFilter='${s}';viewQueue()">${({all:'All tickets',triage:'Triage (unassigned)',mine:'My queue',linked:'Linked cases',operations:'Operations queue',escalation:'Escalation Manager queue'})[s]||s}</button>`).join('')}</div>
 <div class="form-row" style="margin:12px 0"><label class="f">By region<select class="f" id="queueRegion" onchange="queueRegion=this.value;viewQueue()"><option value="">All regions</option>${[...new Set(boot.agencies.map(a=>a.region))].map(r=>`<option ${r===queueRegion?'selected':''}>${esc(r)}</option>`).join('')}</select></label><label class="f">By intent<select class="f" id="queueIntent" onchange="queueIntent=this.value;viewQueue()"><option value="">All intents</option>${boot.intents.map(i=>`<option value="${i.id}" ${i.id===queueIntent?'selected':''}>${esc(i.label)}</option>`).join('')}</select></label></div>
 <div class="sla-toolbar"><label class="f">SLA health<select class="f" id="queueSla" onchange="queueSla=this.value;viewQueue()"><option value="">All SLA states</option>${['on_track','at_risk','breached','completed'].map(v=>`<option value="${v}" ${queueSla===v?'selected':''}>${v.replace('_',' ')}</option>`).join('')}</select></label><small>Calendar hours from creation. Check-in / LCD can shorten the deadline. Refreshes every minute.</small></div>
 ${isOps?'<div class="export-tools"><button id="exportTickets" class="btn" onclick="downloadTickets()">Export matching tickets · CSV</button><a class="btn" href="#/data">Data retention & archive policy</a><span id="exportResult" role="status"></span></div>':''}<div class="queue">${shown.length?shown.map(ticketRow).join(''):'<div class="empty">No tickets in this view.</div>'}</div>`;
 renderWho();
}
async function autoRoute(id){try{const r=await api(`/tickets/${id}/route`,{method:'POST',body:{}});await viewTicket(id);}catch(e){const box=document.getElementById('routing-error');if(box){box.hidden=false;box.textContent=e.message;box.scrollIntoView({block:'center'});}else alert(e.message);}}
async function assign(id){try{const v=document.getElementById('assignSel').value;const reason=document.getElementById('ownerReason')?.value||'';await api(`/tickets/${id}/assign`,{method:'POST',body:{agent_id:v===''?null:Number(v),reason}});if(userById(me()).role==='em'&&(v===''||userById(Number(v)).role!=='em')){queueFilter='all';location.hash='#/queue';await viewQueue();const note=document.createElement('div');note.className='role-scope';note.textContent='Handed back to operations. This ticket is no longer in your escalation scope.';$app.prepend(note);}else await viewTicket(id);}catch(e){alert(e.message);}}
async function appendCollaboration(id){
 const u=userById(me()),isOps=u.role!=='requester';
 const {threads}=await api(`/tickets/${id}/threads`);
 const contacts=isOps?(await api(`/tickets/${id}/side-contacts`)).contacts:[];
 const audit=isOps?(await api(`/tickets/${id}/routing`)).audit:[];
 if(!document.getElementById('collab'))return;
 document.getElementById('collab').innerHTML=`${isOps?`<div class="card"><div class="section-title">Ownership & routing audit</div>${audit.length?audit.map(a=>`<p>${esc(a.reason)}<br><span class="sub">${esc(a.actor_name)} · ${fmtTs(a.created_at)}</span></p>`).join(''):'<p class="sub">No routing changes recorded yet.</p>'}</div>`:''}
 <div class="card" style="margin-top:16px"><h2>Side conversations</h2><p class="sub">Demo simulation only. Nothing is emailed or sent outside OpsDesk. Each thread keeps its explicit audience after ownership changes.</p>
 ${threads.length?threads.map(th=>`<section class="thread" data-thread-id="${th.id}"><div class="section-title">${th.visibility==='internal'?'Internal note · ops only':'External reply · simulated'} | ${esc(th.subject)}</div><div class="audience"><strong>To:</strong> ${th.recipients.map(c=>`${esc(c.name)} &lt;${esc(c.address)}&gt;`).join(', ')}</div>${isOps&&th.visibility==='external'&&th.recipients.some(c=>c.kind==='supplier')?`<div class="portal-links">${th.recipients.filter(c=>c.kind==='supplier').map(c=>`<button class="btn small" data-name="${esc(c.name)}" onclick="portalLink(this,${id},${th.id},${c.id})">Portal link · ${esc(c.name)}</button>`).join('')}<span class="sub">opens the simulated supplier portal for this thread; links expire 72h after creation and can be revoked</span></div>`:''}${th.messages.map(m=>`<div class="side-message"><strong>${esc(m.author_name)}</strong>${m.via==='portal'?' <span class="badge portal">via portal</span>':''} <span class="sub">${fmtTs(m.created_at)}</span><p>${esc(m.body)}</p><small>Fixed audience: ${m.recipients.map(c=>esc(c.name)).join(', ')}</small></div>`).join('')}<form onsubmit="replyThread(event,${id},${th.id})"><label class="f">Reply to this thread<textarea class="f" id="reply-${th.id}" required maxlength="5000"></textarea></label><button class="btn" type="submit">${th.visibility==='internal'?'Add internal note':'Add simulated external reply'}</button></form></section>`).join(''):'<p>No conversations visible to this user.</p>'}
 ${isOps?`<form class="stack new-thread" onsubmit="createThread(event,${id})"><h3>New side conversation</h3><label class="f">Subject<input id="thread-subject" class="f" required maxlength="160"></label><label class="f">Visibility<select id="thread-visibility" class="f" onchange="filterRecipients()"><option value="internal">Internal note (ops only)</option><option value="external">External reply (simulated)</option></select></label><fieldset><legend>Explicit recipients (never inferred from ticket owner)</legend>${contacts.map(c=>`<label class="recipient" data-kind="${c.kind}"><input type="checkbox" name="thread-recipient" value="${c.id}"> ${esc(c.name)} · ${esc(c.kind)} <small>${esc(c.address)}</small></label>`).join('')}</fieldset><label class="f">Message<textarea id="thread-body" class="f" required maxlength="5000"></textarea></label><button class="btn primary">Create conversation</button><div id="thread-error" class="error-box" hidden></div></form>`:''}</div>`;
 if(isOps)filterRecipients();
}
// Simulated supplier portal: create (or fetch the existing) token link for one
// supplier recipient of this thread and copy it. The link is a capability -
// whoever opens it can reply as the supplier on the demo page.
async function portalLink(btn,ticketId,threadId,contactId){
 btn.disabled=true;
 try{
  const r=await api(`/tickets/${ticketId}/threads/${threadId}/portal-links`,{method:'POST',body:{contact_id:contactId}});
  const url=location.origin+r.url;
  const note=url+' (simulated portal - demo only; expires '+fmtTs(r.expires_at)+')';
  const offerRevoke=()=>{
   if(btn.parentElement.querySelector('.portal-revoke'))return;
   const rv=document.createElement('button');rv.className='btn small portal-revoke';rv.textContent='Revoke link';rv.title='Immediately disables the portal link for '+r.contact_name;
   rv.onclick=async()=>{try{await api(`/tickets/${ticketId}/threads/${threadId}/portal-links/revoke`,{method:'POST',body:{contact_id:contactId}});rv.remove();btn.textContent='Portal link · '+r.contact_name+' (revoked)';btn.title='Link revoked. Click again to re-enable the same link.';btn.disabled=false;}catch(e){alert(e.message);}};
   btn.after(rv);
  };
  try{await navigator.clipboard.writeText(url);btn.textContent='Link copied for '+r.contact_name;btn.title=note;}
  catch{prompt('Simulated portal link for '+r.contact_name+' (demo only, expires '+fmtTs(r.expires_at)+'):',url);btn.textContent='Portal link · '+r.contact_name;btn.disabled=false;}
  offerRevoke();
 }catch(e){alert(e.message);btn.disabled=false;}
}
function filterRecipients(){const internal=document.getElementById('thread-visibility').value==='internal';document.querySelectorAll('.recipient').forEach(el=>{const hide=internal&&el.dataset.kind!=='ops';el.hidden=hide;if(hide)el.querySelector('input').checked=false;});}
async function createThread(ev,id){ev.preventDefault();try{await api(`/tickets/${id}/threads`,{method:'POST',body:{subject:document.getElementById('thread-subject').value,visibility:document.getElementById('thread-visibility').value,body:document.getElementById('thread-body').value,recipient_ids:[...document.querySelectorAll('input[name="thread-recipient"]:checked')].map(x=>Number(x.value))}});await appendCollaboration(id);document.querySelector('.thread:last-of-type')?.scrollIntoView({block:'center'});}catch(e){const box=document.getElementById('thread-error');box.hidden=false;box.textContent=e.message;}}
async function replyThread(ev,id,threadId){ev.preventDefault();try{await api(`/tickets/${id}/threads/${threadId}/messages`,{method:'POST',body:{body:document.getElementById('reply-'+threadId).value}});await appendCollaboration(id);document.querySelector(`[data-thread-id="${threadId}"]`)?.scrollIntoView({block:'center'});}catch(e){alert(e.message);}}

route();
// Background refresh moved to realtime.js: SSE ticket events refresh live,
// with a 15s polling fallback when the stream is unavailable.
