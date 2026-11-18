// Real process restart: webhook endpoints, a pending retry, CSAT surveys and macros survive, and the retry resumes.
const {spawn}=require('child_process');const path=require('path');const os=require('os');const http=require('http');const assert=require('assert');
const DB=path.join(os.tmpdir(),'opsdesk-extr-'+Date.now()+'.db');
const env={...process.env,OPSDESK_DB:DB,OPSDESK_WEBHOOK_BACKOFF_MS:'1500,1500,1500',OPSDESK_WEBHOOK_MAX_ATTEMPTS:'5'};
require('child_process').execFileSync(process.execPath,[path.join(__dirname,'../seed.js')],{env});
let pass=0;const check=(n,v)=>{assert(v,n);pass++;console.log('  ok - '+n);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let hits=0,rxStatus=500;
const rx=http.createServer((q,s)=>{q.resume();q.on('end',()=>{hits++;s.statusCode=rxStatus;s.end('x');});});
function boot(port){return new Promise((res,rej)=>{const p=spawn(process.execPath,[path.join(__dirname,'../server.js')],{env:{...env,PORT:String(port)}});let out='';p.stdout.on('data',d=>{out+=d;if(out.includes('listening'))res(p);});p.on('error',rej);setTimeout(()=>rej(new Error('boot timeout')),8000);});}
const call=(port)=>async(p,user,body,method)=>{const r=await fetch(`http://127.0.0.1:${port}/api${p}`,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-User-Id':String(user)},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json().catch(()=>({}))};};
(async()=>{
 await new Promise(r=>rx.listen(0,'127.0.0.1',r));
 const port=4390+Math.floor(Math.random()*400);
 let srv=await boot(port),c=call(port);
 try{
  const ep=await c('/webhooks',4,{url:`http://127.0.0.1:${rx.address().port}/h`});
  const t=await c('/tickets',5,{title:'Restart test ticket',description:'x',priority:'P3',intent_id:'other'});
  await c(`/tickets/${t.data.id}/status`,1,{status:'Resolved'});
  await sleep(500);
  const before=hits;
  check('receiver was failing (attempt made before restart)',before>=1);
  const pend=(await c('/webhooks/deliveries?status=pending',1)).data.deliveries.length;
  check('retries are pending when the process stops',pend>=1);
  srv.kill();await new Promise(r=>srv.on('exit',r));
  rxStatus=200;
  srv=await boot(port);c=call(port);
  check('endpoint survived restart',(await c('/webhooks',1)).data.endpoints.some(e=>e.id===ep.data.id&&e.active));
  check('CSAT survey survived restart',(await c(`/tickets/${t.data.id}/csat`,1)).data.surveys[0].status==='pending');
  check('macros survived restart',(await c('/macros',1)).data.macros.length>=10);
  let delivered=0;for(let i=0;i<40&&!delivered;i++){await sleep(250);delivered=(await c('/webhooks/deliveries?status=delivered',1)).data.deliveries.length;}
  check('pending deliveries resume and succeed after restart',delivered>=1);
  check('nothing stays pending forever',await (async()=>{for(let i=0;i<40;i++){if(!(await c('/webhooks/deliveries?status=pending',1)).data.deliveries.length)return true;await sleep(250);}return false;})());
  console.log(`All ${pass} webhook/CSAT/macro restart checks passed.`);
 }catch(e){console.error('FAILED:',e.message);process.exitCode=1;}
 finally{srv.kill();rx.close();setTimeout(()=>process.exit(process.exitCode||0),100);}
})();
