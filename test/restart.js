// Real OS-process restart persistence, not a second SQLite connection.
const {spawn, execFileSync} = require('child_process');
const path=require('path'), os=require('os'), fs=require('fs'), assert=require('assert');
const dbpath=path.join(os.tmpdir(),`opsdesk-restart-${process.pid}.db`);
const env={...process.env,OPSDESK_DB:dbpath,PORT:'4187'};
const root=path.join(__dirname,'..');
let child;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function start(){
 child=spawn(process.execPath,['server.js'],{cwd:root,env,stdio:'pipe'});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('server exited '+code)));});
}
async function stop(){const c=child;child=null;await new Promise(resolve=>{c.once('exit',resolve);c.kill('SIGTERM');});}
async function get(url){const r=await fetch('http://127.0.0.1:4187'+url,{headers:{'X-User-Id':'1'}});assert(r.ok);const data=await r.json();function stable(o){if(!o||typeof o!=='object')return; if(o.week)delete o.week.as_of;if(o.sla){delete o.sla.evaluated_at;delete o.sla.remaining_minutes;delete o.sla.state;}for(const v of Object.values(o))stable(v);}stable(data);return data;}
(async()=>{try{
 execFileSync(process.execPath,['seed.js'],{cwd:root,env,stdio:'pipe'});
 await start();
 await fetch('http://127.0.0.1:4187/api/tickets/1003/route',{method:'POST',headers:{'X-User-Id':'1','Content-Type':'application/json'},body:'{}'});
 const created=await fetch('http://127.0.0.1:4187/api/tickets/1003/threads',{method:'POST',headers:{'X-User-Id':'1','Content-Type':'application/json'},body:JSON.stringify({subject:'Restart proof',visibility:'internal',recipient_ids:[2],body:'Private saved note'})});assert.equal(created.status,201);
 await fetch('http://127.0.0.1:4187/api/tickets/1003/escalate',{method:'POST',headers:{'X-User-Id':'1','Content-Type':'application/json'},body:JSON.stringify({reason:'Restart escalation proof'})});
 await fetch('http://127.0.0.1:4187/api/tickets/1003/feedback',{method:'POST',headers:{'X-User-Id':'1','Content-Type':'application/json'},body:JSON.stringify({themes:['refund_delay','inventory_sync'],product_ref:'BUG restart-42'})});
 const snapshot={feedback:await get('/api/tickets/1003/feedback'),insights:await get('/api/insights'),queue:await get('/api/tickets'),detail:await get('/api/tickets/1003'),audit:await get('/api/tickets/1003/routing'),threads:await get('/api/tickets/1003/threads'),agents:await get('/api/routing/agents')};
 await stop();await start();
 assert.deepStrictEqual(await get('/api/tickets/1003/feedback'),snapshot.feedback);
 assert.deepStrictEqual(await get('/api/insights'),snapshot.insights);
 assert.equal(snapshot.detail.ticket.work_queue,'escalation');assert.equal(snapshot.detail.ticket.assigned_to,3);
 assert.deepStrictEqual(await get('/api/tickets'),snapshot.queue);
 assert.deepStrictEqual(await get('/api/tickets/1003'),snapshot.detail);
 assert.deepStrictEqual(await get('/api/tickets/1003/routing'),snapshot.audit);
 assert.deepStrictEqual(await get('/api/tickets/1003/threads'),snapshot.threads);
 assert.deepStrictEqual(await get('/api/routing/agents'),snapshot.agents);
 console.log('Real process restart: tickets, case history, ownership audit, thread recipients/messages, availability, escalation owner/queue and feedback/insights unchanged (live SLA countdown excluded, fixed deadline compared).');
 await stop();
} finally {if(child)await stop();for(const suffix of ['','-wal','-shm']){try{fs.unlinkSync(dbpath+suffix);}catch{}}}})().catch(e=>{console.error(e);process.exitCode=1;});
