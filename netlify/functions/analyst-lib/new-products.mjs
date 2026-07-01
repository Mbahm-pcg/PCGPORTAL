// new-products.mjs — Sales Mix Intelligence (roadmap 9.3): track new product launch
// performance across the network. A tracked-product REGISTRY (pcg_new_products_v1, edited by
// exec/IT) names each launch + its POS match terms + launch date. The nightly snapshot matches
// those terms against each store's menu-item totals and records units/sales onto the item
// history (entry.newProducts[id] = { units, sales }). This module is the pure engine: registry
// I/O helper + the term matcher (shared with the snapshot) + the network roll-up. No live I/O
// beyond the injected cacheLoad.

export const NEW_PRODUCTS_KEY = 'pcg_new_products_v1';

// Registry entry: { id, name, terms:[string], launchDate:'YYYY-MM-DD', category? }.
// A product with no explicit terms falls back to matching on its name.
export async function loadNewProductRegistry(cacheLoad) {
  try {
    const reg = await cacheLoad(NEW_PRODUCTS_KEY);
    return Array.isArray(reg) ? reg.filter(p => p && p.id && p.name) : [];
  } catch { return []; }
}

// The lowercased match terms for a product (its `terms`, else its name split into itself).
export function productTerms(product) {
  const t = Array.isArray(product?.terms) && product.terms.length ? product.terms : [product?.name];
  return t.filter(Boolean).map(s => String(s).toLowerCase().trim()).filter(Boolean);
}

// Which registered product IDs a POS menu-item name matches (substring, case-insensitive).
// Used by the snapshot to tag daily units. A name can match more than one product.
export function matchNewProducts(registry, itemName) {
  const lower = (itemName || '').toLowerCase();
  if (!lower) return [];
  const ids = [];
  for (const p of (registry || [])) {
    if (productTerms(p).some(term => lower.includes(term))) ids.push(p.id);
  }
  return ids;
}

// Whole days between two YYYY-MM-DD dates (b - a). Null if either is unparseable.
function daysBetween(a, b) {
  const da = Date.parse(`${a}T12:00:00`), db = Date.parse(`${b}T12:00:00`);
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

// Roll a registry + per-store item histories into a network launch report. For each product:
// total units/sales since launch, adoption (# and % of stores selling it), a ramp curve
// (network units by day-since-launch, capped), and top/lagging stores. storeHistories =
// [{ store:{pc,name,district}, history:[{date, newProducts:{id:{units,sales}}}] }].
export function analyzeNewProducts(registry, storeHistories, { rampDays = 21 } = {}) {
  const stores = (storeHistories || []).filter(s => s && s.store);
  const totalStores = stores.length || 1;

  return (registry || []).map(product => {
    const perStore = [];       // { pc, name, district, units, sales }
    const rampUnits = {};      // dayIndex → network units
    let totalUnits = 0, totalSales = 0, firstSaleDate = null, lastSaleDate = null;

    for (const { store, history } of stores) {
      let units = 0, sales = 0;
      for (const e of (Array.isArray(history) ? history : [])) {
        const np = e?.newProducts?.[product.id];
        if (!np) continue;
        if (product.launchDate && e.date && e.date < product.launchDate) continue; // pre-launch noise
        const u = np.units || 0, s = np.sales || 0;
        if (u <= 0 && s <= 0) continue;
        units += u; sales += s;
        if (!firstSaleDate || e.date < firstSaleDate) firstSaleDate = e.date;
        if (!lastSaleDate || e.date > lastSaleDate) lastSaleDate = e.date;
        if (product.launchDate) {
          const di = daysBetween(product.launchDate, e.date);
          if (di != null && di >= 0 && di < rampDays) rampUnits[di] = (rampUnits[di] || 0) + u;
        }
      }
      if (units > 0 || sales > 0) {
        perStore.push({ pc: store.pc, name: store.name, district: store.district, units: Math.round(units), sales: Math.round(sales) });
      }
      totalUnits += units; totalSales += sales;
    }

    perStore.sort((a, b) => b.units - a.units);
    const selling = perStore.length;
    const ramp = [];
    for (let d = 0; d < rampDays; d++) if (rampUnits[d] != null) ramp.push({ day: d, units: Math.round(rampUnits[d]) });

    return {
      id: product.id,
      name: product.name,
      category: product.category || null,
      launchDate: product.launchDate || null,
      totalUnits: Math.round(totalUnits),
      totalSales: Math.round(totalSales),
      adoption: { selling, of: totalStores, pct: Math.round((selling / totalStores) * 100) },
      firstSaleDate, lastSaleDate,
      ramp,
      topStores: perStore.slice(0, 5),
      laggingStores: perStore.slice(-5).reverse().filter(s => !perStore.slice(0, 5).some(t => t.pc === s.pc)),
    };
  }).sort((a, b) => b.totalUnits - a.totalUnits);
}
