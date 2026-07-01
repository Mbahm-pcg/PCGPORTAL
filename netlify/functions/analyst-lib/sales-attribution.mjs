// sales-attribution.mjs — Sales Mix Intelligence (roadmap 9.3): detect per-category
// sales drops vs a day-of-week baseline, then ATTRIBUTE each drop to a likely cause —
// an open maintenance ticket whose equipment maps to that category (e.g. "ice machine
// down" → frozen/cold drinks), or (later) a nearby competitor promo. Pure + testable:
// callers pass in the item-category history (pcg_item_history_{pc}.categories) and the
// store's tickets; no I/O here.

// ── Equipment → affected sales categories ──────────────────────────────────
// Keyword-matched against a ticket's category + selectedIssues + title. 'all' means a
// throughput problem (POS/drive-thru) that suppresses every category. Categories use the
// same group names as classifyItem (hot_beverages / cold_beverages / frozen / sandwiches /
// wraps / bakery / snacks_sides / bottled).
const EQUIPMENT_MAP = [
  { match: ['espresso', 'coffee machine', 'brewer', 'coffee brewer', 'hot coffee'], categories: ['hot_beverages'] },
  { match: ['ice machine', 'ice maker', 'no ice', 'out of ice'], categories: ['cold_beverages', 'frozen'] },
  { match: ['frozen', 'frozen machine', 'refresher machine', 'slush', 'ice cream', 'soft serve'], categories: ['frozen'] },
  { match: ['refrigerat', 'cooler', 'walk-in', 'walk in', 'fridge', 'freezer'], categories: ['cold_beverages', 'frozen', 'sandwiches', 'bottled'] },
  { match: ['oven', 'toaster', 'fryer', 'grill', 'sandwich', 'panini', 'turbochef', 'merrychef'], categories: ['sandwiches', 'wraps', 'snacks_sides'] },
  { match: ['drive-thru', 'drive thru', 'drivethru', 'speaker', 'intercom', 'pos', 'register', 'kiosk', 'point of sale', 'system down'], categories: ['all'] },
];

// The categories a ticket likely suppresses. Returns a Set of group names, possibly {'all'}.
export function ticketAffectedCategories(ticket) {
  const text = [ticket?.category, ticket?.title, ...(Array.isArray(ticket?.selectedIssues) ? ticket.selectedIssues : [])]
    .filter(Boolean).join(' ').toLowerCase();
  const out = new Set();
  for (const rule of EQUIPMENT_MAP) {
    if (rule.match.some(k => text.includes(k))) rule.categories.forEach(c => out.add(c));
  }
  return out;
}

// Average a category's daily sales over the most recent `weeks` occurrences of the SAME
// weekday (history is newest-first). Excludes the target entry itself.
function dowCategoryBaseline(history, targetDow, category, weeks = 6, skipDate = null) {
  const vals = [];
  for (const e of (history || [])) {
    if (e?.dow !== targetDow || e?.date === skipDate) continue;
    const s = e.categories?.[category]?.sales;
    if (typeof s === 'number') vals.push(s);
    if (vals.length >= weeks) break;
  }
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { avg, samples: vals.length };
}

// Detect category sales drops for the most-recent day in `history` vs its day-of-week baseline.
// opts: dropThreshold (fraction, default 0.30), minBaselineSales ($ floor to ignore tiny
// categories, default 50), weeks. Returns [{category, expected, actual, dropPct, lostSales, samples}].
export function detectCategoryDrops(history, opts = {}) {
  const { dropThreshold = 0.30, minBaselineSales = 50, weeks = 6 } = opts;
  const latest = (history || [])[0];
  if (!latest || !latest.categories) return [];
  const drops = [];
  for (const [category, v] of Object.entries(latest.categories)) {
    if (category === 'other' || category === 'modifier') continue;
    const base = dowCategoryBaseline(history, latest.dow, category, weeks, latest.date);
    if (!base || base.avg < minBaselineSales || base.samples < 2) continue;
    const actual = v?.sales || 0;
    const dropPct = (base.avg - actual) / base.avg;
    if (dropPct >= dropThreshold) {
      drops.push({
        category,
        expected: Math.round(base.avg),
        actual: Math.round(actual),
        dropPct: Math.round(dropPct * 100),
        lostSales: Math.round(base.avg - actual),
        samples: base.samples,
        date: latest.date,
      });
    }
  }
  return drops.sort((a, b) => b.lostSales - a.lostSales);
}

// Attribute each category drop to an OPEN ticket at the store whose equipment maps to that
// category. Returns drops enriched with { cause } — a ticket match (high confidence) or null
// (unexplained). `openTickets` = the store's tickets with status !== 'Closed'.
export function attributeDrops(drops, openTickets = []) {
  const open = (openTickets || []).filter(t => t && t.status !== 'Closed');
  return (drops || []).map(d => {
    // Temporal causality: a ticket can only explain the drop if it existed on/before that
    // day. (Unknown/unparseable open time → allow, best-effort.)
    const dropEnd = d.date ? new Date(d.date + 'T23:59:59Z') : null;
    const candidates = open.filter(t => {
      const opened = t.createdAt || t.created_at;
      if (!opened || !dropEnd) return true;
      const od = new Date(opened);
      return isNaN(od.getTime()) || od <= dropEnd;
    });
    // Prefer a ticket whose SPECIFIC equipment maps to this category; only fall back to a
    // generic throughput ('all') ticket if none — so an ice-machine ticket wins over a POS
    // ticket for a frozen-drinks drop.
    const specific = candidates.find(t => { const c = ticketAffectedCategories(t); return !c.has('all') && c.has(d.category); });
    const generic = candidates.find(t => ticketAffectedCategories(t).has('all'));
    const t = specific || generic;
    if (t) {
      return {
        ...d,
        cause: {
          type: 'ticket',
          ticketNumber: t.number || t.id,
          ticketTitle: t.title || (Array.isArray(t.selectedIssues) ? t.selectedIssues[0] : '') || t.category,
          openedAt: t.createdAt || t.created_at || null,
          confidence: specific ? 'high' : 'medium',
        },
      };
    }
    return { ...d, cause: null };
  });
}

// One-shot: history + tickets → attributed category drops for a store.
export function analyzeStoreMix(history, openTickets, opts = {}) {
  return attributeDrops(detectCategoryDrops(history, opts), openTickets);
}

export { EQUIPMENT_MAP };
