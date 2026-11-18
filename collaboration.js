const {db,logActivity}=require('./db');
module.exports=(app,{currentUser,canSeeAll,getTicketScoped})=>{
 db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id),regions TEXT NOT NULL,available INTEGER NOT NULL DEFAULT 1 CHECK(available IN(0,1)));
 CREATE TABLE IF NOT EXISTS routing_audit(id INTEGER PRIMARY KEY,ticket_id INTEGER NOT NULL REFERENCES tickets(id),actor_id INTEGER NOT NULL REFERENCES users(id),old_owner INTEGER,new_owner INTEGER,reason TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
 CREATE TABLE IF NOT EXISTS side_contacts(id INTEGER PRIMARY KEY,name TEXT NOT NULL,address TEXT NOT NULL,agency_id INTEGER REFERENCES agencies(id),user_id INTEGER REFERENCES users(id),kind TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS side_threads(id INTEGER PRIMARY KEY,ticket_id INTEGER NOT NULL REFERENCES tickets(id),subject TEXT NOT NULL,visibility TEXT NOT NULL CHECK(visibility IN('internal','external')),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT(datetime('now')));
 CREATE TABLE IF NOT EXISTS side_recipients(thread_id INTEGER REFERENCES side_threads(id),contact_id INTEGER REFERENCES side_contacts(id),PRIMARY KEY(thread_id,contact_id));
 CREATE TABLE IF NOT EXISTS side_messages(id INTEGER PRIMARY KEY,thread_id INTEGER NOT NULL REFERENCES side_threads(id),author_id INTEGER REFERENCES users(id),author_contact_id INTEGER REFERENCES side_contacts(id),via TEXT NOT NULL DEFAULT 'ops' CHECK(via IN('ops','portal')),body TEXT NOT NULL,recipient_snapshot TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),CHECK(author_id IS NOT NULL OR author_contact_id IS NOT NULL));
 CREATE TABLE IF NOT EXISTS portal_links(id INTEGER PRIMARY KEY,thread_id INTEGER NOT NULL REFERENCES side_threads(id),contact_id INTEGER NOT NULL REFERENCES side_contacts(id),token TEXT NOT NULL UNIQUE,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL DEFAULT(datetime('now')),expires_at TEXT,revoked_at TEXT,UNIQUE(thread_id,contact_id));`);
 // Migration: first portal release lacked expiry/revocation. Add both and bound
 // any pre-existing link to 72h from its creation.
 if(!db.prepare('PRAGMA table_info(portal_links)').all().some(c=>c.name==='expires_at')){
  db.exec(`ALTER TABLE portal_links ADD COLUMN expires_at TEXT; ALTER TABLE portal_links ADD COLUMN revoked_at TEXT; UPDATE portal_links SET expires_at=datetime(created_at,'+72 hours') WHERE expires_at IS NULL;`);
 }
 // Migration: pre-portal databases have side_messages without via/author_contact_id
 // and a NOT NULL author_id. Rebuild the table, preserving every message.
 if(!db.prepare('PRAGMA table_info(side_messages)').all().some(c=>c.name==='via')){
  db.exec(`ALTER TABLE side_messages RENAME TO side_messages_old;
  CREATE TABLE side_messages(id INTEGER PRIMARY KEY,thread_id INTEGER NOT NULL REFERENCES side_threads(id),author_id INTEGER REFERENCES users(id),author_contact_id INTEGER REFERENCES side_contacts(id),via TEXT NOT NULL DEFAULT 'ops' CHECK(via IN('ops','portal')),body TEXT NOT NULL,recipient_snapshot TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),CHECK(author_id IS NOT NULL OR author_contact_id IS NOT NULL));
  INSERT INTO side_messages(id,thread_id,author_id,author_contact_id,via,body,recipient_snapshot,created_at) SELECT id,thread_id,author_id,NULL,'ops',body,recipient_snapshot,created_at FROM side_messages_old;
  DROP TABLE side_messages_old;`);
 }
 const profile=db.prepare('INSERT OR IGNORE INTO agent_profiles(user_id,regions,available) VALUES(?,?,1)');
 for(const u of db.prepare("SELECT id FROM users WHERE role='agent'").all()) profile.run(u.id,JSON.stringify(u.id===1?['APAC']:['MEA','Europe']));
 for(const u of db.prepare('SELECT * FROM users').all()) db.prepare('INSERT OR IGNORE INTO side_contacts(id,name,address,agency_id,user_id,kind) VALUES(?,?,?,?,?,?)').run(u.id,u.name,`demo-user-${u.id}@opsdesk.invalid`,u.agency_id,u.id,u.role==='requester'?'requester':'ops');
 for(const a of db.prepare('SELECT * FROM agencies').all()) db.prepare('INSERT OR IGNORE INTO side_contacts(id,name,address,agency_id,user_id,kind) VALUES(?,?,?,?,NULL,?)').run(100+a.id,`${a.name} supplier desk`,`supplier-${a.id}@opsdesk.invalid`,a.id,'supplier');
 const ops=(req,res)=>{if(!canSeeAll(req.user)){res.status(403).json({error:'Ops access only'});return false;}return true;};
 const ticket=(req,res)=>{const r=getTicketScoped(req,Number(req.params.id));if(r.error){res.status(r.error).json({error:'Ticket not accessible'});return null;}return r.ticket;};
 function profiles(){return db.prepare('SELECT p.*,u.name FROM agent_profiles p JOIN users u ON u.id=p.user_id ORDER BY u.id').all().map(p=>({...p,regions:JSON.parse(p.regions),available:!!p.available,load:db.prepare("SELECT COUNT(*) n FROM tickets WHERE assigned_to=? AND status NOT IN('Resolved','Closed')").get(p.user_id).n}));}
 function ownership(t,newId,actor,reason,writeActivity=true){
  db.transaction(()=>{db.prepare("UPDATE tickets SET assigned_to=?,work_queue=CASE WHEN (SELECT role FROM users WHERE id=?)='em' THEN 'escalation' ELSE 'operations' END,updated_at=datetime('now') WHERE id=?").run(newId,newId,t.id);db.prepare('INSERT INTO routing_audit(ticket_id,actor_id,old_owner,new_owner,reason) VALUES(?,?,?,?,?)').run(t.id,actor,t.assigned_to,newId,reason);if(writeActivity)logActivity(t.id,actor,'assigned',reason);})();
 }
 app.get('/api/routing/agents',currentUser,(req,res)=>{if(req.user.role==='em')return res.status(403).json({error:'Agent availability management is for agents and leads'});if(ops(req,res))res.json({agents:profiles(),simulation:true});});
 app.post('/api/routing/agents/:agentId',currentUser,(req,res)=>{
  if(!ops(req,res))return;if(req.user.role==='em')return res.status(403).json({error:'Agent availability management is for agents and leads'});const p=profiles().find(x=>x.user_id===Number(req.params.agentId));if(!p)return res.status(404).json({error:'Agent not found'});
  if(typeof (req.body||{}).available!=='boolean')return res.status(400).json({error:'available must be true or false'});
  db.prepare('UPDATE agent_profiles SET available=? WHERE user_id=?').run(+req.body.available,p.user_id);res.json({simulation:true,agents:profiles()});
 });
 app.post('/api/tickets/:id/route',currentUser,(req,res)=>{
  if(!ops(req,res))return;if(req.user.role==='em')return res.status(403).json({error:'Only agents and leads auto-route'});const t=ticket(req,res);if(!t)return;
  const agents=profiles().filter(a=>a.available).sort((a,b)=>Number(b.regions.includes(t.agency_region))-Number(a.regions.includes(t.agency_region))||a.load-b.load||a.user_id-b.user_id);
  if(!agents.length)return res.status(409).json({error:'No available agents. Ownership unchanged.'});
  const a=agents[0];const reason=`Auto-route: ${t.agency_region} ${a.regions.includes(t.agency_region)?'region match':'region fallback (no available regional agent)'}; available; ${t.priority} priority; active load ${a.load}; owner ${a.name}`;
  ownership(t,a.user_id,req.user.id,reason);res.json({assigned_to:a.user_id,reason});
 });
 app.get('/api/tickets/:id/routing',currentUser,(req,res)=>{if(!ops(req,res))return;const t=ticket(req,res);if(t)res.json({audit:db.prepare('SELECT r.*,u.name actor_name FROM routing_audit r JOIN users u ON u.id=r.actor_id WHERE ticket_id=? ORDER BY r.id').all(t.id)});});
 app.get('/api/tickets/:id/side-contacts',currentUser,(req,res)=>{const t=ticket(req,res);if(!t)return;
  if(!ops(req,res))return;
  res.json({contacts:db.prepare("SELECT * FROM side_contacts WHERE kind='ops' OR agency_id=? ORDER BY kind,name").all(t.agency_id),simulation:true});
 });
 function threadAccess(req,res){
  const t=ticket(req,res);if(!t)return null;
  const th=db.prepare('SELECT * FROM side_threads WHERE id=? AND ticket_id=?').get(Number(req.params.threadId),t.id);if(!th){res.status(404).json({error:'Thread not found'});return null;}
  if(!canSeeAll(req.user)&&(th.visibility!=='external'||!db.prepare('SELECT 1 FROM side_recipients r JOIN side_contacts c ON c.id=r.contact_id WHERE r.thread_id=? AND c.user_id=?').get(th.id,req.user.id))){res.status(403).json({error:'Thread not accessible'});return null;}
  return th;
 }
 function serialize(th){return {...th,recipients:db.prepare('SELECT c.* FROM side_recipients r JOIN side_contacts c ON c.id=r.contact_id WHERE thread_id=? ORDER BY c.id').all(th.id),messages:db.prepare('SELECT m.*,u.name author_name,c.name author_contact_name FROM side_messages m LEFT JOIN users u ON u.id=m.author_id LEFT JOIN side_contacts c ON c.id=m.author_contact_id WHERE thread_id=? ORDER BY m.id').all(th.id).map(m=>({...m,author_name:m.author_name||m.author_contact_name||'Unknown',recipients:JSON.parse(m.recipient_snapshot)})),simulation:true};}
 app.get('/api/tickets/:id/threads',currentUser,(req,res)=>{const t=ticket(req,res);if(!t)return;const rows=db.prepare('SELECT * FROM side_threads WHERE ticket_id=? ORDER BY id').all(t.id).filter(th=>canSeeAll(req.user)||(th.visibility==='external'&&db.prepare('SELECT 1 FROM side_recipients r JOIN side_contacts c ON c.id=r.contact_id WHERE r.thread_id=? AND c.user_id=?').get(th.id,req.user.id)));res.json({threads:rows.map(serialize),simulation:true});});
 app.post('/api/tickets/:id/threads',currentUser,(req,res)=>{
  if(!ops(req,res))return;const t=ticket(req,res);if(!t)return;const b=req.body||{};
  if(!['internal','external'].includes(b.visibility)||typeof b.subject!=='string'||!b.subject.trim()||b.subject.length>160||typeof b.body!=='string'||!b.body.trim()||b.body.length>5000||!Array.isArray(b.recipient_ids)||!b.recipient_ids.length||b.recipient_ids.length>20)return res.status(400).json({error:'Subject, body, visibility and explicit recipients required'});
  const ids=[...new Set(b.recipient_ids)];const contacts=ids.map(id=>Number.isInteger(id)?db.prepare('SELECT * FROM side_contacts WHERE id=?').get(id):null);
  if(contacts.some(c=>!c||(c.kind!=='ops'&&c.agency_id!==t.agency_id)||(b.visibility==='internal'&&c.kind!=='ops')))return res.status(400).json({error:'Recipient not allowed for this thread or agency'});
  const th=db.transaction(()=>{const id=db.prepare('INSERT INTO side_threads(ticket_id,subject,visibility,created_by) VALUES(?,?,?,?)').run(t.id,b.subject.trim(),b.visibility,req.user.id).lastInsertRowid;for(const c of contacts)db.prepare('INSERT INTO side_recipients(thread_id,contact_id) VALUES(?,?)').run(id,c.id);db.prepare('INSERT INTO side_messages(thread_id,author_id,body,recipient_snapshot) VALUES(?,?,?,?)').run(id,req.user.id,b.body.trim(),JSON.stringify(contacts));return db.prepare('SELECT * FROM side_threads WHERE id=?').get(id);})();res.status(201).json(serialize(th));
 });
 app.get('/api/tickets/:id/threads/:threadId',currentUser,(req,res)=>{const th=threadAccess(req,res);if(th)res.json(serialize(th));});
 app.post('/api/tickets/:id/threads/:threadId/messages',currentUser,(req,res)=>{const th=threadAccess(req,res);if(!th)return;
  if(typeof (req.body||{}).body!=='string'||!req.body.body.trim()||req.body.body.length>5000)return res.status(400).json({error:'Message required, at most 5000 characters'});
  if(Object.keys(req.body).some(k=>k!=='body'))return res.status(400).json({error:'Recipients and visibility are fixed per thread; create a separate thread for a different audience'});
  const contacts=serialize(th).recipients;db.prepare("INSERT INTO side_messages(thread_id,author_id,author_contact_id,via,body,recipient_snapshot) VALUES(?,?,NULL,'ops',?,?)").run(th.id,req.user.id,req.body.body.trim(),JSON.stringify(contacts));res.status(201).json(serialize(th));
 });
 // Supplier portal links (simulated): a token link per supplier recipient of an
 // external thread. The token is the capability - anyone holding it can read that
 // thread and reply as the supplier contact on the demo page. Ops-only to create;
 // one link per (thread, supplier), idempotent.
 app.post('/api/tickets/:id/threads/:threadId/portal-links',currentUser,(req,res)=>{
  if(!ops(req,res))return;const th=threadAccess(req,res);if(!th)return;
  if(th.visibility!=='external')return res.status(400).json({error:'Portal links are only for external (supplier-facing) threads'});
  const contactId=Number((req.body||{}).contact_id);
  const c=Number.isInteger(contactId)?db.prepare('SELECT * FROM side_contacts WHERE id=?').get(contactId):null;
  const isRecipient=c&&db.prepare('SELECT 1 FROM side_recipients WHERE thread_id=? AND contact_id=?').get(th.id,contactId);
  if(!c||c.kind!=='supplier'||!isRecipient)return res.status(400).json({error:'Portal links go to supplier recipients of this thread only'});
  let link=db.prepare('SELECT * FROM portal_links WHERE thread_id=? AND contact_id=?').get(th.id,contactId);
  if(link){
   // A live link is idempotent (same URL returned). Re-creating a REVOKED or
   // EXPIRED link mints a fresh capability: the old URL stays dead forever.
   const stale=link.revoked_at||db.prepare("SELECT expires_at<=datetime('now') AS e FROM portal_links WHERE id=?").get(link.id).e;
   if(stale){
    db.prepare("UPDATE portal_links SET token=?,revoked_at=NULL,expires_at=datetime('now','+72 hours') WHERE id=?").run(require('crypto').randomBytes(24).toString('hex'),link.id);
    logActivity(th.ticket_id,req.user.id,'portal_link',`Supplier portal link renewed for ${c.name} with a fresh URL (simulated; old URL stays disabled)`);
   }
   link=db.prepare('SELECT * FROM portal_links WHERE thread_id=? AND contact_id=?').get(th.id,contactId);
   return res.json({contact_id:c.id,contact_name:c.name,url:'/portal/'+link.token,expires_at:link.expires_at,simulation:true,note:'Simulated supplier portal. The link opens a demo page; nothing is sent outside OpsDesk. Links expire 72h after creation and can be revoked.'});
  }
  db.prepare("INSERT INTO portal_links(thread_id,contact_id,token,created_by,expires_at) VALUES(?,?,?,?,datetime('now','+72 hours'))").run(th.id,contactId,require('crypto').randomBytes(24).toString('hex'),req.user.id);
  link=db.prepare('SELECT * FROM portal_links WHERE thread_id=? AND contact_id=?').get(th.id,contactId);
  logActivity(th.ticket_id,req.user.id,'portal_link',`Supplier portal link created for ${c.name} (simulated, expires ${link.expires_at} UTC)`);
  res.status(201).json({contact_id:c.id,contact_name:c.name,url:'/portal/'+link.token,expires_at:link.expires_at,simulation:true,note:'Simulated supplier portal. The link opens a demo page; nothing is sent outside OpsDesk. Links expire 72h after creation and can be revoked.'});
 });
 // Revoke a portal link (ops only): the token stops working immediately.
 app.post('/api/tickets/:id/threads/:threadId/portal-links/revoke',currentUser,(req,res)=>{
  if(!ops(req,res))return;const th=threadAccess(req,res);if(!th)return;
  const contactId=Number((req.body||{}).contact_id);
  const link=Number.isInteger(contactId)?db.prepare('SELECT * FROM portal_links WHERE thread_id=? AND contact_id=?').get(th.id,contactId):null;
  if(!link)return res.status(404).json({error:'No portal link for that recipient'});
  if(!link.revoked_at){db.prepare("UPDATE portal_links SET revoked_at=datetime('now') WHERE id=?").run(link.id);logActivity(th.ticket_id,req.user.id,'portal_link_revoked','Supplier portal link revoked (simulated)');}
  res.json({contact_id:contactId,revoked:true,simulation:true});
 });
 return {ownership};
};
