// approval-inbox.mjs — "Waiting for your approval" on login (v23.35, user 2026-11-27). Only what THIS
// person may decide right now; each item opens that request. Read only; a missing table adds nothing.
//   pay         Pay Rate Change approval    — Admin · Notifications · Pay Rate Change approval (else every executive)
//   payoffice   Pay Rate Change office step — "Pay Rate Change office step" list (else the Pay Rate Change (office) list)
//   transfer    Transfer Notice approval    — its list, never your own (mayDecide)
//   timeoff     Time Off Request approval   — its list, never your own (mayDecide)
//   violation   Violation Notice approval   — Violation Notice approval list (Sam) (else every executive)
//   missing     Missing Hours approval      — Missing Hours approval list (Ella) (else every executive)
//   crewmgr     Crew Time Off, manager step — Store Managers (their store), DMs / Directors (their districts)
//   crewoffice  Crew Time Off, office step  — "Crew time off (office)" list (else the Pay Rate Change office step people)
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser, claimDistricts } from './auth-lib/require-user.js';
import { formApprovers, mayDecide, usDay } from './_shared/form-approval.mjs';
import { STORES, ALL_STORES } from './tips-report-cron-background.mjs';
import { refreshStoreList } from './_shared/store-status.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const storeName = (pc) => STORES.find(s => String(s.pc) === String(pc))?.name || (pc ? `PC ${pc}` : '');
const money = (n, basis) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${basis === 'year' ? '/yr' : '/hr'}`;

async function listIds(key) {
  const raw = await blobs().get(key, { type: 'json' }).catch(() => null);
  const l = raw?.data ?? raw ?? {};
  return [...new Set([...(l.emailOwners || []), ...(l.phoneOwners || [])].filter(x => x != null).map(String))];
}
// named on the list → them; nobody named → every executive (the rule Pay Rate Change / Violation / Missing Hours use)
async function listOrExecs(db, key) {
  const ids = await listIds(key);
  if (ids.length) return ids;
  return (await db`SELECT id FROM users WHERE active IS NOT FALSE AND user_type = 'executive'`).map(r => String(r.id));
}
async function listOrFallbackList(primary, fallback) {
  const ids = await listIds(primary);
  return ids.length ? ids : listIds(fallback);
}
async function source(name, fn) { try { await fn(); } catch (e) { console.warn('[approval-inbox]', name, e.message); } }

export default async (request) => {
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  const me = String(authed.sub);
  const real = authed.realUserType || authed.userType;
  const items = [];

  await source('pay', async () => {
    if (!(await listOrExecs(db, 'pcg_pay_increase_approvers_v1')).includes(me)) return;
    for (const r of await db`SELECT id, employee_name, pc, current_rate, new_rate, pay_basis, submitted_by_name, created_at FROM pay_increase_forms WHERE status = 'pending' ORDER BY created_at`.catch(() => []))
      items.push({ kind: 'pay', id: r.id, title: r.employee_name, sub: `Pay Rate Change · ${storeName(r.pc)} · ${money(r.current_rate, r.pay_basis)} to ${money(r.new_rate, r.pay_basis)} · from ${r.submitted_by_name || 'a manager'}`, at: r.created_at });
  });
  await source('payoffice', async () => {
    if (!(await listOrFallbackList('pcg_pay_increase_office_step_v1', 'pcg_pay_increase_notify_v1')).includes(me)) return;
    for (const r of await db`SELECT id, employee_name, pc, current_rate, new_rate, pay_basis, decided_by_name, decided_at FROM pay_increase_forms WHERE status = 'office' ORDER BY decided_at`.catch(() => []))
      items.push({ kind: 'payoffice', id: r.id, title: r.employee_name, sub: `Pay Rate Change · needs the effective date · ${storeName(r.pc)} · ${money(r.current_rate, r.pay_basis)} to ${money(r.new_rate, r.pay_basis)} · approved by ${r.decided_by_name || 'Mike'}`, at: r.decided_at });
  });
  await source('transfer', async () => {
    const rows = await db`SELECT id, employee_name, from_pc, to_pc, effective_date, submitted_by, submitted_by_name, created_at FROM transfer_notices WHERE status = 'pending' ORDER BY created_at`.catch(() => []);
    if (!rows.length) return;
    const appr = await formApprovers(db, 'pcg_transfer_approvers_v1');
    for (const r of rows) if (await mayDecide(db, appr, r.submitted_by, me))
      items.push({ kind: 'transfer', id: r.id, title: r.employee_name, sub: `Transfer · ${storeName(r.from_pc)} to ${storeName(r.to_pc)} · effective ${usDay(r.effective_date)} · from ${r.submitted_by_name || 'a manager'}`, at: r.created_at });
  });
  await source('timeoff', async () => {
    const rows = await db`SELECT id, employee_name, user_id, start_date, return_date, total_hours, leave_type, created_at FROM time_off_requests WHERE status = 'pending' ORDER BY created_at`.catch(() => []);
    if (!rows.length) return;
    const appr = await formApprovers(db, 'pcg_time_off_approvers_v1');
    for (const r of rows) if (await mayDecide(db, appr, r.user_id, me))
      items.push({ kind: 'timeoff', id: r.id, title: r.employee_name, sub: `Time off · ${usDay(r.start_date)} to ${usDay(r.return_date)} · ${Number(r.total_hours)} h · ${r.leave_type || ''}`, at: r.created_at });
  });
  await source('violation', async () => {
    if (!(await listOrExecs(db, 'pcg_violation_approvers_v1')).includes(me)) return;
    for (const r of await db`SELECT id, employee_name, pc, action, submitted_by_name, COALESCE(pending_at, created_at) AS at FROM violation_notices WHERE status = 'pending' ORDER BY COALESCE(pending_at, created_at)`.catch(() => []))
      items.push({ kind: 'violation', id: r.id, title: r.employee_name, sub: `Violation Notice · ${storeName(r.pc)}${r.action ? ` · ${String(r.action).replace(/_/g, ' ')}` : ''} · from ${r.submitted_by_name || 'a supervisor'}`, at: r.at });
  });
  await source('missing', async () => {
    if (!(await listOrExecs(db, 'pcg_missing_hours_approvers_v1')).includes(me)) return;
    for (const r of await db`SELECT id, employee_name, pc, total_hours, period_start, submitted_by_name, created_at FROM missing_hours_forms WHERE status = 'pending' ORDER BY created_at`.catch(() => []))
      items.push({ kind: 'missing', id: r.id, title: r.employee_name, sub: `Missing Hours · ${storeName(r.pc)} · ${Number(r.total_hours)} h${r.period_start ? ` · pay period from ${usDay(r.period_start)}` : ''} · from ${r.submitted_by_name || 'a manager'}`, at: r.created_at });
  });
  await source('crewmgr', async () => {
    if (!['manager', 'dm', 'director'].includes(real)) return; // exec / IT / office see the whole list in the tool, not a popup for every store
    let pcs;
    if (real === 'manager') { const u = (await db`SELECT store_pc FROM users WHERE id = ${authed.sub}`)[0]; pcs = new Set(u?.store_pc ? [String(u.store_pc)] : []); }
    else { await refreshStoreList(STORES, ALL_STORES); const ds = claimDistricts(authed); pcs = new Set(STORES.filter(s => ds.includes(String(s.district))).map(s => String(s.pc))); }
    if (!pcs.size) return;
    for (const r of await db`SELECT id, pc, employee_name, form_values, submitted_at FROM crew_time_off WHERE status = 'manager' ORDER BY submitted_at`.catch(() => []))
      if (pcs.has(String(r.pc))) items.push({ kind: 'crewmgr', id: r.id, title: r.employee_name, sub: `Crew time off · ${storeName(r.pc)}${r.form_values ? ` · ${usDay(r.form_values.startDate)} to ${usDay(r.form_values.returnDate)} · ${Number(r.form_values.totalHours)} h · ${r.form_values.leaveType || ''}` : ''}`, at: r.submitted_at });
  });
  await source('crewoffice', async () => {
    if (!(await listOrFallbackList('pcg_crew_time_off_office_v1', 'pcg_pay_increase_office_step_v1')).includes(me)) return;
    for (const r of await db`SELECT id, pc, employee_name, form_values, manager_by_name, manager_at FROM crew_time_off WHERE status = 'office' ORDER BY manager_at`.catch(() => []))
      items.push({ kind: 'crewoffice', id: r.id, title: r.employee_name, sub: `Crew time off · needs the office · ${storeName(r.pc)}${r.form_values ? ` · ${usDay(r.form_values.startDate)} to ${usDay(r.form_values.returnDate)} · ${Number(r.form_values.totalHours)} h` : ''} · approved by ${r.manager_by_name || 'the manager'}`, at: r.manager_at });
  });

  items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return json(200, { items });
};
