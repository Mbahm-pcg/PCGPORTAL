// netlify/functions/shelly-temp-lib/run.mjs
// Shared engine for the walk-in cooler/freezer temp-alert automation. Called by
// shelly-temp-cron.mjs (scheduled, every 10 min). Pure decision logic lives in
// src/shelly-temp.mjs; this file is the I/O around it — same split as no-clockin-lib.
// See docs/superpowers/specs/2026-09-23-shelly-temp-alerts-design.md for the full design.
import { getStore } from '@netlify/blobs';
import { sql } from '../_shared/db.mjs';
import { sendSms, sendEmail, sendPush } from '../_shared/channels.mjs';
import { STORES } from '../labor-cron.mjs';
import { fetchAllShellyDevices } from '../shelly.mjs';
import { advanceTempState } from '../../../src/shelly-temp.mjs';
import { SHELLY_DEVICE_STORE, TEST_RECIPIENT_FALLBACK } from './device-map.mjs';

const STATE_KEY = 'pcg_shelly_temp_state_v1';

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
async function loadJson(bs, key) {
  try { const raw = await bs.get(key, { type: 'json' }); return raw && raw.data !== undefined ? raw.data : (raw || null); } catch { return null; }
}
const uniq = (a) => [...new Set(a)];

// Returns each channel's actual result instead of discarding it — a silent Promise.allSettled
// with nothing inspecting the outcomes was exactly how the first live test's SMS failure went
// unexplained (Textbelt quota was fine, phone numbers were on file, but nothing ever logged
// or surfaced what sendSms actually returned).
async function deliver(bs, recipients, subject, text) {
  const phones = uniq(recipients.map(r => r.phone).filter(Boolean));
  const emails = uniq(recipients.map(r => r.email).filter(Boolean));
  const ids = uniq(recipients.map(r => r.id).filter(id => id != null).map(String));
  const [sms, email, push] = await Promise.allSettled([
    sendSms(phones, text),
    sendEmail(emails, subject, text),
    sendPush(bs, ids, subject, text, 'temp_alert'),
  ]);
  const unwrap = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason?.message || String(r.reason) });
  const outcome = { phones, sms: unwrap(sms), email: unwrap(email), push: unwrap(push) };
  if (sms.status === 'rejected' || (sms.status === 'fulfilled' && sms.value?.results?.some(x => x && x.success === false))) {
    console.warn('[shelly-temp] SMS delivery problem:', JSON.stringify(outcome.sms), 'phones:', phones);
  }
  return outcome;
}

// Manager/DM lookup for a mapped store — same shape as no-clockin-lib's contactsFor,
// duplicated rather than shared (this codebase's accepted norm — see CLAUDE.md's
// "Duplicated store config" gotcha; the two libs' needs have already diverged slightly:
// no-clockin also falls back to a store-record phone/email, this one doesn't need to).
function contactsForStore(role, storePc, district, users) {
  if (role === 'manager') return users.filter(u => u.user_type === 'manager' && String(u.store_pc) === String(storePc));
  if (role === 'dm') return users.filter(u => u.user_type === 'dm' && Number(u.district) === Number(district));
  return [];
}

// Fallback recipients for a device with no SHELLY_DEVICE_STORE entry yet (the current
// office test unit) — every active IT user + the executive named Mike, so the whole flow
// is testable end-to-end before a device has a real store assignment. Resolved live from
// the users table, not hardcoded ids.
function testFallbackContacts(users) {
  const nameIncludes = (u, needle) => String(u.name || '').toLowerCase().includes(needle.toLowerCase());
  const ahmed = users.filter(u => u.user_type === 'it' && nameIncludes(u, TEST_RECIPIENT_FALLBACK.itNameMatch));
  const mike = users.filter(u => u.user_type === 'executive' && nameIncludes(u, TEST_RECIPIENT_FALLBACK.execNameMatch));
  const seen = new Set();
  const out = [];
  for (const u of [...ahmed, ...mike]) { if (seen.has(u.id)) continue; seen.add(u.id); out.push(u); }
  return out;
}

async function checkOpenTicket(db, deviceId, sensorId) {
  const rows = await db`
    SELECT id FROM maint_tickets
    WHERE status != 'Closed'
      AND meta->>'source' = 'shelly-temp-auto'
      AND meta->>'deviceId' = ${deviceId}
      AND meta->>'sensorId' = ${sensorId}
    LIMIT 1
  `;
  return rows.length > 0;
}

async function nextTicketNumber(db) {
  const rows = await db`SELECT number FROM maint_tickets WHERE number LIKE 'T-%'`;
  const nums = rows.map(r => parseInt(String(r.number || '').replace('T-', ''), 10) || 0);
  return 'T-' + String(Math.max(0, ...nums) + 1).padStart(4, '0');
}

async function createTicket(db, { deviceId, sensorId, storePc, storeName, tempC, tempF, reason }) {
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const number = await nextTicketNumber(db);
  const readingText = `${tempF.toFixed(1)}°F / ${tempC.toFixed(1)}°C`;
  const reasonText = reason === 'red-flag'
    ? `Reading crossed 7°C (${readingText}).`
    : `Stuck between 5-7°C for 2+ hours without recovering (currently ${readingText}).`;
  const title = `Walk-in cooler/freezer over temp${storeName ? ' — ' + storeName : ''}`;
  const description = `Auto-created by the temp-monitoring automation.\n\n${reasonText}\n\nSensor: ${deviceId} / ${sensorId}`;
  const meta = { source: 'shelly-temp-auto', deviceId, sensorId };
  await db`
    INSERT INTO maint_tickets (
      id, number, title, description, status, priority, category,
      store_pc, store_name, ticket_owner, created_by, meta, created_at, updated_at
    ) VALUES (
      ${id}, ${number}, ${title}, ${description}, 'Open', 'High', 'Equipment Repair / Maintenance',
      ${storePc || null}, ${storeName || null}, 'Unassigned', 'Temp Monitoring Automation',
      ${JSON.stringify(meta)}::jsonb, now(), now()
    )
  `;
  return { id, number };
}

async function writeBellNotification(bs, { type, message, storePC, district }) {
  try {
    const existing = await bs.get('pcg_notifications_v1', { type: 'json' });
    const list = Array.isArray(existing) ? existing : (existing?.data || []);
    const entry = { id: `shellytemp_${Date.now()}_${Math.floor(Math.random() * 1000)}`, type, message, storePC, district, read: false, createdAt: new Date().toISOString() };
    await bs.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...list].slice(0, 500) });
  } catch (e) { console.warn('[shelly-temp] bell notification write failed:', e.message); }
}

export async function runShellyTempCheck({ dryRun = false } = {}) {
  const bs = blobStore();
  const nowMs = Date.now();

  let state = (await loadJson(bs, STATE_KEY)) || {};

  let devices = [];
  try {
    devices = await fetchAllShellyDevices();
  } catch (e) {
    console.warn('[shelly-temp] Shelly fetch failed:', e.message);
    return { ok: false, error: e.message };
  }

  let users = [];
  const db = sql();
  try {
    users = await db`SELECT id, name, email, phone, user_type, district, store_pc FROM users WHERE active = true`;
  } catch (e) { console.warn('[shelly-temp] user lookup failed:', e.message); }

  // Delivery-day suppression — which mapped stores have an NDCP order shipping today.
  // Skipped entirely (empty set, fails safe to "no suppression") on a DB error rather than
  // guessing — a missed delivery-day skip is a false ticket risk either way, but silently
  // suppressing every store on a DB hiccup would be worse (it could mask a real emergency).
  const todayEt = new Date(nowMs).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric' });
  let suppressedPcs = new Set();
  try {
    const mappedPcs = uniq(Object.values(SHELLY_DEVICE_STORE));
    if (mappedPcs.length) {
      const rows = await db`SELECT DISTINCT account FROM ndcp_orders WHERE account = ANY(${mappedPcs}) AND date_shipped = ${todayEt}`;
      suppressedPcs = new Set(rows.map(r => r.account));
    }
  } catch (e) { console.warn('[shelly-temp] delivery-day lookup failed:', e.message); }

  const results = [];

  for (const device of devices) {
    const storePc = SHELLY_DEVICE_STORE[device.deviceId] || null;
    const store = storePc ? STORES.find(s => String(s.pc) === String(storePc)) : null;

    for (const sensor of device.sensors) {
      const key = `${device.deviceId}|${sensor.sensorId}`;

      if (storePc && suppressedPcs.has(storePc)) {
        results.push({ key, skipped: 'delivery-day' });
        continue; // state untouched, same as an unknown reading
      }

      // A device the Shelly account itself reports offline is functionally the same as an
      // unreachable reading — unknown, not a false 0°C-style reading.
      const tempC = device.online === false ? null : sensor.tempC;
      const prevState = state[key] || { overSince: null, warningNotified: false };

      let openTicketExists = false;
      try { openTicketExists = await checkOpenTicket(db, device.deviceId, sensor.sensorId); }
      catch (e) { console.warn('[shelly-temp] open-ticket check failed:', e.message); }

      const { state: nextState, shouldWarn, shouldTicket, reason } = advanceTempState({
        tempC, prevState, nowMs, openTicketExists,
      });
      if (!dryRun) state[key] = nextState; // dry run never writes state, same as no-clockin's mode:'off'

      const isMapped = !!storePc;
      const manager = isMapped ? contactsForStore('manager', storePc, store?.district, users) : testFallbackContacts(users);
      const dm = isMapped ? contactsForStore('dm', storePc, store?.district, users) : [];
      const storeName = store?.name || (isMapped ? storePc : 'Unmapped test sensor');
      const tempF = sensor.tempF;

      const resultEntry = {
        key, shouldWarn, shouldTicket, reason, tempC, tempF, openTicketExists,
        wouldNotify: (shouldWarn || shouldTicket)
          ? { manager: manager.map(u => u.name), dm: (shouldTicket ? dm : []).map(u => u.name) }
          : null,
      };
      results.push(resultEntry);

      if (!shouldWarn && !shouldTicket) continue;
      if (dryRun) continue; // report-only above; no sends, no ticket, no bell entry, no state write

      if (shouldWarn) {
        const text = `${storeName}: temp sensor reading ${tempF.toFixed(1)}°F / ${tempC.toFixed(1)}°C — above 5°C. Keep an eye on it.`;
        try { resultEntry.delivery = await deliver(bs, manager, `Temp warning — ${storeName}`, text); }
        catch (e) { console.warn('[shelly-temp] warning delivery failed:', e.message); resultEntry.delivery = { error: e.message }; }
        if (isMapped) {
          await writeBellNotification(bs, { type: 'temp_warning', message: text, storePC: storePc, district: store?.district });
        }
      }

      if (shouldTicket) {
        let ticketInfo = null;
        try { ticketInfo = await createTicket(db, { deviceId: device.deviceId, sensorId: sensor.sensorId, storePc, storeName: store?.name, tempC, tempF, reason }); }
        catch (e) { console.warn('[shelly-temp] ticket creation failed:', e.message); }
        resultEntry.ticket = ticketInfo;
        const text = `${storeName}: walk-in over temp — ${tempF.toFixed(1)}°F / ${tempC.toFixed(1)}°C. ${ticketInfo ? `Ticket ${ticketInfo.number} opened.` : 'Ticket creation failed — check manually.'}`;
        try { resultEntry.delivery = await deliver(bs, [...manager, ...dm], `HIGH: Temp alert — ${storeName}`, text); }
        catch (e) { console.warn('[shelly-temp] red-flag delivery failed:', e.message); resultEntry.delivery = { error: e.message }; }
        if (isMapped) {
          await writeBellNotification(bs, { type: 'temp_alert', message: text, storePC: storePc, district: store?.district });
        }
      }
    }
  }

  if (!dryRun) {
    try { await bs.setJSON(STATE_KEY, { savedAt: new Date().toISOString(), data: state }); }
    catch (e) { console.warn('[shelly-temp] state write failed:', e.message); }
  }

  return { ok: true, dryRun, results };
}
