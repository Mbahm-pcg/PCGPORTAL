// terminations-report.mjs — Terminations report data (v22.33). GET, any signed-in user
// (the Tools tile itself is switched on/off per role in Admin · Access). Reads only the
// synced blob (terminations-lib/run.mjs) — never calls Paycor.
//
// Scope is decided here, server-side, never by the client:
//   DM (incl. a Director, whose claims arrive as dm) → all of their districts
//   manager / store_tablet → only their own store (users.store_pc)
//   kiosk_pulse / kiosk_upload, a Director with no districts → 403
//   everyone else → every store
// Field-key diagnostics and per-store sync errors go to exec/IT only.
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { syncDistricts } from './_shared/store-status.mjs';
import { loadTerminations } from './terminations-lib/run.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const ADMIN = new Set(['executive', 'it']);

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  await syncDistricts(STORES, ALL_STORES);
  const ut = authed.userType;
  // v22.38: shared-device kiosks have no portal access (no Tools hub at all), and a Director
  // left with no districts has no scope — neither gets this data, even by calling directly.
  if (ut === 'kiosk_pulse' || ut === 'kiosk_upload' || ut === 'director') return json(403, { error: 'forbidden' });

  let allowed = null; // null = every store
  if (ut === 'dm') {
    const ds = claimDistricts(authed); // v22.34: a Director gets all their districts in one report
    allowed = new Set(ALL_STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc)));
  } else if (ut === 'manager' || ut === 'store_tablet') {
    const me = (await db`SELECT store_pc FROM users WHERE id = ${authed.sub}`)[0];
    allowed = new Set(me?.store_pc ? [String(me.store_pc)] : []);
  }

  const data = await loadTerminations();
  const stores = ALL_STORES
    .filter(s => !allowed || allowed.has(String(s.pc)))
    .map(s => ({ pc: String(s.pc), name: s.name, district: s.district }));
  const rows = (data?.rows || []).filter(r => !allowed || allowed.has(String(r.pc)));
  const body = { syncedAt: data?.syncedAt || null, scope: allowed ? (ut === 'dm' ? 'district' : 'store') : 'all', stores, rows };
  if (ADMIN.has(ut)) {
    body.sync = { trigger: data?.trigger || null, stores: data?.stores || [], fieldKeys: data?.fieldKeys || [] };
  }
  return json(200, body);
};
