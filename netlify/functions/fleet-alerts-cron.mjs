// fleet-alerts-cron.mjs — Company Vehicle Due-Date Reminders
// Runs daily. Checks every vehicle in the fleet Supabase project for
// registration/inspection/insurance dates coming due, and sends push + email
// + SMS at 30/14/7/1 days out to that vehicle's operator (matched by name to
// a Portal user) plus every IT/exec/office staff/construction/maintenance user.
// Saves a sent-alert log to pcg_fleet_alerts_v1 so the same (vehicle, field,
// due date, threshold) combo never re-fires — keying on the due date itself
// (not just the threshold) means a renewed/updated due date on the source
// sheet naturally resets the alert cycle for that field.

import https from 'node:https';
import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '0 11 * * *' }; // 6/7am ET daily

// Ascending — .find() below needs the SMALLEST threshold still >= daysOut, so
// a vehicle 10 days out matches 14 (not 30), and one due tomorrow matches 1.
// Descending order would match 30 for anything <=30 and never reach the rest.
const THRESHOLDS = [1, 7, 14, 30];
const NOTIFY_ROLES = new Set(['it', 'executive', 'office_staff', 'construction', 'maintenance']);
const DUE_FIELDS = [
  { key: 'registration_expiration', label: 'Registration' },
  { key: 'inspection_expiration',   label: 'Inspection' },
  { key: 'insurance_expiration',    label: 'Insurance' },
];

export function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
async function blobLoad(key) {
  try {
    const store = getBlobStore();
    const raw = await store.get(key, { type: 'json' });
    if (!raw) return null;
    return raw.data !== undefined ? raw.data : raw;
  } catch { return null; }
}
async function blobSave(key, data) {
  const store = getBlobStore();
  await store.setJSON(key, { savedAt: new Date().toISOString(), data });
}

// Users now live in Neon (post-migration), not a blob — read the same public
// `list` action the frontend uses, same as any other server-side user lookup
// added since that cutover.
async function fetchUsers() {
  return new Promise((resolve) => {
    https.get('https://pcg-ops.netlify.app/.netlify/functions/users?action=list', (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve([]); } });
    }).on('error', () => resolve([]));
  });
}

async function fetchCars() {
  const url = `${process.env.FLEET_SUPABASE_URL}/rest/v1/cars?select=*`;
  const res = await fetch(url, { headers: { apikey: process.env.FLEET_SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.FLEET_SUPABASE_ANON_KEY}` } });
  if (!res.ok) throw new Error(`Fleet DB HTTP ${res.status}`);
  return res.json();
}

async function sendPushToUsers(userIds, subs, payload) {
  webpush.setVapidDetails(`mailto:${process.env.VAPID_EMAIL}`, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  for (const uid of userIds) {
    for (const sub of (subs[String(uid)] || [])) {
      try { await webpush.sendNotification(sub, JSON.stringify(payload)); } catch {}
    }
  }
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    // Same verified sender notify.mjs uses — confirmed directly (2026-08-11)
    // that the hardcoded 'alerts@peoplecapitalgroup.com' address this was
    // copied from (schedule-alerts.mjs's pattern) isn't a verified Resend
    // sender, so every fleet-alert email was silently rejected while push and
    // SMS went out fine.
    const FROM = process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>';
    const body = JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

function sendSms(numbers, message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ to: numbers, message });
    const req = https.request({
      hostname: 'pcg-ops.netlify.app', port: 443, path: '/.netlify/functions/sms', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

const daysUntil = (dateStr, today) => Math.round((new Date(dateStr + 'T12:00:00') - today) / 86400000);
const normName = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');

// Shared by both the scheduled cron and fleet-alerts-refresh.mjs (the manual-
// trigger sibling — Netlify's edge blocks direct external POST to any
// config.schedule function, same reason every other cron in this codebase
// has one of these).
export async function runFleetAlerts() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setHours(0, 0, 0, 0);

  const [cars, users, subs, log] = await Promise.all([
    fetchCars(),
    fetchUsers(),
    blobLoad('pcg_push_subscriptions_v1'),
    blobLoad('pcg_fleet_alerts_v1'),
  ]);

  const userList = Array.isArray(users) ? users : [];
  const subMap = subs && typeof subs === 'object' ? subs : {};
  const sentKeys = new Set(log?.sent || []);
  const newSentKeys = [...sentKeys];
  let totalAlerted = 0;

  for (const car of cars) {
    if (car.sold) continue; // no longer ours — nothing to remind anyone about
    const operator = userList.find(u => u.active !== false && normName(u.name) === normName(car.operator));
    const admins = userList.filter(u => u.active !== false && NOTIFY_ROLES.has(u.userType));
    const recipients = [operator, ...admins].filter(Boolean).filter((u, i, a) => a.findIndex(x => x.id === u.id) === i);
    if (recipients.length === 0) continue;

    for (const field of DUE_FIELDS) {
      const dueDate = car[field.key];
      if (!dueDate) continue;
      const daysOut = daysUntil(dueDate, et);
      if (daysOut < 0) continue; // already expired — a fresh reminder is stale, not useful

      const threshold = THRESHOLDS.find(t => daysOut <= t);
      if (threshold == null) continue;
      const key = `${car.vin}_${field.key}_${dueDate}_${threshold}`;
      if (sentKeys.has(key)) continue;

      const vehicleLabel = car.automobile_details || `${car.year || ''} ${car.color || ''}`.trim() || car.plate || car.vin;
      const title = `🚗 ${field.label} due in ${daysOut} day${daysOut !== 1 ? 's' : ''} — ${vehicleLabel}`;
      const body = `Due ${dueDate}${car.plate ? ` · Plate ${car.plate}` : ''}${car.operator ? ` · Operator: ${car.operator}` : ''}`;

      const pushUserIds = recipients.map(u => String(u.id));
      const emails = recipients.map(u => u.email).filter(Boolean).filter((e, i, a) => a.indexOf(e) === i);
      const phones = recipients.map(u => u.phone).filter(Boolean).filter((p, i, a) => a.indexOf(p) === i);

      // Isolated per field: one bad push/email/SMS call must not kill the rest
      // of the batch — confirmed directly (2026-08-11) that an uncaught error
      // partway through one vehicle's fields aborted the ENTIRE run before it
      // ever reached blobSave, silently losing every later car/field (and the
      // sent-key bookkeeping for what HAD already gone out).
      try {
        await sendPushToUsers(pushUserIds, subMap, { title, body, url: 'https://pcg-ops.netlify.app', tag: `fleet-${car.vin}-${field.key}`, icon: '/icon-192.png' });
      } catch (err) {
        console.error(`[fleet-alerts] ${vehicleLabel} ${field.label} push error:`, err.message);
      }
      if (emails.length) {
        try {
          const status = await sendEmail(emails, title, `<p>${body}</p><p style="margin-top:14px;color:#888;font-size:13px;">Vehicle: ${vehicleLabel} (VIN ${car.vin})</p>`);
          if (status < 200 || status >= 300) console.error(`[fleet-alerts] ${vehicleLabel} ${field.label} email HTTP ${status} (to ${emails.join(', ')})`);
        } catch (err) {
          console.error(`[fleet-alerts] ${vehicleLabel} ${field.label} email error:`, err.message);
        }
      }
      if (phones.length) {
        try {
          await sendSms(phones, `${title}\n${body}`);
        } catch (err) {
          console.error(`[fleet-alerts] ${vehicleLabel} ${field.label} sms error:`, err.message);
        }
      }

      newSentKeys.push(key);
      totalAlerted++;
      console.log(`[fleet-alerts] ${vehicleLabel}: ${field.label} due ${dueDate} (${daysOut}d) — alerted ${recipients.length} recipient(s): ${recipients.map(r => r.name).join(', ')}`);
    }
  }

  // Keep the sent-key log from growing forever — a year of daily runs across
  // ~13 vehicles × 3 fields × 4 thresholds is nowhere near enough entries to
  // need aggressive pruning, but cap it as a backstop.
  const prunedKeys = newSentKeys.slice(-2000);
  await blobSave('pcg_fleet_alerts_v1', { sent: prunedKeys, lastRun: now.toISOString() });

  const summary = { ok: true, carsChecked: cars.length, alertsSent: totalAlerted };
  console.log('[fleet-alerts] done:', JSON.stringify(summary));
  return summary;
}

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    const summary = await runFleetAlerts();
    return new Response(JSON.stringify(summary), { status: 200, headers });
  } catch (err) {
    console.error('[fleet-alerts] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
