// Conversation-derived insights (brief Problem 5: "insights stay locked in tickets").
// Offline and deterministic: no model calls, no network, no cost per ticket. It reads the same
// text ops can already read (ticket title, description, side-conversation messages) and
// produces two kinds of SUGGESTIONS. Nothing is written back to tickets or tags.
//   1. Conversation themes: the existing intent classifier (Naive Bayes, abstains when unsure)
//      run over the whole conversation, with the matched phrases as evidence. A ticket whose
//      conversation points at a theme its tags do not carry is flagged "not tagged yet".
//   2. Recurring phrases: two-word phrases that appear in conversations of 2 or more different
//      tickets this week, outside the fixed taxonomy. Shows what agencies keep writing about
//      even when no theme exists for it.
// Limits: bag-of-words, English only, small training corpus, no accuracy benchmark. At most
// MAX_TICKETS newest tickets are read per request so cost stays bounded.
const { INTENTS, suggestConversation } = require('./intent');

const MAX_TICKETS = 1000, MAX_MSGS = 12, MSG_CHARS = 1000;
const STOP = new Set(('the a an and or but of to in on for with at by from is are was were be been it this that these those my our your their we you they i he she not no yes ' +
  'please thanks thank hi hello dear regards kindly can could would will have has had do does did get got need needs want wants still again also just any all some more as if so than then there here when what which who whom how why ' +
  'ticket tickets agency agencies booking bookings client clients team customer').split(' '));

function words(text) { return String(text || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)); }

function phrases(text) {
  const out = new Set();
  for (const clause of String(text || '').toLowerCase().split(/[.,;:!?\n()]+/)) {
    const w = clause.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    for (let i = 0; i + 1 < w.length; i++) {
      const a = w[i], b = w[i + 1];
      if (a.length < 3 || b.length < 3 || STOP.has(a) || STOP.has(b) || /^\d+$/.test(a) || /^\d+$/.test(b)) continue;
      out.add(a + ' ' + b);
    }
  }
  return out;
}

function mine(db, tickets, tagsOf) {
  const used = tickets.slice(0, MAX_TICKETS);
  const msgs = new Map();
  for (let i = 0; i < used.length; i += 400) {
    const ids = used.slice(i, i + 400).map(t => t.id);
    const rows = db.prepare(`SELECT st.ticket_id tid, m.body FROM side_messages m JOIN side_threads st ON st.id=m.thread_id WHERE st.ticket_id IN (${ids.map(() => '?').join(',')}) ORDER BY m.id DESC`).all(...ids);
    for (const r of rows) { const a = msgs.get(r.tid) || []; if (a.length < MAX_MSGS) { a.push(String(r.body).slice(0, MSG_CHARS)); msgs.set(r.tid, a); } }
  }
  const byTheme = new Map(), phraseDocs = new Map();
  let withThread = 0, abstained = 0, notTagged = 0;
  for (const t of used) {
    const thread = (msgs.get(t.id) || []).join('\n');
    if (thread) withThread++;
    const s = suggestConversation({ title: t.title, description: t.description, conversation: thread });
    const tagged = tagsOf(t);
    if (s.abstain) abstained++;
    else {
      const g = byTheme.get(s.intent_id) || { id: s.intent_id, label: INTENTS.find(i => i.id === s.intent_id)?.label || s.intent_id, count: 0, not_tagged: 0, samples: [] };
      g.count++;
      const miss = !tagged.includes(s.intent_id);
      if (miss) { g.not_tagged++; notTagged++; }
      if (g.samples.length < 3 || (miss && !g.samples.some(x => x.not_tagged))) {
        const entry = { id: t.id, title: t.title, agency_name: t.agency_name, evidence: s.matched.slice(0, 4), not_tagged: miss, from_thread: !!thread };
        if (g.samples.length >= 3) g.samples[2] = entry; else g.samples.push(entry);
      }
      byTheme.set(s.intent_id, g);
    }
    for (const p of phrases(`${t.title}. ${t.description || ''}\n${thread}`)) {
      const d = phraseDocs.get(p) || []; d.push(t.id); phraseDocs.set(p, d);
    }
  }
  const recurring = [...phraseDocs].filter(([, ids]) => ids.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 8)
    .map(([phrase, ids]) => ({ phrase, tickets: ids.length, sample_ids: ids.slice(0, 3) }));
  return {
    themes: [...byTheme.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    recurring_phrases: recurring,
    coverage: { tickets_read: used.length, tickets_in_week: tickets.length, with_thread_messages: withThread, abstained, not_tagged: notTagged },
  };
}
module.exports = { mine, phrases, words };
