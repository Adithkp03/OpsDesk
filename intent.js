// Intent classification for MVP-1 (PS: "manual select + simple auto-suggest (rules or
// lightweight ML - document your approach). Avoid free-text + brittle keywords only.").
//
// APPROACH: lightweight ML, fully offline - a multinomial Naive Bayes classifier over
// unigram + bigram features, trained on the curated travel-ops example corpus below
// (TRAINING_CORPUS, in-repo and reviewable). Three deliberate properties:
//
// 1. Negation-aware: tokens after a negation cue (not/no/never/without/don't...) up to
//    the end of the clause are marked NEG_, so "not a cancellation, it's a refund"
//    scores against NEG_cancellation, not cancellation. The corpus includes negated
//    examples so the model learns those features.
// 2. Abstention: if the top class posterior is below MIN_CONFIDENCE, or the two top
//    classes are closer than MIN_MARGIN (ambiguous mixed intent), suggestIntent returns
//    abstain: true with the best alternatives and the UI asks the agent to pick
//    manually. Low evidence is never forced into a confident answer.
// 3. Honest confidence: `confidence` is the model's posterior probability for the top
//    class given this small corpus - a relative measure over 8 trained intents (plus manual Other), not a
//    calibrated real-world accuracy. No held-out accuracy rate is claimed.
//
// Manual select always overrides the suggestion. A larger corpus or embeddings is a
// documented stretch item, not this stage.

const INTENTS = [
  { id: 'refund_delay', label: 'Refund delay', keywords: ['refund', 'reimbursement', 'money back', 'not received', 'pending amount'] },
  { id: 'booking_amendment', label: 'Booking amendment', keywords: ['amend', 'change date', 'modify', 'reschedule', 'name change', 'correction'] },
  { id: 'cancellation', label: 'Cancellation', keywords: ['cancel', 'cancellation', 'cancelled', 'canceled', 'drop booking'] },
  { id: 'payment_issue', label: 'Payment issue', keywords: ['charged twice', 'double charge', 'payment failed', 'card', 'invoice', 'overcharged', 'debit'] },
  { id: 'inventory_sync', label: 'Inventory sync', keywords: ['sold out', 'availability', 'inventory', 'sync', 'shows available', 'not bookable', 'mapping'] },
  { id: 'special_request', label: 'Special request', keywords: ['wheelchair', 'special', 'meal', 'honeymoon', 'extra bed', 'early check-in', 'assistance'] },
  { id: 'documentation', label: 'Visa & documentation', keywords: ['visa', 'document', 'voucher', 'confirmation letter', 'passport'] },
  { id: 'supplier_confirmation', label: 'Supplier confirmation', keywords: ['supplier', 'confirmation pending', 'reconfirm', 'partner', 'no response from'] },
  { id: 'other', label: 'Other', keywords: [] },
];

// Curated training corpus: realistic travel-agency ops phrasing, including negated and
// hyphenated variants. This corpus IS the model - review it when reviewing suggestions.
const TRAINING_CORPUS = [
  // refund_delay
  ['refund_delay', 'refund not received'], ['refund_delay', 'refund still pending'],
  ['refund_delay', 'money back not credited'], ['refund_delay', 'waiting for reimbursement'],
  ['refund_delay', 'refund for cancelled booking not received'], ['refund_delay', 'not a cancellation, it is a refund'],
  ['refund_delay', 'refund delayed again, client chasing'], ['refund_delay', 'amount not refunded yet'],
  ['refund_delay', 'refund status follow up'], ['refund_delay', 'reimbursement pending since last week'],
  ['refund_delay', 'money-back still not received'], ['refund_delay', 'refund pending for cancelled booking'],
  ['refund_delay', 'fourth reminder: refund still not credited'], ['refund_delay', 'client asks where the refund is'],
  // booking_amendment
  ['booking_amendment', 'change travel dates'], ['booking_amendment', 'modify the booking'],
  ['booking_amendment', 'reschedule the flight'], ['booking_amendment', 'name correction on the ticket'],
  ['booking_amendment', 'amend passenger name'], ['booking_amendment', 'move check-in date'],
  ['booking_amendment', 'update the itinerary'], ['booking_amendment', 'change room type'],
  ['booking_amendment', 'not a cancellation, just a date change'], ['booking_amendment', 'do not cancel, only modify dates'],
  ['booking_amendment', 'shift booking to next week'], ['booking_amendment', 'correct spelling of traveller name'],
  ['booking_amendment', 'need to modify the reservation'], ['booking_amendment', 'amend booking dates please'],
  // cancellation
  ['cancellation', 'cancel this booking'], ['cancellation', 'cancel the hotel reservation'],
  ['cancellation', 'cancellation request from agency'], ['cancellation', 'client wants to cancel'],
  ['cancellation', 'booking cancelled by airline'], ['cancellation', 'drop this booking'],
  ['cancellation', 'please cancel the tour'], ['cancellation', 'group cancellation, 12 pax'],
  ['cancellation', 'want to cancel the whole trip'], ['cancellation', 'cancel the reservation'],
  ['cancellation', 'booking cancellation'], ['cancellation', 'not an amendment, we want to cancel'],
  ['cancellation', 'within the free cancellation window'], ['cancellation', 'cancel before the LCD'],
  // payment_issue
  ['payment_issue', 'charged twice on my card'], ['payment_issue', 'double charge for the booking'],
  ['payment_issue', 'payment failed but amount debited'], ['payment_issue', 'card charged but no confirmation'],
  ['payment_issue', 'invoice mismatch'], ['payment_issue', 'overcharged for the hotel'],
  ['payment_issue', 'payment gateway error'], ['payment_issue', 'duplicate payment taken'],
  ['payment_issue', 'card declined at payment'], ['payment_issue', 'payment not going through'],
  ['payment_issue', 'debited twice'], ['payment_issue', 'wrong amount charged'],
  ['payment_issue', 'need the invoice for this payment'], ['payment_issue', 'card verification failed'],
  // inventory_sync
  ['inventory_sync', 'hotel shows sold out but supplier confirms rooms'], ['inventory_sync', 'availability not syncing'],
  ['inventory_sync', 'inventory mismatch'], ['inventory_sync', 'shows available but not bookable'],
  ['inventory_sync', 'mapping issue with supplier content'], ['inventory_sync', 'rooms are not syncing'],
  ['inventory_sync', 'rate not updating'], ['inventory_sync', 'inventory sync issue'],
  ['inventory_sync', 'sold out on the portal but available with the supplier'], ['inventory_sync', 'availability calendar is wrong'],
  ['inventory_sync', 'content mapping problem'], ['inventory_sync', 'stop sale not reflecting'],
  // special_request
  ['special_request', 'wheelchair assistance for airport transfer'], ['special_request', 'honeymoon decoration in the room'],
  ['special_request', 'extra bed for a child'], ['special_request', 'early check-in request'],
  ['special_request', 'special meal request'], ['special_request', 'late checkout please'],
  ['special_request', 'airport assistance needed'], ['special_request', 'dietary requirements for the group'],
  ['special_request', 'anniversary setup in the room'], ['special_request', 'crib for the infant'],
  ['special_request', 'accessible room needed'], ['special_request', 'special assistance at the airport'],
  // documentation
  ['documentation', 'visa documents required'], ['documentation', 'voucher not received'],
  ['documentation', 'need a confirmation letter'], ['documentation', 'passport copy for the booking'],
  ['documentation', 'visa support letter'], ['documentation', 'travel documents pending'],
  ['documentation', 'hotel voucher missing'], ['documentation', 'confirmation letter for the embassy'],
  ['documentation', 'document checklist for the client'], ['documentation', 'resend the voucher'],
  ['documentation', 'booking confirmation pdf'], ['documentation', 'visa appointment letter'],
  // supplier_confirmation
  ['supplier_confirmation', 'supplier is not confirming'], ['supplier_confirmation', 'confirmation pending from supplier'],
  ['supplier_confirmation', 'no response from the supplier'], ['supplier_confirmation', 'reconfirm with the partner hotel'],
  ['supplier_confirmation', 'supplier confirmation awaited'], ['supplier_confirmation', 'partner is not responding'],
  ['supplier_confirmation', 'pending supplier confirmation'], ['supplier_confirmation', 'follow up with the supplier'],
  ['supplier_confirmation', 'supplier has not reconfirmed'], ['supplier_confirmation', 'awaiting hotel confirmation from the supplier'],
  ['supplier_confirmation', 'chase the supplier for confirmation'], ['supplier_confirmation', 'on request with the supplier'],
  // Conversation phrasing: how these intents actually read mid-thread (replies,
  // follow-ups, chasers) rather than in freshly written ticket titles. Added so
  // suggestions built from conversation text stay accurate.
  ['refund_delay', 'any update on my refund'], ['refund_delay', 'still waiting for the money to come back'],
  ['refund_delay', 'the client keeps asking where their refund is'], ['refund_delay', 'chasing the refund again'],
  ['booking_amendment', 'can we move the dates to next week'], ['booking_amendment', 'guest now arrives on friday, please change the booking'],
  ['cancellation', 'the guests are not coming anymore, cancel it'], ['cancellation', 'client pulled out of the trip'],
  ['payment_issue', 'the amount was taken twice from the card'], ['payment_issue', 'payment went through but the booking is not confirmed'],
  ['inventory_sync', 'your portal shows no rooms but the hotel says they have them'], ['inventory_sync', 'the rate on the site is stale'],
  ['special_request', 'can you arrange a wheelchair at the airport'], ['special_request', 'they are celebrating their anniversary, something nice in the room'],
  ['documentation', 'we still have not received the voucher'], ['documentation', 'please resend the confirmation letter'],
  ['supplier_confirmation', 'the hotel has not confirmed yet'], ['supplier_confirmation', 'no reply from the property so far'],
];

const NEGATION_CUES = new Set(['not', 'no', 'never', 'isnt', "isn't", 'dont', "don't", 'doesnt', "doesn't", 'didnt', "didn't", 'without', 'cant', "can't", 'wont', "won't", 'hardly']);
const CLAUSE_BREAK = /[,;.!?]|\b(?:but|however|instead|only)\b/;
const MIN_CONFIDENCE = 0.5;  // top-class posterior needed to offer a suggestion
const MIN_MARGIN = 0.12;     // gap needed between the top two classes
const AMBIGUITY_RATIO = 0.3; // mixed intent: a second class with this much independent support
const ALPHA = 0.5;           // Laplace-style smoothing
const TEMPER = 0.5;          // likelihood tempering reduces NB score saturation;
                             // scaling the log-likelihood reduces saturation and lets
                             // mixed/ambiguous text fall into the abstention band.

// Tokenize with negation marking: after a cue, prefix NEG_ until the clause ends.
// Hyphens/slashes become spaces, so "money-back" tokens match "money back" examples.
// Returns one token array per clause so bigrams never span a clause boundary
// ("...cancellation, it is...") and can't produce nonsense evidence.
function tokenizeClauses(text) {
  const clauses = String(text || '').toLowerCase().split(CLAUSE_BREAK);
  const out = [];
  for (const clause of clauses) {
    const toks = [];
    let negate = false;
    for (const raw of clause.replace(/['’]t\b/g, 't').split(/[^a-z0-9']+/)) {
      if (!raw) continue;
      if (NEGATION_CUES.has(raw)) { negate = true; toks.push(raw); continue; }
      toks.push(negate ? 'neg_' + raw : raw);
    }
    if (toks.length) out.push(toks);
  }
  return out;
}

function featuresFromText(text) {
  const f = [];
  for (const toks of tokenizeClauses(text)) {
    for (let i = 0; i < toks.length; i++) {
      f.push(toks[i]);
      if (i > 0) f.push(toks[i - 1] + ' ' + toks[i]);
    }
  }
  return f;
}

// Train the model once at require time.
const MODEL = (() => {
  const classDocs = new Map(); // id -> {count, feats: Map(feature -> n), total}
  const vocab = new Set();
  for (const [id, text] of TRAINING_CORPUS) {
    if (!classDocs.has(id)) classDocs.set(id, { count: 0, feats: new Map(), total: 0 });
    const c = classDocs.get(id);
    c.count++;
    for (const f of featuresFromText(text)) {
      vocab.add(f);
      c.feats.set(f, (c.feats.get(f) || 0) + 1);
      c.total++;
    }
  }
  const totalDocs = TRAINING_CORPUS.length;
  return { classDocs, vocab, totalDocs };
})();

function classify(text) {
  const feats = featuresFromText(text).filter(f => MODEL.vocab.has(f));
  const V = MODEL.vocab.size;
  const logps = [];
  for (const [id, c] of MODEL.classDocs) {
    let lp = Math.log(c.count / MODEL.totalDocs);
    for (const f of feats) {
      lp += TEMPER * Math.log(((c.feats.get(f) || 0) + ALPHA) / (c.total + ALPHA * V));
    }
    logps.push([id, lp]);
  }
  const max = Math.max(...logps.map(x => x[1]));
  const norm = logps.map(([id, lp]) => [id, Math.exp(lp - max)]);
  const sum = norm.reduce((a, x) => a + x[1], 0);
  return norm.map(([id, p]) => ({ id, p: p / sum })).sort((a, b) => b.p - a.p);
}

// Terms shown to the agent as evidence: the features in the text that most favour the
// winner over the runner-up. Stopword unigrams are hidden, a minimum contribution is
// required, and a negated token renders as "not <word>" (never "not not <word>").
const STOP = new Set(['the', 'a', 'an', 'this', 'is', 'it', 'my', 'but', 'has', 'to', 'on', 'for', 'and', 'of', 'in', 'still', 'please', 'only', 'we', 'want', 'yet', 'again', 'from', 'with', 'are', 'be', 'been', 'by', 'at', 'or', 'as', 'if', 'so', 'do', 'did', 'does', 'have', 'client', 'agency', 'hotel', 'booking']);
const MIN_EVIDENCE = 0.35;   // nats of log-odds favouring the winner before a term is shown

function pretty(f) {
  const toks = f.split(' ');
  return toks.map((t, i) => {
    if (!t.startsWith('neg_')) return t;
    const w = t.slice(4);
    return (i > 0 && (NEGATION_CUES.has(toks[i - 1]) || toks[i - 1].startsWith('neg_'))) ? w : 'not ' + w;
  }).join(' ');
}

function evidence(featsPresent, bestId, secondId) {
  const V = MODEL.vocab.size;
  const c1 = MODEL.classDocs.get(bestId), c2 = MODEL.classDocs.get(secondId);
  const scored = [];
  for (const f of featsPresent) {
    if (!MODEL.vocab.has(f)) continue;
    const toks = f.split(' ');
    const content = toks.filter(t => !NEGATION_CUES.has(t));
    if (!content.length) continue;                                     // bare "not"/"no"
    if (content.every(t => STOP.has(t.replace('neg_', '')))) continue; // "it is", "on my"
    if (toks.length === 2 && toks.some(t => STOP.has(t.replace('neg_', '')))) continue; // "twice on", "a refund"
    if (toks.length === 2 && NEGATION_CUES.has(toks[0]) && toks[1].startsWith('neg_')) continue; // "not an" (the neg_ unigram shows it)
    const p1 = Math.log(((c1.feats.get(f) || 0) + ALPHA) / (c1.total + ALPHA * V));
    const p2 = Math.log(((c2.feats.get(f) || 0) + ALPHA) / (c2.total + ALPHA * V));
    if (p1 - p2 < MIN_EVIDENCE) continue;
    scored.push([p1 - p2, f]);
  }
  const seen = new Set();
  const out = [];
  for (const [, f] of scored.sort((a, b) => b[0] - a[0])) {
    const p = pretty(f);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 6) break;
  }
  return out;
}

// One-vs-rest discriminative support per class over the features present: how much
// evidence points at THIS class specifically rather than any other.
function classStrengths(featsPresent) {
  const V = MODEL.vocab.size;
  const ids = [...MODEL.classDocs.keys()];
  const totals = new Map(ids.map(id => [id, 0]));
  for (const f of featsPresent) {
    if (!MODEL.vocab.has(f)) continue;
    const lp = new Map();
    for (const id of ids) {
      const c = MODEL.classDocs.get(id);
      lp.set(id, Math.log(((c.feats.get(f) || 0) + ALPHA) / (c.total + ALPHA * V)));
    }
    for (const id of ids) {
      let bo = -Infinity;
      for (const id2 of ids) if (id2 !== id && lp.get(id2) > bo) bo = lp.get(id2);
      const d = lp.get(id) - bo;
      if (d > MIN_EVIDENCE) totals.set(id, totals.get(id) + d);
    }
  }
  return totals;
}

function suggestFromText(text) {
  const label = (id) => INTENTS.find(i => i.id === id).label;
  const ranked = classify(text);
  const [first, second] = ranked;
  const topFeats = featuresFromText(text);
  const matched = second ? evidence(topFeats, first.id, second.id) : [];

  // Ambiguity measure that NB overconfidence can't hide: per-class discriminative
  // strength = the log-odds evidence a class has that no OTHER class explains better.
  // Mixed text ("cancel X and refund Y") gives two classes strong independent support
  // even when the posterior crowns one winner.
  const strengths = classStrengths(topFeats);
  const support = [...strengths.values()].sort((a, b) => b - a);
  const [s1, s2] = support;
  // Evaluate independent coordinated requests separately so a long payment clause
  // cannot drown out a shorter voucher request. Negated actions remain marked.
  const clauseWinners = new Set();
  for (const part of text.split(/[,;.!?]|\b(?:and|also|plus|but|however|instead)\b/i)) {
    const r = classify(part)[0];
    const strength = classStrengths(featuresFromText(part)).get(r.id) || 0;
    if (strength >= 2.5) clauseWinners.add(r.id);
  }
  const affirmative = topFeats.filter(f => !f.includes('neg_') && !f.split(' ').some(t => NEGATION_CUES.has(t)));
  const affirmativeSupport = classStrengths(affirmative).get(first.id) || 0;
  const negated = new Set(topFeats.filter(f => !f.includes(' ') && f.startsWith('neg_')).map(f => f.slice(4)));
  const contradiction = affirmative.some(f => !f.includes(' ') && !STOP.has(f) && negated.has(f));
  const abstain = affirmativeSupport < 1.5 || contradiction || matched.length === 0 || s1 < 2.5 || clauseWinners.size > 1 || first.p < MIN_CONFIDENCE
    || (second && first.p - second.p < MIN_MARGIN)
    || (s1 > 0 && s2 >= AMBIGUITY_RATIO * s1);
  if (abstain) {
    return {
      intent_id: 'other', label: 'Other', confidence: Math.min(0.99, Math.round(first.p * 100) / 100),
      matched, abstain: true, reason: clauseWinners.size > 1 || (s1 > 0 && s2 >= AMBIGUITY_RATIO * s1) ? 'Multiple intents need manual review' : 'Not enough clear evidence; select manually',
      alternatives: clauseWinners.size > 1 ? ranked.filter(r => clauseWinners.has(r.id)).map(r => ({ intent_id: r.id, label: label(r.id), confidence: Math.round(r.p * 100) / 100 })) : [],
    };
  }
  return {
    intent_id: first.id, label: label(first.id), confidence: Math.min(0.99, Math.round(first.p * 100) / 100),
    matched, abstain: false, alternatives: [],
  };
}

function suggestIntent(title, description) {
  return suggestFromText(`${title || ''}. ${description || ''}`);
}

// Conversation-weighted suggestion: the ticket title carries the strongest signal
// (x3), the description next (x2), and accumulated conversation text (thread
// replies, follow-ups) informs at x1, capped so a long thread cannot drown the
// original ask. Weights repeat the text, which multiplies feature counts exactly -
// the same evidence presented that many times. Clause splitting keeps repeated
// segments from inventing cross-segment bigrams, and abstention is unchanged: weak
// or mixed evidence still returns abstain, never a forced answer.
function suggestConversation({ title, description, conversation }) {
  const cap = (s, n) => String(s || '').slice(0, n);
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(cap(title, 500));
  for (let i = 0; i < 2; i++) parts.push(cap(description, 5000));
  const convo = cap(conversation, 8000).trim();
  if (convo) parts.push(convo);
  return suggestFromText(parts.filter(Boolean).join('. '));
}

module.exports = { INTENTS, suggestIntent, suggestConversation, TRAINING_CORPUS };
