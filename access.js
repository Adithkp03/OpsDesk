// Demo-role authorization. Authentication is intentionally a selectable demo header,
// not proof of identity. Every ticket read/write still checks its selected role.
const isOps=u=>['agent','em','lead'].includes(u.role);
function canRead(u,t){
 if(['agent','lead'].includes(u.role))return true;
 if(u.role==='em')return t.work_queue==='escalation';
 return u.role==='requester'&&t.agency_id===u.agency_id&&t.created_by===u.id;
}
function scope(u,alias='t'){
 if(['agent','lead'].includes(u.role))return {sql:'1=1',params:{}};
 if(u.role==='em')return {sql:`${alias}.work_queue='escalation'`,params:{}};
 return {sql:`${alias}.agency_id=@scope_agency AND ${alias}.created_by=@scope_creator`,params:{scope_agency:u.agency_id,scope_creator:u.id}};
}
module.exports={isOps,canRead,scope};
