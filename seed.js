// Seed data recommended by the problem statement:
// 3+ agencies; tickets sharing a TBOH with repeat intents ("same refund, three contacts");
// a mix of regions and priorities. SLA at-risk seeding lands with the SLA stage.
const { db, logActivity, linkTickets } = require('./db');
const { INTENTS } = require('./intent');

const wipe = process.argv.includes('--wipe');
if (wipe) {
  for(const name of ['side_messages','side_recipients','side_threads','side_contacts','routing_audit','agent_profiles']) {
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) db.exec('DELETE FROM '+name);
  }
  db.exec('DELETE FROM activity; DELETE FROM ticket_links; DELETE FROM tickets; DELETE FROM users; DELETE FROM agencies; DELETE FROM intents;');
}
if (db.prepare('SELECT COUNT(*) c FROM tickets').get().c > 0) {
  console.log('Already seeded. Run: node seed.js --wipe  to reseed.');
  process.exit(0);
}

const insIntent = db.prepare('INSERT INTO intents (id, label, keywords) VALUES (?,?,?)');
for (const i of INTENTS) insIntent.run(i.id, i.label, JSON.stringify(i.keywords));

const insAgency = db.prepare('INSERT INTO agencies (id, name, country, region) VALUES (?,?,?,?)');
insAgency.run(1, 'Skyline Travels', 'India', 'APAC');
insAgency.run(2, 'Desert Rose Tours', 'UAE', 'MEA');
insAgency.run(3, 'Nordvik Reiser', 'Norway', 'Europe');

const insUser = db.prepare('INSERT INTO users (id, name, role, agency_id) VALUES (?,?,?,?)');
insUser.run(1, 'Ananya Rao', 'agent', null);
insUser.run(2, 'Rohit Sharma', 'agent', null);
insUser.run(3, 'Meera Iyer', 'em', null);
insUser.run(4, 'Arjun Nair', 'lead', null);
insUser.run(5, 'Priya Menon', 'requester', 1);
insUser.run(6, 'Omar Haddad', 'requester', 2);
insUser.run(7, 'Ingrid Berg', 'requester', 3);

const ins = db.prepare(`INSERT INTO tickets
  (id, title, description, agency_id, tboh, priority, intent_id, status, check_in_date, lcd_date, created_by, assigned_to, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

// The headline story: one refund, three separate contacts, same TBOH (PS Problem 1 example).
ins.run(1001, 'Refund for cancelled Dubai city tour',
  'Booking TBOH-88213 was cancelled by the supplier on 10 Nov. Agency asked for a full refund of USD 420. No refund seen yet.',
  1, 'TBOH-88213', 'P2', 'refund_delay', 'Open', '2026-11-21', '2026-11-20', 5, 1, '2026-11-12 09:20:00', '2026-11-12 09:41:00');
ins.run(1002, 'Follow-up: refund still not received',
  'Second contact for TBOH-88213. Agency says their client is asking daily. Supplier confirmed cancellation but refund not processed.',
  1, 'TBOH-88213', 'P2', 'refund_delay', 'Pending', '2026-11-21', '2026-11-20', 5, 1, '2026-11-14 11:05:00', '2026-11-14 15:22:00');
ins.run(1003, 'Third reminder: refund pending, travel in 4 days',
  'Third time writing about the same refund for TBOH-88213. Travel date is close and the agency is threatening to escalate to their TBO account manager.',
  1, 'TBOH-88213', 'P1', 'refund_delay', 'New', '2026-11-21', '2026-11-20', 5, null, '2026-11-17 08:02:00', '2026-11-17 08:02:00');

// Mix of regions, priorities, intents.
ins.run(1004, 'Card charged twice for hotel booking',
  'Desert Rose reports their card was charged twice for TBOH-90155 (Atlantis 2 nights). Need one charge reversed before their statement closes.',
  2, 'TBOH-90155', 'P2', 'payment_issue', 'Open', '2026-11-25', null, 6, 2, '2026-11-15 13:44:00', '2026-11-16 10:12:00');
ins.run(1005, 'Wheelchair assistance for airport transfer',
  'Passenger on TBOH-77041 needs a wheelchair-equipped transfer in Oslo on arrival. Supplier to confirm vehicle type.',
  3, 'TBOH-77041', 'P3', 'special_request', 'Open', '2026-11-28', null, 7, 2, '2026-11-15 16:30:00', '2026-11-15 16:30:00');
ins.run(1006, 'Hotel shows sold out but supplier confirms rooms',
  'Skyline sees Marina Bay Residency as sold out on TBO for 18-20 Nov, but the supplier insists rooms are allocated. Looks like an inventory sync issue.',
  1, 'TBOH-88410', 'P2', 'inventory_sync', 'New', '2026-11-18', null, 5, null, '2026-11-16 19:11:00', '2026-11-16 19:11:00');
ins.run(1007, 'Group cancellation, 12 pax, check-in this week',
  'Desert Rose needs to cancel a 12-passenger group booking TBOH-90210 (Abu Dhabi hotels + transfers). Check-in is 19 Nov; wants cancellation terms confirmed first.',
  2, 'TBOH-90210', 'P1', 'cancellation', 'New', '2026-11-19', '2026-11-18', 6, null, '2026-11-17 07:15:00', '2026-11-17 07:15:00');

// Activity trail for the seed story.
logActivity(1001, 5, 'created', 'Priya Menon opened the ticket (Refund delay, P2)');
logActivity(1001, 1, 'assigned', 'Assigned to Ananya Rao');
logActivity(1001, 1, 'status_changed', 'New -> Open: Checking with supplier payments team');
logActivity(1002, 5, 'created', 'Priya Menon opened the ticket (Refund delay, P2)');
logActivity(1002, 1, 'assigned', 'Assigned to Ananya Rao');
logActivity(1002, 1, 'status_changed', 'New -> Open');
logActivity(1002, 1, 'status_changed', 'Open -> Pending: Waiting on finance approval for USD 420');
logActivity(1003, 5, 'created', 'Priya Menon opened the ticket (Refund delay, P1)');
logActivity(1004, 6, 'created', 'Omar Haddad opened the ticket (Payment issue, P2)');
logActivity(1004, 2, 'assigned', 'Assigned to Rohit Sharma');
logActivity(1004, 2, 'status_changed', 'New -> Open');
logActivity(1005, 7, 'created', 'Ingrid Berg opened the ticket (Special request, P3)');
logActivity(1005, 2, 'assigned', 'Assigned to Rohit Sharma');
logActivity(1005, 2, 'status_changed', 'New -> Open');
logActivity(1006, 5, 'created', 'Priya Menon opened the ticket (Inventory sync, P2)');
logActivity(1007, 6, 'created', 'Omar Haddad opened the ticket (Cancellation, P1)');

// First-class linkage for the repeat-contact case (no third-party app, per PS).
linkTickets(1001, 1002, 'Same booking (TBOH-88213) · Same agency + intent (Refund delay)', 1);
linkTickets(1002, 1003, 'Same booking (TBOH-88213) · Same agency + intent (Refund delay)', 1);
linkTickets(1001, 1003, 'Same booking (TBOH-88213) · Same agency + intent (Refund delay)', 1);

console.log('Seeded: 3 agencies, 7 users, 7 tickets, 3 links (refund case TBOH-88213).');
