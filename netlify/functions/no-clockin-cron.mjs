// no-clockin-cron.mjs — No Clock-In Alerts
// Every 15 min: find scheduled shifts that started 30-180 min ago with no punch, and
// alert the store manager (30 min) and manager + DM (60 min, "absent") by SMS, app
// notification and email. Per-shift dedupe lives in blob pcg_noclockin_v1.
//
// Rollout safety: scheduled runs only SEND (and write state) when env NO_CLOCKIN_LIVE=true.
// Otherwise they compute and log only. Exec/IT can POST ?dryRun=1 (never sends, never writes
// state) and ?dryRun=1&sendTest=1 (sends a sample alert to the caller only).
// Spec: docs/superpowers/specs/2026-09-21-no-clockin-alerts-design.md
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { sendSms, sendEmail, sendPush } from './_shared/channels.mjs';
import { STORES, callPaycor, fetchSchedulingShifts } from './labor-cron.mjs';
import { normalizeShift, candidateShifts, planAlerts, buildMessages, pruneState } from '../../src/no-clockin.mjs';

export const config = { schedule: '*/15 * * * *' };

const STATE_KEY = 'pcg_noclockin_v1';
const DEADLINE_MS = 20000; // stay under the function timeout; the next run picks up the rest
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
async function loadJson(bs, key) {
  try { const raw = await bs.get(key, { type: 'json' }); return raw && raw.data !== undefined ? raw.data : (raw || null); } catch { return null; }
}
const etDate = (ms, offsetDays = 0) =>
  new Date(ms + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const uniq = (a) => [...new Set(a)];

// Punch list for one employee, or null when Paycor errors (= unknown, never "missing").
async function fetchPunches(employeeId, from, to, statusCounts) {
  try {
    const res = await callPaycor(`/employees/${employeeId}/employeePunches?startDate=${from}&endDate=${to}`);
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    if (res.status !== 200) return null;
    const recs = res.data?.records || res.data || [];
    return Array.isArray(recs) ? recs : null;
  } catch { statusCounts.error = (statusCounts.error || 0) + 1; return null; }
}

function contactsFor(role, store, users, storeRecord) {
  if (role === 'manager') {
    const found = users.filter(u => u.user_type === 'manager' && String(u.store_pc) === store.pc);
    if (found.length) return found;
    return storeRecord && storeRecord.mgrPhone ? [{ id: null, phone: storeRecord.mgrPhone, email: storeRecord.email || null }] : [];
  }
  if (role === 'dm') {
    return users.filter(u => u.user_type === 'dm' && Number(u.district) === Number(store.district));
  }
  return [];
}

async function deliver(bs, recipients, subject, text) {
  const phones = uniq(recipients.map(r => r.phone).filter(Boolean));
  const emails = uniq(recipients.map(r => r.email).filter(Boolean));
  const ids = uniq(recipients.map(r => r.id).filter(id => id != null).map(String));
  await Promise.allSettled([
    sendSms(phones, text),
    sendEmail(emails, subject, text),
    sendPush(bs, ids, subject, text, 'no_clockin'),
  ]);
  return { phones: phones.length, emails: emails.length, push: ids.length };
}

export default async (request) => {
  const started = Date.now();
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const sendTest = dryRun && url.searchParams.get('sendTest') === '1';
  const live = process.env.NO_CLOCKIN_LIVE === 'true' && !dryRun;

  let caller = null;
  if (dryRun) {
    caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
    if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
      return json({ error: 'Exec/IT session required.' }, 403);
    }
  }

  const bs = blobStore();
  const nowMs = Date.now();

  // Sample alert to the caller only — lets exec/IT confirm all three channels work before going live.
  if (sendTest) {
    const rows = await sql()`SELECT id, email, phone FROM users WHERE id = ${caller.sub}`;
    const me = rows[0] ? [{ id: rows[0].id, email: rows[0].email, phone: rows[0].phone }] : [];
    const d = await deliver(bs, me, 'No clock-in — TEST', 'TEST: this is a sample No Clock-In alert. If you got this by text, app notification and email, all three channels work.');
    return json({ ok: true, sendTest: true, delivered: d });
  }

  // Operational stores only (same fail-open approach as system-health-cron).
  let storeRecords = {};
  let openPcs = null;
  const list = await loadJson(bs, 'pcg_stores_v1');
  if (Array.isArray(list)) {
    for (const s of list) if (s && s.pc != null) storeRecords[String(s.pc)] = s;
    openPcs = new Set(list.filter(s => s && s.status === 'Open').map(s => String(s.pc)));
  }
  const stores = STORES.filter(s => !openPcs || openPcs.has(s.pc));

  let state = (await loadJson(bs, STATE_KEY)) || {};
  const from = etDate(nowMs, -1), to = etDate(nowMs, 1);
  const statusCounts = {};
  const allAlerts = [];
  let candidateCount = 0, truncated = false;

  for (const store of stores) {
    if (Date.now() - started > DEADLINE_MS) { truncated = true; break; }

    // Cheap pre-filter from the saved schedule blob; only stores with candidates hit Paycor.
    const sched = await loadJson(bs, `pcg_schedule_${store.pc}`);
    if (!candidateShifts(sched?.shifts || [], nowMs).length) continue;

    // Re-fetch LIVE shifts so a removed/moved shift doesn't alert. [] on failure -> no alerts.
    const liveRaw = await fetchSchedulingShifts(store.paycor, from, to);
    const candidates = candidateShifts(liveRaw.map(normalizeShift), nowMs);
    if (!candidates.length) continue;
    candidateCount += candidates.length;

    const ids = uniq(candidates.map(c => c.employeeId));
    const punchesByEmp = {};
    for (let i = 0; i < ids.length; i += 5) {
      await Promise.all(ids.slice(i, i + 5).map(async (id) => { punchesByEmp[id] = await fetchPunches(id, from, to, statusCounts); }));
    }

    const { alerts, nextState } = planAlerts({ pc: store.pc, storeName: store.name, candidates, punchesByEmp, state, nowMs });
    state = nextState;
    allAlerts.push(...alerts);
  }

  // Build messages per store and resolve recipients.
  let users = [];
  try {
    users = await sql()`SELECT id, name, email, phone, user_type, district, store_pc FROM users WHERE user_type IN ('manager','dm') AND active = true`;
  } catch (e) { console.warn('[no-clockin] recipient lookup failed:', e.message); }

  const messages = [];
  for (const store of stores) {
    const forStore = allAlerts.filter(a => a.pc === store.pc);
    if (!forStore.length) continue;
    const record = storeRecords[store.pc];
    const districtStore = { ...store, district: record?.district ?? store.district };
    for (const m of buildMessages(forStore)) {
      const recipients = m.audience.flatMap(role => contactsFor(role, districtStore, users, record));
      messages.push({ ...m, recipients });
    }
  }

  if (live) {
    for (const m of messages) {
      if (!m.recipients.length) { console.warn('[no-clockin] no recipients for', m.stage, m.storeName); continue; }
      await deliver(bs, m.recipients, m.subject, m.text);
    }
    await bs.setJSON(STATE_KEY, { savedAt: new Date().toISOString(), data: pruneState(state, nowMs) });
  }

  const summary = {
    ok: true, live, dryRun, truncated, stores: stores.length, candidates: candidateCount,
    punchStatuses: statusCounts,
    messages: messages.map(m => ({ stage: m.stage, store: m.storeName, subject: m.subject, text: m.text, recipients: m.recipients.length })),
  };
  console.log('[no-clockin]', JSON.stringify({ ...summary, messages: summary.messages.length }));
  return json(summary);
};
