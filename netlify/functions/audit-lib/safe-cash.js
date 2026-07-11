// safe-cash.js — pure cash-count math for Safe Audits. Money in integer cents. See spec §A3.
const BILL_VALUES = { hundreds:100, fifties:50, twenties:20, tens:10, fives:5, ones:1 };
const COIN_VALUES = { halfDollars:0.50, quarters:0.25, dimes:0.10, nickels:0.05, pennies:0.01 };
const DISPLAY_TOLERANCE = 0.50;
const SHORTAGE_ALERT_THRESHOLD = 5.00;
const REASONS = ['Random','Scheduled','Cash Discrepancy','Manager Change','Shift Change','Other'];

function toCount(v) {
  if (v === '' || v == null) return 0;
  const s = String(v).trim();
  if (!s || /^n\/?a$/i.test(s)) return 0;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
const cents = (n) => Math.round(n * 100);
const dollars = (c) => c / 100;

function sumCents(counts, values) {
  let c = 0;
  for (const k of Object.keys(values)) c += toCount(counts && counts[k]) * cents(values[k]);
  return c;
}

function computeCashTotals(billCounts, coinCounts) {
  const bC = sumCents(billCounts, BILL_VALUES);
  const cC = sumCents(coinCounts, COIN_VALUES);
  return { billsTotal: dollars(bC), coinsTotal: dollars(cC), countedTotal: dollars(bC + cC) };
}

function computeVariance({ countedTotal, receiptsTotal, expected }) {
  const acc = cents(countedTotal || 0) + cents(receiptsTotal || 0);
  const varc = acc - cents(expected || 0);
  const tol = cents(DISPLAY_TOLERANCE);
  const status = varc < -tol ? 'short' : varc > tol ? 'over' : 'balanced';
  return { accountedTotal: dollars(acc), variance: dollars(varc), status };
}

function shouldAlert({ variance, hasCounterfeit }) {
  return (Number(variance) <= -SHORTAGE_ALERT_THRESHOLD) || !!hasCounterfeit;
}

module.exports = { BILL_VALUES, COIN_VALUES, DISPLAY_TOLERANCE, SHORTAGE_ALERT_THRESHOLD, REASONS,
                   toCount, computeCashTotals, computeVariance, shouldAlert };
