// transfer-notice.mjs — data for Tools · Transfer Notice (v22.49). GET, any signed-in user
// (the Tools tile is switched on/off per role in Admin · Access).
//
//   GET                         → { stores, employees: [{ id, name, jobTitle, pc }] } — every
//                                 active employee the caller may transfer, for the search box.
//                                 Names/titles only, from a roster cache (blob, refreshed when
//                                 older than ROSTER_TTL); never pay rates.
//   GET ?pc=&employeeId=        → { employee: { id, name, jobTitle, employmentType, payRate,
//                                 payType }, store } — read live from Paycor
//   GET ?dest=                  → { manager, dm }  destination store's manager + district DM
//
// Scope is decided here, server-side, never by the client (pay rates are sensitive):
//   DM / Director → stores in their districts;  manager / store_tablet → their own store;
//   kiosks → 403;  everyone else → every store.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { callPaycor } from './paycor.mjs';
import { pickCurrentPayRate, readEmploymentType } from '../../src/transfer-notice.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const ROSTER_KEY = 'pcg_transfer_roster_v1';
const ROSTER_TTL = 4 * 3600 * 1000;

async function storeRoster(legalEntityId) {
  const out = [];
  let token = null, pages = 0;
  do {
    const res = await callPaycor(`/legalentities/${legalEntityId}/employees?include=All${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`);
    if (res.status !== 200) throw new Error(`Paycor employees ${res.status}`);
    out.push(...(res.data?.records || []));
    token = res.data?.continuationToken || null;
  } while (token && ++pages < 20);
  return out.filter(e => (e.statusData?.status || e.status) === 'Active');
}

const fullName = (e) => [e.firstName, e.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

// { savedAt, stores: { [pc]: [{ id, name, jobTitle }] } } — rebuilt when stale. A store whose
// read fails keeps its previous list rather than vanishing from the search.
async function loadRoster() {
  const b = blobs();
  const cached = await b.get(ROSTER_KEY, { type: 'json' }).catch(() => null);
  if (cached?.savedAt && Date.now() - Date.parse(cached.savedAt) < ROSTER_TTL) return cached;
  const stores = { ...(cached?.stores || {}) };
  let failed = 0;
  const queue = [...STORES];
  await Promise.all(Array.from({ length: 10 }, async () => {
    for (let s; (s = queue.shift());) {
      try {
        stores[String(s.pc)] = (await storeRoster(s.paycor))
          .map(e => ({ id: e.id, name: fullName(e), jobTitle: e.positionData?.jobTitle || '' }))
          .filter(e => e.id && e.name);
      } catch (e) { failed++; console.error('[transfer-notice] roster', s.pc, e.message); }
    }
  }));
  if (failed === STORES.length && cached) return cached; // Paycor down — serve the old copy
  if (failed === STORES.length) throw new Error('Paycor roster unavailable');
  const fresh = { savedAt: new Date().toISOString(), stores };
  await b.setJSON(ROSTER_KEY, fresh).catch(e => console.error('[transfer-notice] cache save', e.message));
  return fresh;
}

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const ut = authed.userType;
  if (ut === 'kiosk_pulse' || ut === 'kiosk_upload') return json(403, { error: 'forbidden' });
  await syncDistricts(STORES, ALL_STORES);

  let allowed = null; // null = every store
  if (ut === 'dm' || ut === 'director') {
    const ds = claimDistricts(authed);
    allowed = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc)));
  } else if (ut === 'manager' || ut === 'store_tablet') {
    const me = (await db`SELECT store_pc FROM users WHERE id = ${authed.sub}`)[0];
    allowed = new Set(me?.store_pc ? [String(me.store_pc)] : []);
  }

  const url = new URL(request.url);
  const pc = url.searchParams.get('pc');
  const employeeId = url.searchParams.get('employeeId');
  const dest = url.searchParams.get('dest');

  try {
    if (dest) {
      const store = STORES.find(s => String(s.pc) === String(dest));
      if (!store) return json(404, { error: 'unknown store' });
      const users = await db`SELECT name, user_type, district, store_pc FROM users WHERE active IS NOT FALSE AND user_type IN ('manager', 'dm')`;
      const manager = users.find(u => u.user_type === 'manager' && String(u.store_pc) === String(store.pc));
      const dm = users.find(u => u.user_type === 'dm' && String(u.district) === String(store.district));
      return json(200, { manager: manager?.name || '', dm: dm?.name || '' });
    }

    if (!employeeId) {
      const roster = await loadRoster();
      const stores = STORES.map(s => ({ pc: String(s.pc), name: s.name, district: s.district }));
      const employees = [];
      for (const s of STORES) {
        if (allowed && !allowed.has(String(s.pc))) continue;
        for (const e of roster.stores[String(s.pc)] || []) employees.push({ ...e, pc: String(s.pc) });
      }
      employees.sort((a, b) => a.name.localeCompare(b.name));
      return json(200, { stores, employees, rosterAt: roster.savedAt });
    }

    // One employee, live — only from the caller's own scope and only someone on that
    // store's active Paycor roster, never an arbitrary Paycor id.
    const store = STORES.find(s => String(s.pc) === String(pc));
    if (!store) return json(404, { error: 'unknown store' });
    if (allowed && !allowed.has(String(store.pc))) return json(403, { error: 'forbidden' });
    const emp = (await storeRoster(store.paycor)).find(e => e.id === employeeId);
    if (!emp) return json(404, { error: 'This employee is no longer active at that store in Paycor.' });
    const rateRes = await callPaycor(`/employees/${emp.id}/payrates`);
    if (rateRes.status !== 200) throw new Error(`Paycor payrates ${rateRes.status}`);
    const rate = pickCurrentPayRate(rateRes.data?.records || rateRes.data || []);
    return json(200, {
      store: { pc: String(store.pc), name: store.name },
      employee: {
        id: emp.id,
        name: fullName(emp),
        jobTitle: emp.positionData?.jobTitle || '',
        employmentType: readEmploymentType(emp),
        payRate: rate ? Number(rate.payRate ?? rate.rate ?? 0) || null : null,
        payType: rate ? (rate.payType || rate.type || null) : null,
      },
    });
  } catch (e) {
    console.error('[transfer-notice]', e.message);
    return json(502, { error: 'Paycor is not responding — try again in a minute.' });
  }
};
