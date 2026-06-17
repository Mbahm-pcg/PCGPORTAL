// PCG Portal — P&L Compute Core (pure, no I/O)
// Single source of truth for: Contribution = Revenue − Labor − COGS.
// COGS is hybrid: BOM (menu-mix × unit cost) when menu-mix explains enough
// revenue, else a category-% fallback. Callers inject sales/labor/menu-mix
// + a costOf(name) lookup so this module stays fully unit-testable.

const DEFAULT_COGS_PCT = 0.29;        // network fallback (~29% of sales)
const BOM_COVERAGE_THRESHOLD = 0.85;  // menu-mix must explain ≥85% of revenue to trust BOM

const round2 = (n) => Math.round((n || 0) * 100) / 100;
const pct1   = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0); // % to 1 dp

/**
 * Estimate COGS for a store/period using the hybrid method.
 * @param {Array<{name:string, slsCnt:number, slsTtl:number}>} menuMix
 * @param {(name:string)=>(number|undefined)} costOf
 * @param {number} revenue
 * @param {number} cogsPct  fractional fallback (e.g. 0.29)
 * @returns {{cogs:number, method:'BOM'|'est', coverage:number}}
 */
function computeCogs(menuMix, costOf, revenue, cogsPct) {
  const pct = (typeof cogsPct === 'number' && cogsPct > 0) ? cogsPct : DEFAULT_COGS_PCT;
  if (!revenue || revenue <= 0) return { cogs: 0, method: 'est', coverage: 0 };
  if (!Array.isArray(menuMix) || menuMix.length === 0) {
    return { cogs: round2(revenue * pct), method: 'est', coverage: 0 };
  }
  let bomCogs = 0, coveredRev = 0;
  for (const it of menuMix) {
    const unit = costOf(it.name);
    if (typeof unit === 'number' && unit > 0) {
      bomCogs    += (it.slsCnt || 0) * unit;
      coveredRev += (it.slsTtl || 0);
    }
  }
  const coverage = coveredRev / revenue;
  if (coverage >= BOM_COVERAGE_THRESHOLD) {
    const tail = Math.max(0, revenue - coveredRev) * pct; // estimate uncovered tail at category %
    return { cogs: round2(bomCogs + tail), method: 'BOM', coverage };
  }
  return { cogs: round2(revenue * pct), method: 'est', coverage };
}

/**
 * Full store P&L line.
 * @param {{revenue:number, labor:number, menuMix:Array, cogsPct:number}} inputs
 * @param {(name:string)=>(number|undefined)} costOf
 */
function computeStorePnL(inputs, costOf) {
  const revenue = Number(inputs.revenue) || 0;
  const labor   = Number(inputs.labor) || 0;
  const { cogs, method, coverage } = computeCogs(inputs.menuMix, costOf, revenue, inputs.cogsPct);
  const contribution = round2(revenue - labor - cogs);
  return {
    revenue: round2(revenue),
    labor:   round2(labor),
    cogs,
    contribution,
    marginPct: pct1(contribution, revenue),
    laborPct:  pct1(labor, revenue),
    cogsPct:   pct1(cogs, revenue),
    method,
    coverage:  Math.round(coverage * 1000) / 10, // 0..100, 1 dp
  };
}

export { computeStorePnL, computeCogs, DEFAULT_COGS_PCT, BOM_COVERAGE_THRESHOLD };
