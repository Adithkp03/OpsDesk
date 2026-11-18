// Stage: webhooks (create/update), CSAT after resolve, macros with intent-aware suggestions.
process.env.OPSDESK_DB=require('path').join(require('os').tmpdir(),'opsdesk-ext-'+Date.now()+'.db');
process.env.OPSDESK_WEBHOOK_BACKOFF_MS='60,60,60';
process.env.OPSDESK_WEBHOOK_TIMEOUT_MS='1500';
require('child_process').execFileSync(process.execPath,[require('path').join(__dirname,'../seed.js')],{env:process.env});
const assert=require('assert');const crypto=require('crypto');const http=require('http');const app=require('../server');
let pass=0;const check=(name,v)=>{assert(v,name);pass++;console.log('  ok - '+name);};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const waitFor=async(fn,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(80);}return null;};

const server=app.listen(0,async()=>{
 const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,user=1,body,method)=>{const r=await fetch(base+'/api'+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-User-Id':String(user)},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json().catch(()=>({}))};};
 const LEAD=4,AGENT=1,REQ=5,REQ2=6;
 // A second local receiver we fully control (verifies signature itself, records raw requests).
 const hits=[];let mode='ok';
 const rx=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{hits.push({headers:req.headers,body:b,url:req.url});if(mode==='500'){res.statusCode=500;return res.end('x');}if(mode==='redirect'){res.statusCode=302;res.setHeader('Location','http://example.invalid/');return res.end();}res.end('ok');});});
 await new Promise(r=>rx.listen(0,'127.0.0.1',r));
 const rxUrl='http://127.0.0.1:'+rx.address().port+'/hook';
 try{
  // ================= WEBHOOKS =================
  check('requester cannot list webhooks',(await call('/webhooks',REQ)).status===403);
  check('agent can list webhooks (read only)',(await call('/webhooks',AGENT)).status===200);
  check('agent cannot create a webhook',(await call('/webhooks',AGENT,{url:rxUrl})).status===403);
  check('external https destination is rejected',(await call('/webhooks',LEAD,{url:'https://example.com/hook'})).status===400);
  check('external http destination is rejected',(await call('/webhooks',LEAD,{url:'http://203.0.113.5/hook'})).status===400);
  check('lookalike host is rejected',(await call('/webhooks',LEAD,{url:'http://localhost.evil.test/hook'})).status===400);
  check('userinfo trick is rejected',(await call('/webhooks',LEAD,{url:'http://127.0.0.1@evil.test/hook'})).status===400);
  check('non-http scheme is rejected',(await call('/webhooks',LEAD,{url:'file:///etc/passwd'})).status===400);
  check('garbage URL is rejected',(await call('/webhooks',LEAD,{url:'nope'})).status===400);
  check('unknown event name is rejected',(await call('/webhooks',LEAD,{url:rxUrl,events:['ticket.deleted']})).status===400);
  const ep=await call('/webhooks',LEAD,{url:rxUrl,description:'test receiver'});
  check('lead creates a loopback endpoint',ep.status===201&&ep.data.id);
  check('secret is returned once on create',/^whsec_[0-9a-f]{48}$/.test(ep.data.secret));
  const list=await call('/webhooks',LEAD);
  check('list never exposes the secret',!JSON.stringify(list.data).includes('whsec_'));
  // create event
  check('loopback IPv6 is allowed',(await call('/webhooks',LEAD,{url:'http://[::1]:9/x'})).status===201);
  check('other 127.x addresses are rejected',(await call('/webhooks',LEAD,{url:'http://127.0.0.2:9/x'})).status===400);
  check('0.0.0.0 is rejected',(await call('/webhooks',LEAD,{url:'http://0.0.0.0:9/x'})).status===400);
  check('private LAN address is rejected',(await call('/webhooks',LEAD,{url:'http://192.168.1.10/x'})).status===400);
  for(const e of (await call('/webhooks',LEAD)).data.endpoints.filter(e=>e.url.includes('[::1]')))await call('/webhooks/'+e.id,LEAD,null,'DELETE');
  const created=await call('/tickets',REQ,{title:'Webhook test: refund chase',description:'SECRET-DESCRIPTION-TEXT refund pending',tboh:'TBOH-77001',priority:'P2',intent_id:'refund_delay'});
  check('ticket created for webhook test',created.status===201);
  await waitFor(()=>hits.some(h=>h.headers['x-opsdesk-event']==='ticket.created'));
  const h=hits.find(x=>x.headers['x-opsdesk-event']==='ticket.created');
  check('ticket.created delivered',!!h);
  const body=h&&JSON.parse(h.body);
  check('payload names the ticket and event',body&&body.ticket.id===created.data.id&&body.event==='ticket.created'&&/^evt_/.test(body.id));
  check('payload is ids and state only (no title, description, names, booking ref)',h&&!/SECRET-DESCRIPTION|Webhook test|TBOH-77001|Priya/.test(h.body)&&!('title' in body.ticket)&&!('description' in body.ticket));
  const sig=/^t=(\d+),v1=([0-9a-f]{64})$/.exec(h.headers['x-opsdesk-signature']);
  check('signature header has timestamp and HMAC',!!sig);
  check('HMAC verifies with the endpoint secret',sig&&crypto.createHmac('sha256',ep.data.secret).update(sig[1]+'.'+h.body).digest('hex')===sig[2]);
  check('HMAC fails with a wrong secret',sig&&crypto.createHmac('sha256','whsec_wrong').update(sig[1]+'.'+h.body).digest('hex')!==sig[2]);
  check('delivery headers identify event and attempt id',h.headers['x-opsdesk-delivery']&&h.headers['x-opsdesk-endpoint']==String(ep.data.id));
  // update events
  hits.length=0;
  await call('/tickets/'+created.data.id+'/status',AGENT,{status:'Open'});
  await waitFor(()=>hits.some(x=>x.headers['x-opsdesk-event']==='ticket.updated'));
  const u=hits.find(x=>x.headers['x-opsdesk-event']==='ticket.updated');
  check('status change delivers ticket.updated',!!u);
  const ub=u&&JSON.parse(u.body);
  check('update payload carries new status and change type',ub&&ub.ticket.status==='Open'&&ub.change.type==='status_changed');
  check('creation did not also emit an update for the same action',hits.filter(x=>x.headers['x-opsdesk-event']==='ticket.created').length===0);
  // delivery log
  await waitFor(async()=>(await call('/webhooks/deliveries',AGENT)).data.deliveries.every(d=>d.status==='delivered'));
  const log=(await call('/webhooks/deliveries',AGENT)).data.deliveries;
  check('delivery log lists delivered events for ops',log.length>=2&&log.every(d=>d.status==='delivered'&&d.attempts===1&&d.last_status===200));
  check('delivery log is closed to requesters',(await call('/webhooks/deliveries',REQ)).status===403);
  check('read-only roles never see secrets in list, log or sink views',![(await call('/webhooks',AGENT)).data,(await call('/webhooks/deliveries',AGENT)).data,(await call('/webhooks/sink/received',AGENT)).data].some(d=>JSON.stringify(d).includes(ep.data.secret)||JSON.stringify(d).includes('whsec_')));
  check('delivery log hides payload bodies',!JSON.stringify(log).includes('"ticket"'));
  // retries
  hits.length=0;mode='500';
  const t2=await call('/tickets',REQ,{title:'Retry test ticket',description:'x',priority:'P3',intent_id:'other'});
  await waitFor(()=>hits.length>=MAXA());
  function MAXA(){return 4;}
  check('failing receiver is retried up to the attempt limit',hits.length===4);
  const failedRow=await waitFor(async()=>(await call('/webhooks/deliveries?status=failed',AGENT)).data.deliveries.find(d=>d.ticket_id===t2.data.id&&d.event==='ticket.created'));
  check('exhausted delivery is marked failed with the reason',failedRow&&failedRow.status==='failed'&&failedRow.attempts===4&&failedRow.last_error==='HTTP 500');
  await sleep(400);
  check('no attempts beyond the limit',hits.length===4);
  check('each retry re-sends the same event id',new Set(hits.map(x=>JSON.parse(x.body).id)).size===1);
  mode='ok';hits.length=0;
  check('agent cannot redeliver',(await call('/webhooks/deliveries/'+failedRow.id+'/redeliver',AGENT,{})).status===403);
  check('lead redelivers a failed delivery',(await call('/webhooks/deliveries/'+failedRow.id+'/redeliver',LEAD,{})).status===202);
  await waitFor(()=>hits.length===1);
  check('redelivery reaches the receiver once',hits.length===1);
  const re=await waitFor(async()=>{const r=(await call('/webhooks/deliveries?status=delivered',AGENT)).data.deliveries.find(d=>d.id===failedRow.id);return r;});
  check('redelivered row becomes delivered',!!re);
  check('delivered rows cannot be redelivered',(await call('/webhooks/deliveries/'+failedRow.id+'/redeliver',LEAD,{})).status===409);
  // redirect refusal
  hits.length=0;mode='redirect';
  const t3=await call('/tickets',REQ,{title:'Redirect test ticket',description:'x',priority:'P3',intent_id:'other'});
  await waitFor(()=>hits.length>=1);
  check('redirects are not followed (receiver only sees the original URL)',hits.every(x=>x.url==='/hook'));
  mode='ok';
  // pause / resume
  await waitFor(async()=>(await call('/webhooks/deliveries',AGENT)).data.deliveries.every(d=>d.status!=='pending'));
  check('requester cannot pause',(await call('/webhooks/'+ep.data.id+'/active',REQ,{active:false})).status===403);
  check('lead pauses the endpoint',(await call('/webhooks/'+ep.data.id+'/active',LEAD,{active:false})).data.active===false);
  hits.length=0;
  await call('/tickets/'+created.data.id+'/status',AGENT,{status:'Pending'});
  await sleep(500);
  check('paused endpoint receives nothing',hits.length===0);
  await call('/webhooks/'+ep.data.id+'/active',LEAD,{active:true});
  // rotation
  const rot=await call('/webhooks/'+ep.data.id+'/rotate-secret',LEAD,{});
  check('rotation returns a different secret',rot.data.secret&&rot.data.secret!==ep.data.secret);
  await call('/tickets/'+created.data.id+'/status',AGENT,{status:'Open'});
  await waitFor(()=>hits.length>=1);
  const rh=hits[0],rs=/^t=(\d+),v1=([0-9a-f]{64})$/.exec(rh.headers['x-opsdesk-signature']);
  check('new deliveries are signed with the rotated secret',crypto.createHmac('sha256',rot.data.secret).update(rs[1]+'.'+rh.body).digest('hex')===rs[2]);
  check('old secret no longer verifies',crypto.createHmac('sha256',ep.data.secret).update(rs[1]+'.'+rh.body).digest('hex')!==rs[2]);
  // event filter
  const only=await call('/webhooks',LEAD,{url:rxUrl,events:['ticket.created']});
  check('endpoint can subscribe to created only',only.status===201);
  await call('/webhooks/'+ep.data.id+'/active',LEAD,{active:false});
  hits.length=0;
  await call('/tickets/'+created.data.id+'/status',AGENT,{status:'Pending'});
  await sleep(500);
  check('created-only endpoint ignores updates',hits.length===0);
  await call('/webhooks/'+only.data.id,LEAD,null,'DELETE');
  // built-in sink
  const sink=await call('/webhooks',LEAD,{url:base+'/webhook-sink?fail=1',description:'built-in sink'});
  await call('/webhooks/'+ep.data.id,LEAD,null,'DELETE');
  check('lead deletes an endpoint',(await call('/webhooks',LEAD)).data.endpoints.every(e=>e.id!==ep.data.id));
  const t4=await call('/tickets',REQ,{title:'Sink test ticket',description:'x',priority:'P3',intent_id:'other'});
  const got=await waitFor(async()=>(await call('/webhooks/sink/received',AGENT)).data.received.find(r=>r.ticket===t4.data.id&&r.event==='ticket.created'));
  check('built-in sink verified signature and recorded the event after one forced failure',got&&got.verified&&got.event==='ticket.created');
  const sd=(await call('/webhooks/deliveries?endpoint_id='+sink.data.id,AGENT)).data.deliveries.find(d=>d.ticket_id===t4.data.id);
  check('log shows the retry (2 attempts) before success',sd&&sd.attempts===2&&sd.status==='delivered');
  const bad=await fetch(base+'/webhook-sink',{method:'POST',headers:{'Content-Type':'application/json','X-OpsDesk-Endpoint':String(sink.data.id),'X-OpsDesk-Signature':'t=1,v1='+'0'.repeat(64)},body:'{}'});
  check('sink rejects a forged signature',bad.status===401);
  const none=await fetch(base+'/webhook-sink',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  check('sink rejects unsigned requests',none.status===401);
  check('test event can be queued by lead',(await call('/webhooks/'+sink.data.id+'/test',LEAD,{})).status===202);
  const tev=await waitFor(async()=>(await call('/webhooks/sink/received',AGENT)).data.received.find(r=>r.event==='webhook.test'));
  check('test event arrives signed',!!tev);

  // ================= CSAT =================
  const c1=await call('/tickets',REQ,{title:'CSAT flow: refund chase',description:'Waiting on refund',tboh:'TBOH-77100',priority:'P2',intent_id:'refund_delay'});
  const cid=c1.data.id;
  check('no survey exists before resolve',(await call(`/tickets/${cid}/csat`,AGENT)).data.surveys.length===0);
  check('requester cannot answer before resolve',(await call(`/tickets/${cid}/csat`,REQ,{score:5})).status===409);
  check('requester cannot change status',(await call(`/tickets/${cid}/status`,REQ,{status:'Resolved'})).status===403);
  check('resolve moves the ticket',(await call(`/tickets/${cid}/status`,AGENT,{status:'Resolved'})).status===200);
  const s1=(await call(`/tickets/${cid}/csat`,REQ)).data;
  check('survey is requested from the ticket creator on resolve',s1.surveys.length===1&&s1.surveys[0].status==='pending'&&s1.simulation===true);
  const tl=(await call('/tickets/'+cid,AGENT)).data.timeline;
  check('timeline says the request is simulated, no email',tl.some(e=>e.type==='csat_requested'&&/simulated; no email/.test(e.detail)));
  check('another requester cannot see the ticket survey',(await call(`/tickets/${cid}/csat`,REQ2)).status===403);
  check('another requester cannot answer',(await call(`/tickets/${cid}/csat`,REQ2,{score:1})).status===403);
  check('ops cannot answer on the requester\'s behalf',(await call(`/tickets/${cid}/csat`,AGENT,{score:5})).status===403);
  check('score 0 rejected',(await call(`/tickets/${cid}/csat`,REQ,{score:0})).status===400);
  check('score 6 rejected',(await call(`/tickets/${cid}/csat`,REQ,{score:6})).status===400);
  check('fractional score rejected',(await call(`/tickets/${cid}/csat`,REQ,{score:3.5})).status===400);
  check('string score rejected',(await call(`/tickets/${cid}/csat`,REQ,{score:'5'})).status===400);
  check('oversized comment rejected',(await call(`/tickets/${cid}/csat`,REQ,{score:4,comment:'x'.repeat(1001)})).status===400);
  const ans=await call(`/tickets/${cid}/csat`,REQ,{score:4,comment:'Quick, thanks'});
  check('requester answers once',ans.status===201);
  check('second answer is refused',(await call(`/tickets/${cid}/csat`,REQ,{score:1})).status===409);
  const s2=(await call(`/tickets/${cid}/csat`,AGENT)).data.surveys;
  check('ops see the score, comment and requester',s2[0].status==='answered'&&s2[0].score===4&&s2[0].comment==='Quick, thanks'&&s2[0].requester_name==='Priya Menon');
  check('response is logged on the timeline',(await call('/tickets/'+cid,AGENT)).data.timeline.some(e=>e.type==='csat_received'&&e.detail.includes('4/5')));
  // close after resolve: no second survey
  await call(`/tickets/${cid}/status`,AGENT,{status:'Closed'});
  check('Resolved to Closed does not ask again',(await call(`/tickets/${cid}/csat`,AGENT)).data.surveys.length===1);
  // reopen voids pending, re-resolve asks again
  const c2=await call('/tickets',REQ2,{title:'CSAT reopen: amendment',description:'Change dates',priority:'P3',intent_id:'booking_amendment'});
  await call(`/tickets/${c2.data.id}/status`,AGENT,{status:'Resolved'});
  await call(`/tickets/${c2.data.id}/status`,AGENT,{status:'Open'});
  check('reopen voids the unanswered survey',(await call(`/tickets/${c2.data.id}/csat`,AGENT)).data.surveys[0].status==='void');
  check('cannot answer a voided survey',(await call(`/tickets/${c2.data.id}/csat`,REQ2,{score:5})).status===409);
  await call(`/tickets/${c2.data.id}/status`,AGENT,{status:'Resolved'});
  const s3=(await call(`/tickets/${c2.data.id}/csat`,REQ2)).data.surveys;
  check('second resolution creates a fresh pending survey',s3.filter(s=>s.status==='pending').length===1);
  check('requester sees only their own surveys (no names field)',!('requester_name' in s3[0]));
  await call(`/tickets/${c2.data.id}/csat`,REQ2,{score:1,comment:'Slow'});
  // ops-created ticket: no requester to ask
  const c3=await call('/tickets',AGENT,{title:'Ops opened ticket',description:'x',priority:'P3',intent_id:'other',agency_id:1});
  await call(`/tickets/${c3.data.id}/status`,AGENT,{status:'Resolved'});
  check('ops-opened tickets log a skip instead of asking',(await call(`/tickets/${c3.data.id}/csat`,AGENT)).data.surveys.length===0&&(await call('/tickets/'+c3.data.id,AGENT)).data.timeline.some(e=>e.type==='csat_skipped'));
  const c4=await call('/tickets',REQ,{title:'Unanswered survey ticket',description:'x',priority:'P3',intent_id:'documentation'});
  await call(`/tickets/${c4.data.id}/status`,AGENT,{status:'Resolved'});
  // summary
  check('requester cannot read CSAT summary',(await call('/csat/summary',REQ)).status===403);
  const sum=(await call('/csat/summary',AGENT)).data;
  check('summary counts requested and answered',sum.requested===3&&sum.answered===2&&sum.pending===1);
  check('summary average and response rate',sum.average===2.5&&sum.response_rate===67);
  check('summary distribution adds up',sum.distribution.reduce((a,d)=>a+d.count,0)===2&&sum.distribution[3].count===1&&sum.distribution[0].count===1);
  check('summary breaks down by intent',sum.by_intent.some(x=>x.key==='refund_delay'&&x.average===4));
  check('low scores are listed with the comment',sum.low_scores.length===1&&sum.low_scores[0].comment==='Slow');
  // CSAT events flow through webhooks (sink endpoint still active)
  const csatEv=await waitFor(async()=>(await call('/webhooks/sink/received',AGENT)).data.received.find(r=>r.change==='csat_received'));
  check('CSAT response also emits ticket.updated to webhooks',csatEv&&csatEv.event==='ticket.updated');

  // ================= MACROS =================
  check('requester cannot list macros',(await call('/macros',REQ)).status===403);
  const ml=await call('/macros',AGENT);
  check('starter macros exist',ml.data.macros.length>=10&&ml.data.macros.some(m=>m.intent_id==='refund_delay'));
  check('macro create validates length',(await call('/macros',AGENT,{name:'x',body:'y'})).status===400);
  check('macro create rejects unknown placeholders',(await call('/macros',AGENT,{name:'Bad one',body:'Hi {{password}} there'})).status===400);
  check('macro create rejects unknown intent',(await call('/macros',AGENT,{name:'Bad intent',body:'Hello there friend',intent_id:'nope'})).status===400);
  const nm=await call('/macros',AGENT,{name:'Refund: custom',body:'Hi {{requester_name}}, refund for {{booking_ref}} noted on {{ticket_ref}}. {{agent_name}}',intent_id:'refund_delay'});
  check('agent creates a macro',nm.status===201);
  check('requester cannot create a macro',(await call('/macros',REQ,{name:'Nope nope',body:'Hello there'})).status===403);
  const up=await call('/macros/'+nm.data.id,AGENT,{name:'Refund: custom v2'},'PUT');
  check('macro can be edited',up.data.name==='Refund: custom v2'&&up.data.body===nm.data.body);
  // Intent-aware suggestions
  const sg=(await call(`/tickets/${cid}/macro-suggestions`,AGENT)).data;
  check('suggestions are draft-only',sg.draft_only===true);
  check('refund ticket ranks refund macros first',sg.suggestions.length>=2&&sg.suggestions[0].intent_id==='refund_delay'&&sg.suggestions[0].score>=1);
  check('suggestion explains why',/Matches ticket intent \(Refund delay\)/.test(sg.suggestions[0].reason));
  check('preview fills ticket, booking and requester',sg.suggestions.some(s=>s.preview.includes('T-'+cid)&&s.preview.includes('TBOH-77100')&&s.preview.includes('Priya')));
  check('preview uses the signed-in agent as sender',sg.suggestions[0].preview.includes('Ananya Rao'));
  check('unrelated intent macros are not suggested',!sg.suggestions.some(s=>s.intent_id&&s.intent_id!=='refund_delay'));
  check('requester cannot read suggestions',(await call(`/tickets/${cid}/macro-suggestions`,REQ)).status===403);
  // Conversation points elsewhere
  const mt=await call('/tickets',REQ,{title:'Help with trip',description:'Need something sorted',tboh:'TBOH-77200',priority:'P3',intent_id:'other'});
  const mid=mt.data.id;
  const contacts=(await call(`/tickets/${mid}/side-contacts`,AGENT)).data.contacts;
  const sup=contacts.find(c=>c.kind==='supplier');
  const th=await call(`/tickets/${mid}/threads`,AGENT,{subject:'Customer follow up',visibility:'external',recipient_ids:[sup.id],body:'Please cancel the booking and confirm the cancellation, we need to cancel before the deadline and drop booking today.'});
  check('conversation thread created for intent test',th.status===201);
  const sg2=(await call(`/tickets/${mid}/macro-suggestions`,AGENT)).data;
  check('conversation intent is surfaced when it differs from the ticket intent',sg2.conversation_intent&&sg2.conversation_intent.id==='cancellation');
  check('conversation-based macro is suggested with a review note',sg2.suggestions.some(s=>s.intent_id==='cancellation'&&/Conversation points to/.test(s.reason)&&/Review the intent first/.test(s.reason)));
  check('em cannot see conversation-based suggestions for a non-escalated ticket',(await call(`/tickets/${mid}/macro-suggestions`,3)).status===403);
  check('requester thread-scope: suggestions use ops-only route (requester 403)',(await call(`/tickets/${mid}/macro-suggestions`,REQ)).status===403&&(await call(`/tickets/${mid}/macros/1/draft`,REQ,{})).status===403);
  check('another agency requester is blocked from the ticket suggestions',(await call(`/tickets/${mid}/macro-suggestions`,REQ2)).status===403);
  check('suggesting does not change the ticket intent',(await call('/tickets/'+mid,AGENT)).data.ticket.intent_id==='other');
  const msgCount=()=>(require('../db').db.prepare('SELECT COUNT(*) c FROM side_messages').get().c);
  const before=msgCount();
  const dr=await call(`/tickets/${mid}/macros/${sg2.suggestions[0].macro_id}/draft`,AGENT,{});
  check('draft endpoint returns text only',dr.status===200&&dr.data.draft_only===true&&typeof dr.data.text==='string'&&dr.data.text.length>10);
  check('drafting sends nothing (no side message created)',msgCount()===before);
  const noLcd=(await call(`/tickets/${mid}/macros/${require('../db').db.prepare("SELECT id FROM macros WHERE name='Cancellation: deadline reminder'").get().id}/draft`,AGENT,{})).data;
  check('missing ticket data shows a bracket placeholder and is reported',noLcd.text.includes('[last cancel date]')&&noLcd.unresolved.includes('last_cancel_date'));
  check('unknown macro 404',(await call(`/tickets/${mid}/macros/9999/draft`,AGENT,{})).status===404);
  check('requester cannot draft macros',(await call(`/tickets/${mid}/macros/1/draft`,REQ,{})).status===403);
  check('draft count increments',require('../db').db.prepare('SELECT drafted_count FROM macros WHERE id=?').get(sg2.suggestions[0].macro_id).drafted_count>=1);
  // other-agency requester ticket not accessible
  check('macro suggestions respect ticket access (em cannot read non-escalated ticket)',(await call(`/tickets/${mid}/macro-suggestions`,3)).status===403);
  check('macro delete retires the macro',(await call('/macros/'+nm.data.id,AGENT,null,'DELETE')).status===200&&!(await call('/macros',AGENT)).data.macros.some(m=>m.id===nm.data.id));
  // Explicit send is a separate step and still the existing reply endpoint
  const reply=await call(`/tickets/${mid}/threads/${th.data.id}/messages`,AGENT,{body:dr.data.text});
  check('agent reviews then sends via the normal reply endpoint',reply.status===201);
  console.log(`All ${pass} webhook/CSAT/macro checks passed.`);
 }catch(e){console.error('FAILED:',e.message);console.error(e.stack.split('\n').slice(1,4).join('\n'));process.exitCode=1;}
 finally{rx.close();server.close();setTimeout(()=>process.exit(process.exitCode||0),100);}
});
