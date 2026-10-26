// exec-data.test.mjs — the Executive view builders over fake blobs shaped like the real ones.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createExecData, cumThroughHour, addDaysYmd, isTestRecord } from './exec-data.mjs';

const stores = [
  { pc: '302642', name: 'County Line', city: 'Huntingdon Valley', district: 2, dmName: 'Jay Patel', status: 'Open', isNextGen: false, isBridge: false },
  { pc: '365953', name: 'Hatboro', city: 'Hatboro', district: 2, dmName: 'Jay Patel', status: 'Open', isNextGen: true, isBridge: false },
  { pc: '358933', name: 'Brace Rd', city: 'Cherry Hill', district: 8, dmName: 'Mike Bahm', status: 'Open', isNextGen: true, isBridge: false },
  { pc: '999999', name: 'Old Store', city: 'Nowhere', district: 8, dmName: 'Mike Bahm', status: 'Permanently Closed' },
];
const busDt = '2026-10-21'; // Wednesday
const laborBlob = {
  busDt, lastUpdated: '2026-10-21T23:10:00Z',
  stores: {
    '302642': { name: 'County Line', district: 2, today: { sales: 5020, laborDollars: 959, laborPct: 19.1, scheduledNow: 6, employeesOnClock: 6, overtimeCount: 0 }, wtd: {} },
    '365953': { name: 'Hatboro', district: 2, today: { sales: 2766, laborDollars: 1054, laborPct: 38.1, scheduledNow: 3, employeesOnClock: 3, overtimeCount: 0 }, wtd: {} },
    '358933': { name: 'Brace Rd', district: 8, today: { sales: 5188, laborDollars: 1292, laborPct: 24.9, scheduledNow: 7, employeesOnClock: 7, overtimeCount: 1 }, wtd: {} },
    '999999': { name: 'Old Store', district: 8, today: { sales: 100, laborDollars: 10, laborPct: 10 }, wtd: {} },
  },
};
const daily = (pc, base) => ({ daily: ['2026-10-20', '2026-10-19', '2026-10-18', '2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11'].map((date, i) => ({ date, sales: base + i })) });
const hours = (per) => Array.from({ length: 16 }, (_, i) => ({ h: 5 + i, sales: per, checks: 10 }));
const blobs = {
  pcg_stores_v1: stores,
  pcg_labor_v1: laborBlob,
  pcg_pulse_today_v1: { busDt, asOf: new Date().toISOString(), stores: {
    '302642': { sales: 5300, checks: 769, hours: hours(300), voids: { total: 12 }, ops: { net: 5020, guests: 769, discounts: -400 } },
    '365953': { sales: 2900, checks: 431, hours: hours(150), voids: { total: 5 }, ops: { net: 2766, guests: 431, discounts: -200 } },
    '358933': { sales: 5400, checks: 762, hours: hours(320), voids: { total: 0 }, ops: { net: 5188, guests: 762, discounts: -300 } },
  } },
  'pcg_labor_store_302642': daily('302642', 5000), 'pcg_labor_store_365953': daily('365953', 2700), 'pcg_labor_store_358933': daily('358933', 5100),
  'pcg_hourly_history_302642': [{ date: '2026-10-14', hours: hours(280) }], 'pcg_hourly_history_365953': [{ date: '2026-10-14', hours: hours(160) }], 'pcg_hourly_history_358933': [{ date: '2026-10-14', hours: hours(300) }],
  pcg_sales_v1: [{ weekNum: 42, weekEnd: '10/17/2026', stores: [
    { pc: '302642', district: 2, lwSale: 38020, pwSale: 37982, swly: 38327, lwCC: 4981, pwCC: 4900, dcpPct: 18.5, donutsPct: 4.8, laborPct: 19.1, totalPct: 42.4, fcSale: 38800, targetPct: 42 },
    { pc: '365953', district: 2, lwSale: 24641, pwSale: 23115, swly: 0, lwCC: 3030, pwCC: 2900, dcpPct: 19.0, donutsPct: 6.4, laborPct: 26.6, totalPct: 52.1, fcSale: 25100, targetPct: 46 },
    { pc: '358933', district: 8, lwSale: 39807, pwSale: 37343, swly: 39530, lwCC: 4981, pwCC: 4700, dcpPct: 15.4, donutsPct: 6.9, laborPct: 32.7, totalPct: 59.5, fcSale: 40600, targetPct: 42 },
  ] }],
  pcg_dm_scorecard: [{ weekOf: '2026-10-19', computedAt: new Date().toISOString(), basis: { sales: 'Mon-Tue this week vs the same days last week' }, scores: { 2: { rank: 1, composite: 65, avgLaborPct: 22.7, avgGrowthPct: 2.1, avgDcpPct: 18.9, openTickets: 0 }, 8: { rank: 2, composite: 53, avgLaborPct: 22, avgGrowthPct: -1.2, avgDcpPct: 17.5, openTickets: 0 } } }],
  'analyst/cases-index': [{ id: 'c1', title: 'Hatboro labor', status: 'New', severity: 'high', anomalyType: 'labor_high', storeName: 'Hatboro', district: 2, createdAt: '2026-10-21T15:00:00Z' }, { id: 'c2', title: 'old', status: 'Closed', severity: 'high', anomalyType: 'sales_drop', storeName: 'X', district: 1, createdAt: '2026-10-19T15:00:00Z' }],
  pcg_projects_v1: [
    { id: 1, pc: '336372', nickname: 'Elkins', type: 'Remodel', dueDate: '2026-09-01', completed: false },
    { id: 2, pc: '300123', nickname: 'test', type: 'Remodel', dueDate: '2026-09-01', completed: false },
    { id: 3, pc: '342144', nickname: 'West Chester', type: 'Remodel', dueDate: '2026-01-31', completed: true },
    { id: 4, pc: '365630', nickname: 'Island', type: 'Relocation', dueDate: '2026-12-25', completed: false },
  ],
  pcg_pnl_live_v1: { busDt, stores: [{ pc: '302642', revenue: 5020 }, { pc: '365953', revenue: 2755 }, { pc: '358933', revenue: 5188 }] },
  pcg_cash_uploads_v1: [{ uploadedAt: '2026-08-25T23:04:45Z' }],
  'analyst/cron-lock': { startedAt: new Date(Date.now() - 5 * 60000).toISOString(), releasedAt: new Date().toISOString(), summary: { durationMs: 120000 } },
  pcg_system_health_v1: { overall: 'DEGRADED', asOf: Date.now(), feeds: [{ key: 'labor', label: 'Labor (network)', category: 'Labor', status: 'OK', critical: true }] },
};
const load = async (key) => (key in blobs ? JSON.parse(JSON.stringify(blobs[key])) : null);
const dbFactory = () => {
  // tagged-template fake: first call returns weekly rows, second the revised count
  let n = 0;
  return async () => (n++ === 0
    ? [{ week_of: '2026-10-04', orders: 46, spend: '214072' }, { week_of: '2026-10-11', orders: 51, spend: '222857' }, { week_of: '2026-10-18', orders: 20, spend: '95948' }]
    : [{ n: 398 }]);
};
const exec = createExecData({ load, dbFactory });

describe('execToday', () => {
  test('network totals, Sunday WTD, same-time-last-week, districts, labor watch; closed stores skipped', async () => {
    const t = await exec.execToday();
    assert.strictEqual(t.busDt, busDt);
    assert.strictEqual(t.network.sales, 5020 + 2766 + 5188);
    assert.strictEqual(t.network.guests, 769 + 431 + 762);
    assert.strictEqual(t.network.storesReporting, 3); // the Permanently Closed store is dropped
    assert.strictEqual(t.network.laborPct, Math.round(((959 + 1054 + 1292) / (5020 + 2766 + 5188)) * 1000) / 10);
    // WTD = Sun 10/18 + Mon 10/19 + Tue 10/20 (complete days) + today; last week = 10/11..10/13 + full 10/14
    const cl = t.stores.find((s) => s.pc === '302642');
    assert.strictEqual(cl.wtdSales, 5002 + 5001 + 5000 + 5020);
    assert.strictEqual(cl.wtdLastWeekSameDays, 5006 + 5005 + 5004 + 5003);
    assert.ok(t.network.wtd.sales > 0 && t.network.wtd.pct !== null);
    assert.ok(t.network.sameTimeLastWeek === null || typeof t.network.sameTimeLastWeek.pct === 'number');
    assert.deepStrictEqual(t.laborWatch.map((s) => s.name), ['Hatboro', 'Brace Rd']);
    const d2 = t.districts.find((d) => d.district === 2);
    assert.strictEqual(d2.stores, 2);
    assert.strictEqual(d2.laborPct, Math.round(((959 + 1054) / (5020 + 2766)) * 1000) / 10);
    assert.strictEqual(d2.overThreshold, 1);
  });
});

describe('execWeek', () => {
  test('matches the Analytics module math and excludes new stores from vs LY', async () => {
    const w = await exec.execWeek();
    assert.strictEqual(w.weekNum, 42);
    assert.strictEqual(w.network.sales, 38020 + 24641 + 39807);
    assert.strictEqual(w.network.storesWithLastYear, 2);
    const lyPct = ((38020 + 39807 - (38327 + 39530)) / (38327 + 39530)) * 100;
    assert.strictEqual(w.network.vsLastYearPct, Math.round(lyPct * 10) / 10);
    assert.strictEqual(w.stores.find((s) => s.pc === '365953').vsLastYearPct, null);
    assert.deepStrictEqual(w.flagged.map((s) => s.name), ['Brace Rd']); // 59.5% total, 32.7% labor
    assert.strictEqual(w.districts.find((d) => d.district === 2).stores, 2);
  });
});

describe('execDistricts / execDevelopment / execHealth / execAttention', () => {
  test('scorecard rows carry DM names, cases exclude closed', async () => {
    const d = await exec.execDistricts();
    assert.strictEqual(d.scorecard.rows[0].dmName, 'Jay Patel');
    assert.strictEqual(d.openCases.length, 1);
  });
  test('development excludes the "test" project, counts overdue, sums NDCP', async () => {
    const dev = await exec.execDevelopment();
    assert.strictEqual(dev.projects.counts.total, 3);
    assert.strictEqual(dev.projects.counts.overdue, 1);
    assert.strictEqual(dev.projects.counts.complete, 1);
    assert.strictEqual(dev.ndcp.totals.orders, 117);
    assert.strictEqual(dev.ndcp.totals.revisedOrders, 398);
    assert.strictEqual(dev.ndcp.totals.avgFullWeekSpend, (214072 + 222857) / 2);
    assert.strictEqual(dev.portfolio.open, 3);
    assert.strictEqual(dev.portfolio.permanentlyClosed, 1);
  });
  test('health checks: P&L gap within tolerance passes, stale deposit file fails, lock released passes', async () => {
    const h = await exec.execHealth();
    const by = Object.fromEntries(h.checks.map((c) => [c.id, c]));
    assert.strictEqual(by.pulse_vs_pnl.status, 'pass'); // $11 gap on ~$13k
    assert.strictEqual(by.deposit_upload_age.status, 'fail');
    assert.strictEqual(by.analyst_lock.status, 'pass');
    assert.strictEqual(by.scorecard_growth.status, 'pass');
    assert.strictEqual(by.labor_coverage.status, 'pass');
  });
  test('attention groups labor by severity', async () => {
    const a = await exec.execAttention();
    const keys = a.items.map((i) => i.key);
    assert.ok(keys.includes('labor_high') && keys.includes('labor_low') && keys.includes('projects_overdue') && keys.includes('cases_high'));
  });
});

describe('helpers', () => {
  test('cumThroughHour / addDaysYmd / isTestRecord', () => {
    assert.strictEqual(cumThroughHour({ hours: hours(10) }, 6).sales, 20);
    assert.strictEqual(addDaysYmd('2026-10-21', -7), '2026-10-14');
    assert.ok(isTestRecord('test') && isTestRecord('Test Deal') && !isTestRecord('Testing Lane Store'));
    assert.ok(!isTestRecord('Hatboro'));
  });
});
