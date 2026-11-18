// Extra demo state for the five demo journeys. Loaded only by `node seed.js --demo`
// (npm run seed:demo), so the regression tests keep the smaller base seed.
// It writes the same rows the API would write, so the UI shows them like live data.
const { db, logActivity } = require('./db');
require('./travel'); // creates work_queue column and ticket_feedback table
// collaboration creates the side-conversation and routing tables. It only needs the
// app to register routes, so a no-op stand-in is enough here.
const noop = () => {};
require('./collaboration')({ get: noop, post: noop, put: noop, delete: noop, use: noop }, { currentUser: noop, canSeeAll: noop, getTicketScoped: noop });

const stamp = hoursAgo => new Date(Date.now() - hoursAgo * 3600000).toISOString().replace('T', ' ').slice(0, 19);
const travelDate = days => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const tkt = db.prepare(`INSERT INTO tickets
  (id, title, description, agency_id, tboh, priority, intent_id, status, check_in_date, lcd_date, created_by, assigned_to, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const audit = db.prepare('INSERT INTO routing_audit(ticket_id,actor_id,old_owner,new_owner,reason,created_at) VALUES(?,?,?,?,?,?)');

// Journey C: a ticket that changed owner while a supplier conversation was active.
// The recipients stay the same after the transfer.
const t1 = stamp(1);
tkt.run(1008, 'Airport pickup not confirmed by supplier',
  'Skyline needs the Singapore airport pickup for TBOH-88502 confirmed. The supplier has not replied to the voucher request.',
  1, 'TBOH-88502', 'P2', 'supplier_confirmation', 'Open', travelDate(3), null, 5, 2, t1, t1);
logActivity(1008, 5, 'created', 'Priya Menon opened the ticket (Supplier confirmation, P2)');
logActivity(1008, 2, 'assigned', 'Assigned to Rohit Sharma');
logActivity(1008, 2, 'status_changed', 'New -> Open: Asked supplier desk for the voucher');
audit.run(1008, 2, null, 2, 'Assigned to Rohit Sharma; manual by Rohit Sharma', stamp(0.97));
const thread = db.prepare("INSERT INTO side_threads(ticket_id,subject,visibility,created_by,created_at) VALUES(?,?,?,?,?)").run(1008, 'Voucher for TBOH-88502 pickup', 'external', 2, stamp(0.92)).lastInsertRowid;
const recipients = db.prepare('SELECT * FROM side_contacts WHERE id IN (101, 5)').all(); // Skyline supplier desk + requester
for (const c of recipients) db.prepare('INSERT INTO side_recipients(thread_id,contact_id) VALUES(?,?)').run(thread, c.id);
const snap = JSON.stringify(recipients);
const msg = db.prepare('INSERT INTO side_messages(thread_id,author_id,author_contact_id,via,body,recipient_snapshot,created_at) VALUES(?,?,?,?,?,?,?)');
msg.run(thread, 2, null, 'ops', 'Please confirm the pickup voucher for TBOH-88502, arrival 3 days from now. Agency is waiting.', snap, stamp(0.92));
msg.run(thread, null, 101, 'portal', 'Voucher is being issued. We need the flight number to finish it.', snap, stamp(0.7));
// The transfer: Rohit hands the ticket to Ananya, who covers APAC.
db.prepare("UPDATE tickets SET assigned_to=1,updated_at=? WHERE id=1008").run(stamp(0.5));
audit.run(1008, 4, 2, 1, 'Reassigned to Ananya Rao; manual by Arjun Nair: shift handover, APAC region match', stamp(0.5));
logActivity(1008, 4, 'assigned', 'Reassigned to Ananya Rao; manual by Arjun Nair: shift handover, APAC region match');
msg.run(thread, 1, null, 'ops', 'Ananya here, I took over this ticket. Flight is SQ423, landing 09:10. Please send the voucher.', snap, stamp(0.25));

// Journey E (conversation insights): the text below is what the "From conversations" insight reads.
// T-1007 is tagged by its default intent (cancellation) but the ops thread is about a delayed refund,
// and two tickets repeat the phrase "supplier allotment". Messages are demo text only.
{
  const opsThread = db.prepare("INSERT INTO side_threads(ticket_id,subject,visibility,created_by,created_at) VALUES(?,?,?,?,?)").run(1007, 'Cancellation terms and money back', 'internal', 2, stamp(0.7)).lastInsertRowid;
  const ops = db.prepare('SELECT * FROM side_contacts WHERE id IN (1, 2)').all();
  for (const c of ops) db.prepare('INSERT INTO side_recipients(thread_id,contact_id) VALUES(?,?)').run(opsThread, c.id);
  const osnap = JSON.stringify(ops);
  msg.run(opsThread, 2, null, 'ops', 'Supplier confirms the cancellation, but the refund for the cancelled hotel is delayed. Their finance team says refund pending, no date yet.', osnap, stamp(0.6));
  msg.run(opsThread, 1, null, 'ops', 'Agency asks again about the refund delay. Supplier allotment was released but the money is not back.', osnap, stamp(0.4));
  const t6 = db.prepare("INSERT INTO side_threads(ticket_id,subject,visibility,created_by,created_at) VALUES(?,?,?,?,?)").run(1006, 'Rooms still showing sold out', 'internal', 2, stamp(0.4)).lastInsertRowid;
  for (const c of ops) db.prepare('INSERT INTO side_recipients(thread_id,contact_id) VALUES(?,?)').run(t6, c.id);
  msg.run(t6, 2, null, 'ops', 'Supplier allotment shows rooms free but our inventory still says sold out. Looks like the inventory sync lags.', osnap, stamp(0.3));
}

// Journey D: one ticket already waiting in the Escalation Manager queue.
const t2 = stamp(9);
tkt.run(1009, 'Visa letter missing, flight in 30 hours',
  'Nordvik Reiser: the visa support letter for TBOH-77120 has not arrived. Passenger flies tomorrow evening and the airline will refuse boarding without it.',
  3, 'TBOH-77120', 'P1', 'documentation', 'Escalated', travelDate(1), travelDate(1), 7, 3, t2, t2);
db.prepare("UPDATE tickets SET work_queue='escalation' WHERE id=1009").run();
logActivity(1009, 7, 'created', 'Ingrid Berg opened the ticket (Visa & documentation, P1)');
logActivity(1009, 2, 'assigned', 'Assigned to Rohit Sharma');
audit.run(1009, 2, null, 2, 'Assigned to Rohit Sharma; manual by Rohit Sharma', stamp(8.8));
const why = 'Open -> Escalated; Escalated to Escalation Manager Meera Iyer; operations -> escalation queue: check-in tomorrow, supplier has not issued the letter';
audit.run(1009, 2, 2, 3, why, stamp(8.7));
logActivity(1009, 2, 'escalated', why);

// Journey E: ops theme tags and a product reference, so insights show more than default intents.
const fb = db.prepare('INSERT OR REPLACE INTO ticket_feedback(ticket_id,themes,product_ref,updated_by) VALUES(?,?,?,?)');
fb.run(1003, JSON.stringify(['payment_issue', 'refund_delay']), 'BUG-1182 refund status does not sync to agency portal', 4);
fb.run(1006, JSON.stringify(['inventory_sync']), 'BUG-1190 sold-out flag lags supplier allotment', 4);
fb.run(1009, JSON.stringify(['documentation', 'supplier_confirmation']), '', 4);
fb.run(1002, JSON.stringify(['other']), '', 4); // hurried tag: the wording says refund delay, which conversation insights flag as not tagged yet

// SLA mix for Journey D: one breached (1009), two at risk (1003, 1007), the rest on track.
// Ages are relative to seeding time, so SLA states drift as real time passes:
// run `npm run seed:demo` shortly before a demo.
for (const [id, hours] of [[1001, 2], [1002, 1.5], [1003, 3.25], [1004, 6], [1005, 1], [1006, 0.5], [1007, 0.8], [1008, 1]]) {
  db.prepare('UPDATE tickets SET created_at=?,updated_at=? WHERE id=?').run(stamp(hours), stamp(hours), id);
}
// Timeline rows are written "now" by logActivity. Spread them from each ticket's creation
// time, one ten minutes apart, so the timeline never shows events before the ticket opened.
for (const t of db.prepare('SELECT id, created_at FROM tickets').all()) {
  db.prepare('SELECT id FROM activity WHERE ticket_id=? ORDER BY id').all(t.id).forEach((a, i) =>
    db.prepare("UPDATE activity SET created_at=datetime(?, '+' || ? || ' minutes') WHERE id=?").run(t.created_at, i * 10, a.id));
}
console.log('Demo data: ticket 1008 (supplier thread, transferred), ticket 1009 (in Escalation Manager queue), theme tags on 1003, 1006, 1009.');
