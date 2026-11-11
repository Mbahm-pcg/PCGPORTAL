// joy.mjs — Joy in Childhood leaderboard for the dashboard (v22.75).
//
//   GET ?date=YYYY-MM-DD (default: today, Eastern) →
//     { date, today, earliest, updatedAt, scope, rows: [{ pc, name, district, cnt, ttl, rank, noData }], total }
//   GET ?month=YYYY-MM → the same for the whole month, every day added up (v22.75, "the top 5 for
//     the whole month"): { month, ... }. earliestMonth is the oldest month with data.
//   One day's $1 Joy donations per store, highest first. The card opens on today and steps back and
//   forth a day at a time (user, 2026-11-11). Who sees what is decided here: a Store Manager → their
//   own store; a DM / Director → the stores in their districts; exec / IT / office → every store.
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { DAILY_KEY, loadJSON, etToday, windowStart } from './joy-lib/run.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const role = authed.realUserType || authed.userType;

  await syncDistricts(STORES, ALL_STORES);
  let visible = STORES;
  let scope = 'all';
  if (role === 'manager' || role === 'store_tablet') {
    const me = (await db`SELECT store_pc FROM users WHERE id = ${authed.sub}`)[0];
    visible = STORES.filter(s => String(s.pc) === String(me?.store_pc || ''));
    scope = 'store';
  } else if (role === 'dm' || role === 'director' || authed.userType === 'dm') {
    const ds = claimDistricts(authed);
    visible = STORES.filter(s => ds.includes(String(s.district)));
    scope = 'district';
  } else if (!['executive', 'it', 'office_staff'].includes(role)) {
    return json(200, { scope: 'none', rows: [] });
  }

  const today = etToday();
  const data = (await loadJSON(DAILY_KEY)) || { days: {} };
  const have = Object.keys(data.days || {}).sort();
  const earliest = have.length ? (have[0] > windowStart(today) ? have[0] : windowStart(today)) : today;
  const params = new URL(request.url).searchParams;
  const askedMonth = params.get('month');
  const thisMonth = today.slice(0, 7), earliestMonth = earliest.slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(askedMonth || '') ? (askedMonth > thisMonth ? thisMonth : askedMonth < earliestMonth ? earliestMonth : askedMonth) : null;
  const asked = params.get('date');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(asked || '') && asked <= today && asked >= earliest ? asked : today;
  // One day, or every day of the month added together.
  const days = month ? Object.keys(data.days || {}).filter(d => d.startsWith(month)) : [date];
  const sums = {};
  for (const d of days) for (const [pc, v] of Object.entries(data.days?.[d] || {})) {
    const t = (sums[pc] ||= { cnt: 0, ttl: 0 });
    t.cnt += Number(v.cnt) || 0; t.ttl += Number(v.ttl) || 0;
  }

  // noData: no Pulse answer for this store in the period — shown as "—", ranked last.
  const rows = visible.map(s => { const v = sums[String(s.pc)]; return { pc: String(s.pc), name: s.name, district: s.district, cnt: v?.cnt || 0, ttl: Math.round((v?.ttl || 0) * 100) / 100, noData: !v }; })
    .sort((a, b) => (a.noData - b.noData) || b.cnt - a.cnt || a.name.localeCompare(b.name));
  let rank = 0, prev = null;
  rows.forEach((r, i) => { if (r.noData) { r.rank = null; return; } if (r.cnt !== prev) { rank = i + 1; prev = r.cnt; } r.rank = rank; });
  return json(200, { date: month ? null : date, month, thisMonth, earliestMonth, today, earliest, updatedAt: data.updatedAt || null, scope, rows, total: rows.reduce((n, r) => n + r.cnt, 0) });
};
