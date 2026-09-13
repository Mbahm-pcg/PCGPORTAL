// src/pulse-sms.mjs
// Pure builder for the nightly PCG Pulse SMS. No I/O — unit-tested.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "$1,234.56" — comma-grouped, always 2 decimals. */
export function fmtUSD(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Parse "YYYY-MM-DD" as a date-only value (no timezone drift). */
function parseBusDt(busDt) {
  const [y, m, d] = String(busDt).split('-').map(Number);
  return { m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/**
 * Top N stores by WTD net sales, operational only, mapped to display names.
 * @param {{[pc:string]: number}} perStoreWtd
 * @param {Array<{pc:string,name:string}>} stores
 * @param {{[pc:string]: string}} statusByPc  pc -> status; missing = treated as operational
 * @param {number} n
 */
export function topStoresByWtd(perStoreWtd, stores, statusByPc = {}, n = 5) {
  const nameByPc = {};
  for (const s of stores) nameByPc[String(s.pc)] = s.name;
  return Object.entries(perStoreWtd)
    .filter(([pc]) => !statusByPc[pc] || statusByPc[pc] === 'Open')
    .map(([pc, wtd]) => ({ name: nameByPc[String(pc)] || String(pc), wtd: Number(wtd) || 0 }))
    .sort((a, b) => b.wtd - a.wtd)
    .slice(0, n);
}

/**
 * Build the nightly SMS text. Saturday (busDt weekday === 6) adds a Top 5 by WTD.
 * @param {{ busDt:string, todaySales:number, wtdSales:number, perStoreWtd:object, stores:Array, statusByPc?:object }} args
 */
export function buildPulseSms({ busDt, todaySales, wtdSales, perStoreWtd, stores, statusByPc = {} }) {
  const { m, d, dow } = parseBusDt(busDt);
  const lines = [
    `PCG Pulse Daily Update (${DOW[dow]} ${m}/${d})`,
    `Today's Sales: ${fmtUSD(todaySales)}`,
    `WTD Sales: ${fmtUSD(wtdSales)}`,
  ];
  if (dow === 6) {
    lines.push('Top 5:');
    topStoresByWtd(perStoreWtd, stores, statusByPc, 5)
      .forEach((s, i) => lines.push(`${i + 1}) ${s.name} ${fmtUSD(s.wtd)}`));
  }
  lines.push('Have a Good Night');
  return lines.join('\n');
}
