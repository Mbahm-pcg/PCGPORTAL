// time-off-lib/sync.mjs — shared engine for the Time-Off Balances feature (v21.84).
//
// Pulls Paycor's per-employee time-off balances (GET /legalentities/{id}/timeoffaccruals,
// "View Employee Timeoff Accruals by Legal Entity Id" scope) for every store legal entity
// plus the office one, and stores them in our own Neon table `time_off_people`. Every
// portal screen reads that table, never Paycor directly, so a slow or down Paycor only
// means slightly stale balances.
//
// Data notes (confirmed against live responses 2026-10-12):
//   • Results ARE legal-entity scoped (unlike onboardingemployees, which is tenant-wide).
//   • employeeId is the same GUID family as /employees (what users.paycor_employee_id
//     already holds via manager-sync / the office clock link), so no name matching is
//     needed for anyone already linked.
//   • typeBalances[].accruedBalance returns nonsense values (e.g. -1241986) — never shown.
//     currentBalance / usedBalance / scheduledBalance are sane and are what we keep.
//   • Plans seen: "Philadelphia Sick" (crew), "Vacation - Store Managers",
//     "Vacation - Area Managers" (DMs, office legal entity), "Vacation - Admin".
//
// Auto-link: after a sync, any ACTIVE dm/executive/it/office_staff/manager account with
// no paycor_employee_id is linked when exactly ONE person in the right legal entity has
// the same normalized name (managers: their store's entity; everyone else: the office
// entity). Ambiguous or missing matches are left unlinked for IT to pick manually —
// never guessed.
import { sql } from '../_shared/db.mjs';
import { STORES, ALL_STORES, callPaycorProxy } from '../tips-report-cron-background.mjs';
import { refreshStoreList } from '../_shared/store-status.mjs';

export const OFFICE_LE = String(process.env.OFFICE_LEGAL_ENTITY_ID || '193872');

let _ready = false;
export async function ensureTables(db) {
  if (_ready) return;
  await db`CREATE TABLE IF NOT EXISTS time_off_people (
    paycor_employee_id text NOT NULL,
    legal_entity_id    text NOT NULL,
    employee_name      text,
    employee_number    text,
    balances           jsonb NOT NULL DEFAULT '[]'::jsonb,
    synced_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (paycor_employee_id, legal_entity_id)
  )`;
  await db`CREATE TABLE IF NOT EXISTS time_off_sync_runs (
    id          serial PRIMARY KEY,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    entities_ok integer,
    entities_failed integer,
    people      integer,
    auto_linked integer,
    trigger     text,
    error       text
  )`;
  _ready = true;
}

export function legalEntityIds() {
  return [...new Set([OFFICE_LE, ...STORES.map(s => String(s.paycor)).filter(Boolean)])];
}

export function legalEntityForStorePc(storePc) {
  const s = STORES.find(x => String(x.pc) === String(storePc));
  return s ? String(s.paycor) : null;
}

const normName = (n) => String(n || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

function cleanBalance(b) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  return {
    type: b.timeOffTypeName || b.timeOffTypeCode || 'Time off',
    code: b.timeOffTypeCode || null,
    plan: b.timeOffPlanName || null,
    current: num(b.currentBalance),
    used: num(b.usedBalance),
    scheduled: num(b.scheduledBalance),
    periodStart: b.activityStartDate ? String(b.activityStartDate).slice(0, 10) : null,
    periodEnd: b.activityEndDate ? String(b.activityEndDate).slice(0, 10) : null,
  };
}

async function fetchAccruals(le) {
  let records = [];
  let token = null;
  let pages = 0;
  do {
    const path = `/legalentities/${le}/timeoffaccruals${token ? `?continuationToken=${encodeURIComponent(token)}` : ''}`;
    const raw = await callPaycorProxy('raw', { path });
    const body = JSON.parse(raw || '{}');
    if (!Array.isArray(body.records)) {
      throw new Error(`Paycor error for legal entity ${le}: ${body.Title || body.message || body.error || 'no records array'}`);
    }
    records = records.concat(body.records);
    token = body.hasMoreResults ? (body.continuationToken || null) : null;
    pages++;
  } while (token && pages < 50);
  return records;
}

async function runPool(items, size, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = { ok: true, value: await fn(items[idx]) }; }
      catch (err) { results[idx] = { ok: false, error: err.message }; }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runTimeOffSync({ trigger = 'cron' } = {}) {
  // v22.0: don't sync legal entities of stores closed more than 14 days ago.
  await refreshStoreList(STORES, ALL_STORES, { graceDays: 14 });
  const db = sql();
  await ensureTables(db);
  const run = await db`INSERT INTO time_off_sync_runs (trigger) VALUES (${trigger}) RETURNING id`;
  const runId = run[0].id;
  const les = legalEntityIds();
  let people = 0;
  try {
    const results = await runPool(les, 6, async (le) => {
      const recs = await fetchAccruals(le);
      const startedAt = new Date().toISOString();
      for (const r of recs) {
        if (!r.employeeId) continue;
        const balances = (r.typeBalances || []).map(cleanBalance);
        await db`INSERT INTO time_off_people (paycor_employee_id, legal_entity_id, employee_name, employee_number, balances, synced_at)
          VALUES (${r.employeeId}, ${le}, ${r.employeeName || null}, ${r.employeeNumber || null}, ${JSON.stringify(balances)}::jsonb, now())
          ON CONFLICT (paycor_employee_id, legal_entity_id) DO UPDATE SET
            employee_name = EXCLUDED.employee_name, employee_number = EXCLUDED.employee_number,
            balances = EXCLUDED.balances, synced_at = now()`;
      }
      // Anyone no longer returned for this entity (terminated / moved) is removed —
      // only after a SUCCESSFUL fetch, so a Paycor hiccup never wipes good data.
      await db`DELETE FROM time_off_people WHERE legal_entity_id = ${le} AND synced_at < ${startedAt}`;
      return recs.length;
    });
    const ok = results.filter(r => r.ok);
    const failed = results.map((r, i) => (r.ok ? null : `${les[i]}: ${r.error}`)).filter(Boolean);
    people = ok.reduce((a, r) => a + (r.value || 0), 0);
    const autoLinked = await autoLinkUsers(db);
    await db`UPDATE time_off_sync_runs SET finished_at = now(), entities_ok = ${ok.length}, entities_failed = ${failed.length},
      people = ${people}, auto_linked = ${autoLinked}, error = ${failed.length ? failed.slice(0, 10).join(' | ') : null} WHERE id = ${runId}`;
    if (failed.length) console.warn('[time-off-sync] failed entities:', failed);
    return { ok: true, entities: les.length, entitiesOk: ok.length, entitiesFailed: failed.length, people, autoLinked };
  } catch (err) {
    await db`UPDATE time_off_sync_runs SET finished_at = now(), error = ${err.message} WHERE id = ${runId}`;
    throw err;
  }
}

// Plan-roster pass (DMs v21.86, store managers v21.88): portal names often differ from
// Paycor legal names ("Sharmin Akter" vs "Musammet Akter", or just "Mohamed"). For an
// ACTIVE, RECENTLY-USED account (logged in within RECENT_DAYS) that the exact-name pass
// couldn't link, match against ONLY the people on the matching vacation plan in the
// right legal entity:
//   • DMs            → "Vacation - Area Managers" holders in the office entity (~9 people)
//   • store managers → "Vacation - Store Managers" holders in THEIR OWN store's entity
//                      (usually 1–2 people), never another store's
// Rule: same last name, or — when the portal name is a single word — same first name.
// The match must be unique BOTH ways: exactly one plan holder fits this account, and no
// other unlinked account in the same pool fits that same person. Anything ambiguous is
// left for IT's manual Link button. This NEVER creates, deactivates, or deletes an
// account; it only fills in a missing users.paycor_employee_id (plus name completion,
// below).
const RECENT_DAYS = 90;

const PLAN_PASSES = [
  { userType: 'dm', plan: /area manager/i, leFor: () => OFFICE_LE, label: 'DM' },
  { userType: 'manager', plan: /store manager/i, leFor: (u) => legalEntityForStorePc(u.store_pc), label: 'manager' },
];

async function autoLinkByPlan(db, taken, pass) {
  const accounts = await db`SELECT id, name, store_pc FROM users
    WHERE active = true AND user_type = ${pass.userType} AND (paycor_employee_id IS NULL OR paycor_employee_id = '')
      AND last_login IS NOT NULL AND last_login > now() - make_interval(days => ${RECENT_DAYS})`;
  if (!accounts.length) return 0;
  const rosterCache = {};
  const rosterFor = async (le) => {
    if (!le) return [];
    if (!rosterCache[le]) {
      rosterCache[le] = (await db`SELECT paycor_employee_id, employee_name, balances FROM time_off_people WHERE legal_entity_id = ${le}`)
        .filter(r => (Array.isArray(r.balances) ? r.balances : []).some(b => pass.plan.test(b.plan || '')))
        .map(r => { const parts = normName(r.employee_name).split(' ').filter(Boolean); return { id: r.paycor_employee_id, fullName: String(r.employee_name || '').trim(), first: parts[0] || '', last: parts[parts.length - 1] || '' }; });
    }
    return rosterCache[le].filter(p => !taken.has(p.id));
  };
  const fits = (acct, p) => {
    const parts = normName(acct.name).split(' ').filter(Boolean);
    if (!parts.length) return false;
    if (parts.length === 1) return p.first === parts[0];
    return p.last === parts[parts.length - 1];
  };
  let linked = 0;
  for (const acct of accounts) {
    const le = pass.leFor(acct);
    const pool = await rosterFor(le);
    const candidates = pool.filter(p => fits(acct, p));
    if (candidates.length !== 1) continue;
    const p = candidates[0];
    const rivals = accounts.filter(o => o.id !== acct.id && pass.leFor(o) === le && fits(o, p));
    if (rivals.length) continue;
    await db`UPDATE users SET paycor_employee_id = ${p.id}, updated_at = now() WHERE id = ${acct.id} AND (paycor_employee_id IS NULL OR paycor_employee_id = '')`;
    taken.add(p.id);
    linked++;
    console.log(`[time-off-sync] ${pass.label} pass linked user ${acct.id} to a plan holder in legal entity ${le}`);
    // Name completion (v21.87): a one-word portal name ("Mohamed") is filled in with the
    // full Paycor name ("Mohamed Elzarw"). Only the `name` column changes — username,
    // initials, email, phone, role, district, store and everything else stay exactly as
    // they were. A portal name that already has a last name is never overwritten, so a
    // preferred first name ("Sharmin" vs Paycor's legal "Musammet") is kept.
    if (normName(acct.name).split(' ').filter(Boolean).length === 1 && p.fullName && normName(p.fullName) !== normName(acct.name)) {
      await db`UPDATE users SET name = ${p.fullName}, updated_at = now() WHERE id = ${acct.id}`;
      console.log(`[time-off-sync] ${pass.label} pass completed name for user ${acct.id}`);
    }
  }
  return linked;
}

async function autoLinkByPlans(db, taken) {
  let n = 0;
  for (const pass of PLAN_PASSES) n += await autoLinkByPlan(db, taken, pass);
  return n;
}

async function autoLinkUsers(db) {
  const users = await db`SELECT id, name, user_type, store_pc FROM users
    WHERE active = true AND (paycor_employee_id IS NULL OR paycor_employee_id = '')
      AND user_type IN ('dm', 'executive', 'it', 'office_staff', 'manager')`;
  if (!users.length) return 0;
  const rows = await db`SELECT paycor_employee_id, legal_entity_id, employee_name FROM time_off_people`;
  const byLe = {};
  for (const r of rows) (byLe[r.legal_entity_id] ||= []).push(r);
  const taken = new Set((await db`SELECT paycor_employee_id FROM users WHERE paycor_employee_id IS NOT NULL AND paycor_employee_id <> ''`).map(r => r.paycor_employee_id));
  let linked = 0;
  for (const u of users) {
    const le = u.user_type === 'manager' ? legalEntityForStorePc(u.store_pc) : OFFICE_LE;
    if (!le) continue;
    const target = normName(u.name);
    if (!target) continue;
    const matches = (byLe[le] || []).filter(r => normName(r.employee_name) === target && !taken.has(r.paycor_employee_id));
    if (matches.length !== 1) continue;
    const id = matches[0].paycor_employee_id;
    await db`UPDATE users SET paycor_employee_id = ${id}, updated_at = now() WHERE id = ${u.id} AND (paycor_employee_id IS NULL OR paycor_employee_id = '')`;
    taken.add(id);
    linked++;
    console.log(`[time-off-sync] auto-linked user ${u.id} (${u.user_type}) to Paycor employee in legal entity ${le}`);
  }
  return linked + await autoLinkByPlans(db, taken);
}
