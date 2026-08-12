// food-license-alerts-cron.mjs — Store Food License Due-Date Reminders
// Runs daily. Checks every store in the store_licenses table (same
// "Auto-details" Supabase project fleet.mjs already reads from) for a food
// license expiring soon, and sends email + SMS at 30/14/7 days out to
// whoever's on the manually-managed list (Admin > Notifications > Food
// License — pcg_food_license_notify_v1, same plain-list pattern as Project/
// Ticket/Car, since that list is edited directly rather than derived from
// Portal roles). No push here — unlike fleet's vehicle operator, there's no
// per-license Portal user to push to, only the manual email/phone list.
export const config = { schedule: '0 12 * * *' }; // 8am ET

import https from 'node:https';
import { getStore } from '@netlify/blobs';

// Ascending — .find() below needs the SMALLEST threshold still >= daysOut,
// so a license 10 days out matches 14 (not 30). Descending would match 30
// for anything <=30 and never reach 14 or 7 (confirmed bug, fleet-alerts-
// cron.mjs, 2026-08-11 — same mistake, fixed here from the start).
const THRESHOLDS = [7, 14, 30];

function getBlobStore() {
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

async function fetchStoreLicenses() {
  const url = `${process.env.FLEET_SUPABASE_URL}/rest/v1/store_licenses?select=*`;
  const res = await fetch(url, { headers: { apikey: process.env.FLEET_SUPABASE_ANON_KEY, Authorization: `Bearer ${process.env.FLEET_SUPABASE_ANON_KEY}` } });
  if (!res.ok) throw new Error(`store_licenses HTTP ${res.status}`);
  return res.json();
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
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

export async function runFoodLicenseAlerts() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setHours(0, 0, 0, 0);

  const [licenses, log, notify] = await Promise.all([
    fetchStoreLicenses(),
    blobLoad('pcg_food_license_alerts_v1'),
    blobLoad('pcg_food_license_notify_v1'),
  ]);

  const emails = Array.isArray(notify?.emails) ? notify.emails : [];
  const phones = Array.isArray(notify?.phones) ? notify.phones : [];
  const sentKeys = new Set(log?.sent || []);
  const newSentKeys = [...sentKeys];
  let totalAlerted = 0;

  if (emails.length === 0 && phones.length === 0) {
    console.log('[food-license-alerts] no recipients configured (Admin > Notifications > Food License) — nothing to send');
    return { ok: true, licensesChecked: licenses.length, alertsSent: 0, note: 'no recipients configured' };
  }

  for (const lic of licenses) {
    const dueDate = lic.food_license_expiration;
    if (!dueDate) continue;
    const daysOut = daysUntil(dueDate, et);
    if (daysOut < 0) continue; // already expired — a fresh reminder is stale, not useful

    const threshold = THRESHOLDS.find(t => daysOut <= t);
    if (threshold == null) continue;
    const key = `${lic.pc_number}_${dueDate}_${threshold}`;
    if (sentKeys.has(key)) continue;

    const title = `📋 Food License due in ${daysOut} day${daysOut !== 1 ? 's' : ''} — PC ${lic.pc_number}`;
    const body = `Due ${dueDate}${lic.address ? ` · ${lic.address}` : ''}`;

    try {
      if (emails.length) {
        const status = await sendEmail(emails, title, `<p>${body}</p>`);
        if (status < 200 || status >= 300) console.error(`[food-license-alerts] PC ${lic.pc_number} email HTTP ${status}`);
      }
      if (phones.length) {
        await sendSms(phones, `${title}\n${body}`);
      }
    } catch (err) {
      console.error(`[food-license-alerts] PC ${lic.pc_number} send error:`, err.message);
      continue; // don't mark as sent if it failed
    }

    newSentKeys.push(key);
    totalAlerted++;
    console.log(`[food-license-alerts] PC ${lic.pc_number}: due ${dueDate} (${daysOut}d) — alerted ${emails.length} email(s), ${phones.length} phone(s)`);
  }

  const prunedKeys = newSentKeys.slice(-2000);
  await blobSave('pcg_food_license_alerts_v1', { sent: prunedKeys, lastRun: now.toISOString() });

  const summary = { ok: true, licensesChecked: licenses.length, alertsSent: totalAlerted };
  console.log('[food-license-alerts] done:', JSON.stringify(summary));
  return summary;
}

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    const summary = await runFoodLicenseAlerts();
    return new Response(JSON.stringify(summary), { status: 200, headers });
  } catch (err) {
    console.error('[food-license-alerts] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
