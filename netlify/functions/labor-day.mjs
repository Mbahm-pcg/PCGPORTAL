// labor-day.mjs — Labor page "pick a day" view (v21.90).
//
// POST { date: 'YYYY-MM-DD' } (any signed-in portal user — the Labor page already
// scopes stores per role client-side, same as it does for pcg_labor_v1).
//
// Returns the same shape as pcg_labor_v1 ({ busDt, network, stores: { [pc]: { name,
// district, today: {...}, wtd } } }) so the page renders it with its existing cards:
//   1. pcg_labor_day_{date} — the end-of-day snapshot labor-cron writes every hourly
//      run (source: 'snapshot'). Exists for every day from this feature's launch on.
//   2. Otherwise, rebuilt from each store's pcg_labor_store_{pc} daily history
//      (source: 'history'). That history only keeps the most recent 30 days, and has no
//      clock-in / scheduled / overtime counts — just labor $, sales, labor %, hours and
//      the employees who worked.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './labor-cron.mjs';
import { refreshStoreList } from './_shared/store-status.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const blobs = () => getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const unwrap = (raw) => (raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });

  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: 'date must be YYYY-MM-DD' });
  // v22.0: a store closed BEFORE this date isn't rebuilt into that day's view.
  await refreshStoreList(STORES, ALL_STORES, { onDate: date });

  const store = blobs();
  try {
    const snap = unwrap(await store.get(`pcg_labor_day_${date}`, { type: 'json' }).catch(() => null));
    if (snap?.stores) return json(200, { ...snap, source: 'snapshot' });

    const stores = {};
    await Promise.all(STORES.map(async (s) => {
      const hist = unwrap(await store.get(`pcg_labor_store_${s.pc}`, { type: 'json' }).catch(() => null));
      const d = (Array.isArray(hist?.daily) ? hist.daily : []).find(x => x?.date === date);
      if (!d) return;
      const emps = Array.isArray(d.employees) ? d.employees : [];
      stores[s.pc] = {
        name: s.name,
        district: s.district,
        paycorId: s.paycor,
        today: {
          laborDollars: r2(d.laborDollars),
          sales: r2(d.sales),
          laborPct: Number(d.laborPct) || 0,
          employees: emps.length || (typeof d.employees === 'number' ? d.employees : 0),
          employeesOnClock: 0,
          scheduledNow: 0,
          scheduledToday: 0,
          hoursWorked: r2(d.hoursWorked),
          overtimeCount: 0,
        },
      };
    }));
    const list = Object.values(stores);
    if (!list.length) return json(404, { error: `No labor data saved for ${date}. Day-by-day history before this feature only goes back about 30 days.` });
    const laborDollars = list.reduce((a, s) => a + s.today.laborDollars, 0);
    const sales = list.reduce((a, s) => a + s.today.sales, 0);
    return json(200, {
      busDt: date,
      lastUpdated: null,
      source: 'history',
      network: {
        laborDollars: r2(laborDollars),
        sales: r2(sales),
        laborPct: sales > 0 ? Math.round((laborDollars / sales) * 1000) / 10 : 0,
        totalEmployees: list.reduce((a, s) => a + s.today.employees, 0),
        employeesOnClock: 0, scheduledNow: 0, scheduledToday: 0, overtimeCount: 0,
      },
      stores,
    });
  } catch (err) {
    console.error('[labor-day] error:', err.message);
    return json(500, { error: 'Server error' });
  }
};
