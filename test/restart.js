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
async function get(url){const r=await fetch('http://127.0.0.1:4187'+url,{headers:{'X-User-Id':'1'}});assert(r.ok);return r.json();}
(async()=>{try{
 execFileSync(process.execPath,['seed.js'],{cwd:root,env,stdio:'pipe'});
 await start();
 const snapshot={queue:await get('/api/tickets'),detail:await get('/api/tickets/1003')};
 await stop();await start();
 assert.deepStrictEqual(await get('/api/tickets'),snapshot.queue);
 assert.deepStrictEqual(await get('/api/tickets/1003'),snapshot.detail);
 console.log('Real process restart: queue, linked case, source-ticket history unchanged.');
 await stop();
} finally {if(child)await stop();for(const suffix of ['','-wal','-shm']){try{fs.unlinkSync(dbpath+suffix);}catch{}}}})().catch(e=>{console.error(e);process.exitCode=1;});
