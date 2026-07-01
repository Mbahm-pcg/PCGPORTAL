// sales-mix-compare.mjs — Sales Mix Intelligence (roadmap 9.3): cross-store item
// comparison. Normalizes each store's category sales into a SHARE-OF-MIX profile (so a
// big store and a small store are comparable), then flags stores whose share of a
// category is meaningfully below (or above) their district-peer average — e.g.
// "Store 220 sells 40% fewer espresso drinks than the district average — equipment or
// training issue?". Pure + testable: callers pass in each store's category history
// (pcg_item_history_{pc}.categories); no I/O here.

// Categories that aren't a real sellable mix segment — excluded from the denominator so
// share percentages describe the actual product mix.
const NON_MIX = new Set(['other', 'modifier']);

// A store's category share-of-mix over its most recent `days` history entries that carry
// category data. Volume-weighted (sum category sales / sum all sales across the window), so
// a light day doesn't swing the profile. Returns { shares: {cat: pct 0-100}, catSales,
// totalSales, samples } or null when there isn't enough data.
export function storeMixProfile(history, { days = 28, minTotalSales = 500 } = {}) {
  const entries = (Array.isArray(history) ? history : []).filter(e => e && e.categories).slice(0, days);
  if (!entries.length) return null;
  const catSales = {};
  let totalSales = 0;
  for (const e of entries) {
    for (const [cat, v] of Object.entries(e.categories)) {
      if (NON_MIX.has(cat)) continue;
      const s = (v && typeof v.sales === 'number') ? v.sales : 0;
      if (s <= 0) continue;
      catSales[cat] = (catSales[cat] || 0) + s;
      totalSales += s;
    }
  }
  if (totalSales < minTotalSales) return null;
  const shares = {};
  for (const [cat, s] of Object.entries(catSales)) {
    shares[cat] = Math.round((s / totalSales) * 1000) / 10; // one decimal pct
  }
  return { shares, catSales, totalSales: Math.round(totalSales), samples: entries.length };
}

// Average category share across a set of store profiles (simple mean of each store's share,
// so the district "typical store mix" isn't dominated by one high-volume location). Returns
// { avgShares: {cat: pct}, storeCount }.
export function districtAverageShares(profiles) {
  const sums = {}; // cat → summed share across stores
  for (const p of profiles) {
    for (const [cat, share] of Object.entries(p.shares || {})) {
      sums[cat] = (sums[cat] || 0) + share;
    }
  }
  const avgShares = {};
  // Divide by the FULL peer count (stores that don't sell a category count as 0 share) so a
  // store selling zero espresso reads as below the peer average, not equal to it.
  for (const cat of Object.keys(sums)) avgShares[cat] = Math.round((sums[cat] / profiles.length) * 10) / 10;
  return { avgShares, storeCount: profiles.length };
}

// Compare each store's category share to its district-peer average and flag outliers.
// opts: gapThreshold (fraction, default 0.30 → "≥30% below/above peers"), minDistrictShare
// (pct-point floor so tiny categories don't generate noise, default 4), minPeers (default 3),
// includeAbove (also surface over-performers, default true).
// Returns [{ pc, name, district, totalSales, outliers: [{category, storeSharePct,
// districtSharePct, gapPct, direction}] }] sorted by the single largest below-peer gap.
export function compareCrossStore(profilesByStore, opts = {}) {
  const {
    gapThreshold = 0.30, minDistrictShare = 4, minPeers = 3, includeAbove = true,
  } = opts;

  // Group profiles by district.
  const byDistrict = new Map();
  for (const p of profilesByStore) {
    if (!p || !p.shares) continue;
    const d = String(p.district);
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d).push(p);
  }

  const results = [];
  for (const [, peers] of byDistrict) {
    if (peers.length < minPeers) continue; // not enough peers to average against
    const { avgShares } = districtAverageShares(peers);
    for (const p of peers) {
      const outliers = [];
      for (const [category, districtSharePct] of Object.entries(avgShares)) {
        if (districtSharePct < minDistrictShare) continue;
        const storeSharePct = p.shares[category] || 0;
        const gap = (districtSharePct - storeSharePct) / districtSharePct; // + = below peers
        if (gap >= gapThreshold) {
          outliers.push({ category, storeSharePct, districtSharePct, gapPct: Math.round(gap * 100), direction: 'below' });
        } else if (includeAbove && gap <= -gapThreshold) {
          outliers.push({ category, storeSharePct, districtSharePct, gapPct: Math.round(-gap * 100), direction: 'above' });
        }
      }
      if (!outliers.length) continue;
      // Biggest below-peer gap first within a store; below outranks above.
      outliers.sort((a, b) => (a.direction === b.direction ? b.gapPct - a.gapPct : a.direction === 'below' ? -1 : 1));
      results.push({ pc: p.pc, name: p.name, district: p.district, totalSales: p.totalSales, outliers });
    }
  }

  // Stores with the largest single below-peer gap surface first (over-performers-only stores last).
  const worstBelow = r => r.outliers.filter(o => o.direction === 'below').reduce((m, o) => Math.max(m, o.gapPct), 0);
  results.sort((a, b) => worstBelow(b) - worstBelow(a));
  return results;
}

// One-shot: [{ store, history }] → cross-store outliers. Stores lacking a usable profile are
// dropped. `store` carries { pc, name, district }.
export function analyzeCrossStoreMix(storeHistories, opts = {}) {
  const profiles = [];
  for (const { store, history } of (storeHistories || [])) {
    const prof = storeMixProfile(history, opts);
    if (prof) profiles.push({ pc: store.pc, name: store.name, district: store.district, ...prof });
  }
  return compareCrossStore(profiles, opts);
}
