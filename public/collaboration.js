// MVP2+3 UI: explicit ownership and independent side-conversation audiences.
let queueRegion='', queueIntent='';
async function routingPanel(){
 const {agents}=await api('/routing/agents');
 return `<div class="card" style="margin-bottom:16px"><div class="section-title">Routing signals · simulated availability</div><p class="sub">Available agents first, then agency region match, then lowest active load. Queue ranked P1 → P2 → P3. No FIFO/LIFO-only routing.</p><div class="chips">${agents.map(a=>`<button class="btn small" onclick="toggleAvailability(${a.user_id},${!a.available})">${esc(a.name)} · ${esc(a.regions.join('/'))} · ${a.load} active · ${a.available?'Available':'Away'} (toggle)</button>`).join('')}</div></div>`;
}
async function toggleAvailability(id,available){try{await api('/routing/agents/'+id,{method:'POST',body:{available}});await viewQueue();}catch(e){alert(e.message);}}
async function viewQueue(){
 const u=userById(me()),isOps=u.role!=='requester';
 const params=new URLSearchParams();
 if(['triage','mine','linked'].includes(queueFilter))params.set('view',queueFilter);
 if(queueRegion)params.set('region',queueRegion);
 if(queueIntent)params.set('intent',queueIntent);
 const {tickets}=await api('/tickets?'+params);
 const statuses=['all','triage','mine','linked','New','Open','Pending','Escalated','Resolved','Closed'];
 const shown=statuses.slice(4).includes(queueFilter)?tickets.filter(t=>t.status===queueFilter):tickets;
 $app.innerHTML=`<div class="page-head"><div><h1>${isOps?(queueFilter==='triage'?'Triage · unassigned':queueFilter==='mine'?'My queue':queueFilter==='linked'?'Linked cases':'All tickets'):esc(u.agency_name)+' tickets'}</h1><div class="sub">${shown.length} tickets · ranked by priority P1 → P2 → P3</div></div><a class="btn primary" href="#/new">+ New ticket</a></div>
 ${isOps?await routingPanel():''}
 <div class="chips">${statuses.filter(s=>isOps||!['triage','mine'].includes(s)).map(s=>`<button class="chip ${queueFilter===s?'on':''}" onclick="queueFilter='${s}';viewQueue()">${({all:'All tickets',triage:'Triage (unassigned)',mine:'My queue',linked:'Linked cases'})[s]||s}</button>`).join('')}</div>
 <div class="form-row" style="margin:12px 0"><label class="f">By region<select class="f" id="queueRegion" onchange="queueRegion=this.value;viewQueue()"><option value="">All regions</option>${[...new Set(boot.agencies.map(a=>a.region))].map(r=>`<option ${r===queueRegion?'selected':''}>${esc(r)}</option>`).join('')}</select></label><label class="f">By intent<select class="f" id="queueIntent" onchange="queueIntent=this.value;viewQueue()"><option value="">All intents</option>${boot.intents.map(i=>`<option value="${i.id}" ${i.id===queueIntent?'selected':''}>${esc(i.label)}</option>`).join('')}</select></label></div>
 <div class="queue">${shown.length?shown.map(ticketRow).join(''):'<div class="empty">No tickets in this view.</div>'}</div>`;
 renderWho();
}
async function autoRoute(id){try{const r=await api(`/tickets/${id}/route`,{method:'POST',body:{}});await viewTicket(id);}catch(e){const box=document.getElementById('routing-error');if(box){box.hidden=false;box.textContent=e.message;box.scrollIntoView({block:'center'});}else alert(e.message);}}
async function assign(id){try{const v=document.getElementById('assignSel').value;const reason=document.getElementById('ownerReason')?.value||'';await api(`/tickets/${id}/assign`,{method:'POST',body:{agent_id:v===''?null:Number(v),reason}});await viewTicket(id);}catch(e){alert(e.message);}}
async function appendCollaboration(id){
 const u=userById(me()),isOps=u.role!=='requester';
 const {threads}=await api(`/tickets/${id}/threads`);
 const contacts=isOps?(await api(`/tickets/${id}/side-contacts`)).contacts:[];
 const audit=isOps?(await api(`/tickets/${id}/routing`)).audit:[];
 if(!document.getElementById('collab'))return;
 document.getElementById('collab').innerHTML=`${isOps?`<div class="card"><div class="section-title">Ownership & routing audit</div>${audit.length?audit.map(a=>`<p>${esc(a.reason)}<br><span class="sub">${esc(a.actor_name)} · ${fmtTs(a.created_at)}</span></p>`).join(''):'<p class="sub">No routing changes recorded yet.</p>'}</div>`:''}
 <div class="card" style="margin-top:16px"><h2>Side conversations</h2><p class="sub">Demo simulation only. Nothing is emailed or sent outside OpsDesk. Each thread keeps its explicit audience after ownership changes.</p>
 ${threads.length?threads.map(th=>`<section class="thread" data-thread-id="${th.id}"><div class="section-title">${th.visibility==='internal'?'Internal note · ops only':'External reply · simulated'} | ${esc(th.subject)}</div><div class="audience"><strong>To:</strong> ${th.recipients.map(c=>`${esc(c.name)} &lt;${esc(c.address)}&gt;`).join(', ')}</div>${th.messages.map(m=>`<div class="side-message"><strong>${esc(m.author_name)}</strong> <span class="sub">${fmtTs(m.created_at)}</span><p>${esc(m.body)}</p><small>Fixed audience: ${m.recipients.map(c=>esc(c.name)).join(', ')}</small></div>`).join('')}<form onsubmit="replyThread(event,${id},${th.id})"><label class="f">Reply to this thread<textarea class="f" id="reply-${th.id}" required maxlength="5000"></textarea></label><button class="btn" type="submit">${th.visibility==='internal'?'Add internal note':'Add simulated external reply'}</button></form></section>`).join(''):'<p>No conversations visible to this user.</p>'}
 ${isOps?`<form class="stack new-thread" onsubmit="createThread(event,${id})"><h3>New side conversation</h3><label class="f">Subject<input id="thread-subject" class="f" required maxlength="160"></label><label class="f">Visibility<select id="thread-visibility" class="f" onchange="filterRecipients()"><option value="internal">Internal note (ops only)</option><option value="external">External reply (simulated)</option></select></label><fieldset><legend>Explicit recipients (never inferred from ticket owner)</legend>${contacts.map(c=>`<label class="recipient" data-kind="${c.kind}"><input type="checkbox" name="thread-recipient" value="${c.id}"> ${esc(c.name)} · ${esc(c.kind)} <small>${esc(c.address)}</small></label>`).join('')}</fieldset><label class="f">Message<textarea id="thread-body" class="f" required maxlength="5000"></textarea></label><button class="btn primary">Create conversation</button><div id="thread-error" class="error-box" hidden></div></form>`:''}</div>`;
 if(isOps)filterRecipients();
}
function filterRecipients(){const internal=document.getElementById('thread-visibility').value==='internal';document.querySelectorAll('.recipient').forEach(el=>{const hide=internal&&el.dataset.kind!=='ops';el.hidden=hide;if(hide)el.querySelector('input').checked=false;});}
async function createThread(ev,id){ev.preventDefault();try{await api(`/tickets/${id}/threads`,{method:'POST',body:{subject:document.getElementById('thread-subject').value,visibility:document.getElementById('thread-visibility').value,body:document.getElementById('thread-body').value,recipient_ids:[...document.querySelectorAll('input[name="thread-recipient"]:checked')].map(x=>Number(x.value))}});await appendCollaboration(id);document.querySelector('.thread:last-of-type')?.scrollIntoView({block:'center'});}catch(e){const box=document.getElementById('thread-error');box.hidden=false;box.textContent=e.message;}}
async function replyThread(ev,id,threadId){ev.preventDefault();try{await api(`/tickets/${id}/threads/${threadId}/messages`,{method:'POST',body:{body:document.getElementById('reply-'+threadId).value}});await appendCollaboration(id);document.querySelector(`[data-thread-id="${threadId}"]`)?.scrollIntoView({block:'center'});}catch(e){alert(e.message);}}

route();
