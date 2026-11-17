// Rules-based intent classification (PS MVP-1: "rules or lightweight ML - document your approach").
// Approach: curated taxonomy; keyword hits in the title weigh 2x, description 1x.
// Confidence grows with hit count, capped below 1.0 because a rules engine is never certain.
// Manual select always overrides the suggestion. Lightweight ML is a documented future step.

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

function suggestIntent(title, description) {
  const t = (title || '').toLowerCase();
  const d = (description || '').toLowerCase();
  let best = null;
  for (const intent of INTENTS) {
    let score = 0;
    for (const kw of intent.keywords) {
      if (t.includes(kw)) score += 2;
      if (d.includes(kw)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { intent, score };
  }
  if (!best) return { intent_id: 'other', label: 'Other', confidence: 0, matched: [] };
  const matched = best.intent.keywords.filter(kw => t.includes(kw) || d.includes(kw));
  const confidence = Math.min(0.9, 0.45 + 0.15 * best.score);
  return { intent_id: best.intent.id, label: best.intent.label, confidence: Math.round(confidence * 100) / 100, matched };
}

module.exports = { INTENTS, suggestIntent };
