// PCG Pulse — period-over-period sales comparison logic (pure, ESM, unit-tested).
// Single source of truth for the last-year convention, partial-period alignment,
// the same-store rule, and intraday curve scaling used by the Pulse KPI rows.
// Previously the 364-day rule was copy-pasted across AdminPulse, DistrictDetail
// and StoreDetail — keep it here and nowhere else.

export const LY_OFFSET_DAYS = 364;  // 52 exact weeks — preserves day-of-week
export const LW_OFFSET_DAYS = 7;

// YYYY-MM-DD shifted by `days`, anchored at local noon so DST never moves the date.
export function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// 0=Sun … 6=Sat
export function dowFor(ymd) {
  return new Date(ymd + 'T12:00:00').getDay();
}

// The current period's dates plus the matching last-week and last-year sets.
// Day mode  → one date each side.
// Week mode → Sunday through busDt, capped at todayStr (mirrors getWeekDates),
//             with each comparison date shifted individually so day-of-week
//             alignment holds for every element.
export function comparisonDates(busDt, viewMode, todayStr) {
  let current;
  if (viewMode === 'week') {
    const sun = shiftDate(busDt, -dowFor(busDt));
    current = [];
    for (let i = 0; i < 7; i++) {
      const ds = shiftDate(sun, i);
      if (ds <= todayStr) current.push(ds);
    }
  } else {
    current = [busDt];
  }
  return {
    current,
    lw: current.map(d => shiftDate(d, -LW_OFFSET_DAYS)),
    ly: current.map(d => shiftDate(d, -LY_OFFSET_DAYS)),
  };
}

// Percent change. Null (not Infinity/NaN) when there's no usable prior figure —
// callers render "—" for null.
export function delta(current, prior) {
  if (!prior || prior <= 0) return null;
  return (current - prior) / prior * 100;
}

// Sum the current and prior periods on a same-store basis.
//
// A store must have an 'ok' entry for EVERY date on BOTH sides to be counted. If
// it is missing anywhere it is dropped from both sides — otherwise a store that
// opened mid-period (Hatboro, relocated 2026) lands entirely on the growth side
// and inflates the delta, reading portfolio expansion as same-store improvement.
export function comparableTotals(dayStoreCache, currentDates, priorDates, pcs) {
  const cache = dayStoreCache || {};
  const hasAll = (pc, dates) =>
    dates.length > 0 && dates.every(d => cache[d] && cache[d][pc] && cache[d][pc].status === 'ok');

  const comparablePcs = [];
  const excludedPcs = [];
  for (const pc of (pcs || [])) {
    if (hasAll(pc, currentDates) && hasAll(pc, priorDates)) comparablePcs.push(pc);
    else excludedPcs.push(pc);
  }

  const sum = (dates) => {
    let netSales = 0, guests = 0;
    for (const d of dates) {
      for (const pc of comparablePcs) {
        const e = cache[d][pc];
        netSales += e.data.netSales || 0;
        guests   += e.data.guests   || 0;
      }
    }
    return { netSales, guests };
  };

  return {
    current: sum(currentDates),
    prior:   sum(priorDates),
    comparablePcs,
    excludedPcs,
  };
}
