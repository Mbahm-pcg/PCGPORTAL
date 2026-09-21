// netlify/functions/no-clockin-lib/run.mjs
// Shared engine for No Clock-In Alerts. Called by:
//   - no-clockin-cron.mjs (scheduled, every 15 min — Netlify blocks HTTP calls to scheduled
//     functions with an empty 403, so it can't double as a manual endpoint)
//   - no-clockin.mjs      (manual exec/IT endpoint: dry run + test send)
// Pure decision logic lives in src/no-clockin.mjs; this file is the I/O around it.
import { getStore } from '@netlify/blobs';
import { sql } from '../_shared/db.mjs';
import { sendSms, sendEmail, sendPush } from '../_shared/channels.mjs';
import { STORES, callPaycor, fetchSchedulingShifts } from '../labor-cron.mjs';
import { normalizeShift, candidateShifts, planAlerts, buildMessages, pruneState } from '../../../src/no-clockin.mjs';

const STATE_KEY = 'pcg_noclockin_v1';
const DEADLINE_MS = 20000; // stay under the function timeout; the next run picks up the rest

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
    // A manager account linked to the store, or matching the store record's manager name.
    const mgrName = String(storeRecord?.mgr || '').trim().toLowerCase();
    const found = users.filter(u => u.user_type === 'manager'
      && (String(u.store_pc) === store.pc || (mgrName && String(u.name || '').trim().toLowerCase() === mgrName)));
    if (found.length) return found;
    // No account: fall back to the store record's phone and the store's own email address.
    return storeRecord && (storeRecord.mgrPhone || storeRecord.email)
      ? [{ id: null, name: storeRecord.mgr ? `${storeRecord.mgr} (store email)` : 'store email', phone: storeRecord.mgrPhone || null, email: storeRecord.email || null }] : [];
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

/** Sample alert to one Portal user (by id) — confirms text + app notification + email all work. */
export async function sendTestAlert(userId) {
  const bs = blobStore();
  const rows = await sql()`SELECT id, email, phone FROM users WHERE id = ${userId}`;
  const me = rows[0] ? [{ id: rows[0].id, email: rows[0].email, phone: rows[0].phone }] : [];
  const delivered = await deliver(bs, me, 'No clock-in — TEST',
    'TEST: this is a sample No Clock-In alert. If you got this by text, app notification and email, all three channels work.');
  return { ok: true, sendTest: true, delivered };
}

/**
 * One full check. mode 'off' returns what WOULD be sent without sending anything or
 * writing state; 'shadow' and 'live' send (see the mode notes below) and record state.
 */
export async function runNoClockin({ mode = 'off' }) {
  const started = Date.now();
  const bs = blobStore();
  const nowMs = Date.now();

  // Modes: 'off' = compute + return only (nothing sent, no state written); 'shadow' = every
  // alert goes ONLY to the user named in NO_CLOCKIN_SHADOW_USER, labelled with who it would
  // have reached; 'live' = real recipients. Shadow keeps its own dedupe state so switching to
  // live later doesn't suppress real alerts for shifts already seen in shadow.
  let shadowUser = null;
  if (mode === 'shadow') {
    const uname = process.env.NO_CLOCKIN_SHADOW_USER;
    try {
      const rows = uname ? await sql()`SELECT id, name, email, phone FROM users WHERE username = ${uname} AND active = true` : [];
      shadowUser = rows[0] || null;
    } catch { shadowUser = null; }
    if (!shadowUser) { console.warn('[no-clockin] shadow mode needs NO_CLOCKIN_SHADOW_USER to match an active user; falling back to off'); mode = 'off'; }
  }
  const stateKey = mode === 'shadow' ? `${STATE_KEY}_shadow` : STATE_KEY;

  // Operational stores only (same fail-open approach as system-health-cron).
  const storeRecords = {};
  let openPcs = null;
  const list = await loadJson(bs, 'pcg_stores_v1');
  if (Array.isArray(list)) {
    for (const s of list) if (s && s.pc != null) storeRecords[String(s.pc)] = s;
    openPcs = new Set(list.filter(s => s && s.status === 'Open').map(s => String(s.pc)));
  }
  const stores = STORES.filter(s => !openPcs || openPcs.has(s.pc));

  let state = (await loadJson(bs, stateKey)) || {};
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
      // If a store has no manager contact at all, the DM gets the alert instead of nobody.
      const mgr = m.audience.includes('manager') ? contactsFor('manager', districtStore, users, record) : [];
      const dm = contactsFor('dm', districtStore, users, record);
      const recipients = [...(mgr.length ? mgr : dm), ...(m.audience.includes('dm') ? dm : [])];
      messages.push({ ...m, recipients });
    }
  }

  if (mode === 'live') {
    for (const m of messages) {
      if (!m.recipients.length) { console.warn('[no-clockin] no recipients for', m.stage, m.storeName); continue; }
      await deliver(bs, m.recipients, m.subject, m.text);
    }
  } else if (mode === 'shadow') {
    const me = [{ id: shadowUser.id, email: shadowUser.email, phone: shadowUser.phone }];
    for (const m of messages) {
      const who = m.recipients.length
        ? uniq(m.recipients.map(r => r.name || r.email || r.phone || 'store contact')).join(', ')
        : 'nobody (no contact on file)';
      await deliver(bs, me, `[SHADOW] ${m.subject}`, `[SHADOW] ${m.text} Would go to: ${who}.`);
    }
  }
  if (mode !== 'off') {
    await bs.setJSON(stateKey, { savedAt: new Date().toISOString(), data: pruneState(state, nowMs) });
  }

  return {
    ok: true, mode, truncated, stores: stores.length, candidates: candidateCount,
    punchStatuses: statusCounts,
    messages: messages.map(m => ({ stage: m.stage, store: m.storeName, subject: m.subject, text: m.text, recipients: m.recipients.length })),
  };
}
