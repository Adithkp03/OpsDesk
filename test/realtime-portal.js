// Stage: real-time sync (SSE + scoping), conversation-weighted intent, supplier portal.
process.env.OPSDESK_DB=require('path').join(require('os').tmpdir(),'opsdesk-rtp-'+Date.now()+'.db');
require('child_process').execFileSync(process.execPath,[require('path').join(__dirname,'../seed.js')],{env:process.env});
const assert=require('assert');const http=require('http');const app=require('../server');
let pass=0;const check=(name,v)=>{assert(v,name);pass++;console.log('  ok - '+name);};
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

// Minimal SSE client: collects parsed events until closed.
function openEvents(url,headers){
 const events=[];let buf='';
 const req=http.get(url,{headers:headers||{}},(res)=>{res.setEncoding('utf8');res.on('data',(chunk)=>{buf+=chunk;let i;while((i=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,i);buf=buf.slice(i+2);const ev={};for(const line of block.split('\n')){if(line.startsWith('event: '))ev.event=line.slice(7);if(line.startsWith('data: '))ev.data=line.slice(6);}if(ev.event)events.push(ev);}});});
 return {events,status:()=>req.req&&req.req.res?req.req.res.statusCode:null,close:()=>req.destroy()};
}

const server=app.listen(0,async()=>{
 const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,user=1,body,method)=>{const r=await fetch(base+'/api'+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-User-Id':String(user)},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json().catch(()=>({}))};};
 try{
  // ---- Real-time sync ----
  const bad=http.get(base+'/api/events',(res)=>{check('SSE without credentials is 401',res.statusCode===401);res.resume();
   http.get(base+'/api/events?user=99',(res2)=>{check('SSE with unknown user is 401',res2.statusCode===401);res2.resume();});});
  const agent=openEvents(base+'/api/events?user=1');
  const priya=openEvents(base+'/api/events?user=5');
  const headerAuth=openEvents(base+'/api/events',{'X-User-Id':'4'});
  await sleep(400);
  check('agent stream says hello',agent.events.some(e=>e.event==='hello'));
  check('requester stream says hello',priya.events.some(e=>e.event==='hello'));
  check('header auth also works on the events endpoint',headerAuth.events.some(e=>e.event==='hello'));
  // Requester creates a ticket -> both agent and the creating requester see it.
  const created=await call('/tickets',5,{title:'Realtime test: refund chase',description:'Refund still not received, client chasing.',tboh:'TBOH-88213',priority:'P2',intent_id:'refund_delay'});
  check('requester ticket created for realtime test',created.status===200||created.status===201);
  await sleep(400);
  check('agent receives created event live',agent.events.some(e=>e.event==='ticket'&&JSON.parse(e.data).ticket===created.data.id&&JSON.parse(e.data).type==='created'));
  check('requester receives event for own created ticket',priya.events.some(e=>e.event==='ticket'&&JSON.parse(e.data).ticket===created.data.id));
  // Mutate a different-agency requester ticket -> requester must NOT see it, agent must.
  const before=priya.events.length;
  const cur=(await call('/tickets/1004',1)).data.ticket.status;
  const next=cur==='Open'?'Pending':'Open';
  const st=await call('/tickets/1004/status',1,{status:next,note:'realtime scoping probe'});
  check('scoping probe mutation succeeded',st.status===200);
  await sleep(400);
  check('agent receives other-agency ticket event',agent.events.some(e=>e.event==='ticket'&&JSON.parse(e.data).ticket===1004));
  check('requester stream stays silent on other-agency ticket',!priya.events.some(e=>e.event==='ticket'&&JSON.parse(e.data).ticket===1004)&&priya.events.length===before);
  // Event payloads are ids only - no ticket fields travel the stream.
  const payload=agent.events.find(e=>e.event==='ticket');
  check('event payload carries id+type only',payload&&!/title|agency|description/i.test(payload.data));
  headerAuth.close();

  // ---- Conversation-weighted intent ----
  let r=await call('/intents/suggest',1,{title:'Need help',description:'General question about the booking',conversation:'the hotel has not confirmed yet, no reply from the property so far'});
  check('conversation text detects supplier_confirmation',r.data.intent_id==='supplier_confirmation'&&r.data.abstain===false);
  r=await call('/intents/suggest',1,{title:'Charged twice on my card',description:'Double charge for the booking'});
  check('plain suggest unchanged (regression)',r.data.intent_id==='payment_issue'&&r.data.abstain===false);
  r=await call('/intents/suggest',1,{title:'Hello',description:'',conversation:'how are you today'});
  check('weak conversation still abstains',r.data.abstain===true);
  // Thread conversation feeds the resuggest endpoint.
  await call('/tickets/1006/threads',1,{subject:'Rooms check',visibility:'external',body:'Hotel shows sold out on our side - do you have rooms for Nov 21-25?',recipient_ids:[101]});
  r=await call('/tickets/1006/intent-resuggest',1,{});
  check('resuggest uses thread messages',r.data.sources.thread_messages_used===1);
  check('resuggest keeps correct intent',r.data.suggestion.intent_id==='inventory_sync'&&r.data.suggestion.abstain===false);
  check('differs false when suggestion matches current',r.data.differs===false);
  r=await call('/tickets/1006/intent-resuggest',5,{});
  check('requester resuggest excludes threads they are not a recipient of',r.status===200&&r.data.sources.thread_messages_used===0);
  r=await call('/tickets/1001/intent-resuggest',6,{});
  check('cross-agency requester cannot resuggest',r.status===403);
  r=await call('/tickets/1006/intent',1,{intent_id:'supplier_confirmation'});
  check('agent applies suggested intent',r.status===200&&r.data.intent_id==='supplier_confirmation');
  r=await call('/tickets/1006/intent-resuggest',1,{});
  check('differs true when suggestion now mismatches',r.data.differs===true);
  check('non-creator requester cannot apply intent',(await call('/tickets/1006/intent',6,{intent_id:'payment_issue'})).status===403);
  check('creator requester applies intent',(await call('/tickets/1006/intent',5,{intent_id:'inventory_sync'})).status===200);
  check('invalid intent rejected',(await call('/tickets/1006/intent',1,{intent_id:'bogus'})).status===400);
  check('intent change logged on timeline',(await call('/tickets/1006')).data.timeline.some(e=>e.type==='intent_changed'));

  // ---- Supplier portal (simulated) ----
  const th=(await call('/tickets/1006/threads',1,{subject:'Rate mapping question',visibility:'external',body:'Can you confirm the contracted rate for this weekend?',recipient_ids:[101]})).data;
  check('external thread created',!!th.id);
  check('requester cannot create portal link',(await call(`/tickets/1006/threads/${th.id}/portal-links`,5,{contact_id:101})).status===403);
  check('portal link refuses non-supplier recipient',(await call(`/tickets/1006/threads/${th.id}/portal-links`,1,{contact_id:5})).status===400);
  check('portal link refuses non-recipient supplier',(await call(`/tickets/1006/threads/${th.id}/portal-links`,1,{contact_id:102})).status===400);
  const internal=(await call('/tickets/1006/threads',1,{subject:'Internal',visibility:'internal',body:'ops only',recipient_ids:[1]})).data;
  check('portal link refuses internal thread',(await call(`/tickets/1006/threads/${internal.id}/portal-links`,1,{contact_id:101})).status===400);
  const link=(await call(`/tickets/1006/threads/${th.id}/portal-links`,1,{contact_id:101})).data;
  check('portal link created with simulation label',/^\/portal\/[0-9a-f]{48}$/.test(link.url)&&link.simulation===true);
  const again=(await call(`/tickets/1006/threads/${th.id}/portal-links`,1,{contact_id:101})).data;
  check('portal link creation is idempotent',again.url===link.url);
  check('portal link logged on timeline',(await call('/tickets/1006')).data.timeline.some(e=>e.type==='portal_link'));
  const token=link.url.split('/').pop();
  const view=await fetch(base+'/portal/api/'+token).then(r=>r.json());
  check('portal view shows subject and ticket ref',view.subject==='Rate mapping question'&&view.ticket_ref==='T-1006');
  check('portal view is sanitized',!JSON.stringify(view).includes('recipient_snapshot')&&!JSON.stringify(view).includes('agency_id')&&view.simulation===true);
  check('portal messages carry author + via',view.messages.length===1&&view.messages[0].author==='Ananya Rao'&&view.messages[0].via==='ops');
  const portalEventsBefore=agent.events.length;
  const rep=await fetch(base+'/portal/api/'+token+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:'Confirmed - the rate is contracted. The feed is stale on your side.'})});
  check('portal reply accepted',rep.status===201);
  const thread2=(await call(`/tickets/1006/threads/${th.id}`)).data;
  const pm=thread2.messages.find(m=>m.via==='portal');
  check('portal reply lands in thread as supplier',pm&&pm.author_name==='Skyline Travels supplier desk'&&pm.author_contact_name==='Skyline Travels supplier desk');
  check('internal thread untouched by portal',(await call(`/tickets/1006/threads/${internal.id}`)).data.messages.every(m=>m.via==='ops'));
  await sleep(400);
  check('portal reply publishes realtime event',agent.events.length>portalEventsBefore&&agent.events.some(e=>e.event==='ticket'&&JSON.parse(e.data).type==='thread_reply'&&JSON.parse(e.data).ticket===1006));
  check('malformed token 404',(await fetch(base+'/portal/api/deadbeef')).status===404);
  check('unknown token 404',(await fetch(base+'/portal/api/'+'a'.repeat(48))).status===404);
  check('oversized portal reply rejected',(await fetch(base+'/portal/api/'+token+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:'x'.repeat(2001)})})).status===400);
  const page=await fetch(base+'/portal/'+token);
  const html=await page.text();
  check('portal page served with simulation banner',page.status===200&&/Simulated portal for demo purposes only/.test(html));
  agent.close();priya.close();
  console.log(`All ${pass} realtime/intent/portal checks passed.`);process.exit(0);
 }catch(e){console.error(e);process.exit(1);}
});
