// Explicit demo policy, not a vendor SLA. Calendar hours, UTC date boundaries.
const POLICY={P1:4,P2:12,P3:24};
const iso=s=>new Date(s).toISOString();
const utc=s=>Date.parse(s.includes('T')||s.endsWith('Z')?s:s.replace(' ','T')+'Z');
function sla(t,now=Date.now()){
 const opened=utc(t.created_at),base=POLICY[t.priority]||24;
 let budget=base,reason=`${t.priority}: ${base} calendar hours from creation`;
 const dates=[['LCD',t.lcd_date],['Check-in',t.check_in_date]].filter(x=>x[1]).map(([name,date])=>({name,time:Date.parse(date+'T00:00:00Z'),date})).sort((a,b)=>a.time-b.time);
 const nearest=dates[0];
 // Travel proximity at creation fixes the budget. The travel date itself is also a hard cap.
 if(nearest){const hours=(nearest.time-opened)/3600000;const cap=hours<=24?1:hours<=72?4:hours<=168?12:Infinity;if(cap<budget){budget=cap;reason+=`; ${nearest.name} within ${hours<=24?'24':hours<=72?'72':'168'}h: ${cap}h budget`;}}
 const deadline=Math.min(opened+budget*3600000,nearest?.time??Infinity);
 if(nearest&&deadline===nearest.time)reason+=`; capped at ${nearest.name} ${nearest.date} 00:00 UTC`;
 const completed=['Resolved','Closed'].includes(t.status),at=completed&&t.completed_at?utc(t.completed_at):now;
 const remaining=deadline-at;const elapsed=at-opened;const allowed=Math.max(0,deadline-opened);
 const state=remaining<=0?'breached':elapsed>=allowed*.75?'at_risk':'on_track';
 return {state:completed?'completed':state,outcome:completed?(t.completed_at?(remaining<=0?'breached':'met'):'unknown'):null,deadline:iso(deadline),evaluated_at:iso(now),remaining_minutes:Math.round(remaining/60000),budget_hours:budget,reason,policy:'Calendar hours, no pauses. At risk after 75% of allowed time. Travel dates start at 00:00 UTC. No region holiday calendar.'};
}
module.exports={sla,POLICY,utc};
