// PCG Portal — Minor Break Compliance Alerts
//
// Pennsylvania's Child Labor Act requires employees under 18 to get an
// uninterrupted 30-minute break after 5 consecutive hours worked. (PA has NO
// general meal-break law for adults — this rule is minors-only.) This runs
// every 15 minutes during business hours, checks every currently-clocked-in
// minor's consecutive hours since their last break, and alerts that store's
// manager before a violation happens (not after).
//
// IMPORTANT — data scope: Paycor's employeesIdentifyingData endpoint also
// returns socialSecurityNumber alongside birthDate. This file must only ever
// read/store `birthDate` from that response — every other field is discarded
// immediately in mapIdentifyingRecord() and must never be logged or forwarded.
// (See memory: project_paycor_identifying_data_scope.)
//
// This intentionally does NOT try to be a substitute for legal advice — the
// 5-hour/30-minute thresholds below should be confirmed with HR/legal before
// this is treated as authoritative compliance tooling, not just a heads-up.

import https from 'node:https';
import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '*/15 9-23,0-3 * * *' };

// ── Store config (pc, Paycor legal entity id, district, fallback email) ──────
// Kept in sync by hand with labor-cron.mjs / schedule-alerts.mjs per project
// convention — store arrays are duplicated across functions, not shared.
const STORES = [
  { pc:"339616", paycor:"193919", name:"Wadsworth",       district:1, email:"wadsworth@peoplecapitalgroup.com" },
  { pc:"340794", paycor:"193904", name:"Front",           district:1, email:"front@peoplecapitalgroup.com" },
  { pc:"351099", paycor:"193900", name:"Sonic",           district:2, email:"sonic@peoplecapitalgroup.com" },
  { pc:"351259", paycor:"193892", name:"Rosemore",        district:2, email:"rosemore@peoplecapitalgroup.com" },
  { pc:"302642", paycor:"193914", name:"County Line",     district:2, email:"countyline@peoplecapitalgroup.com" },
  { pc:"352894", paycor:"193890", name:"Street Rd",       district:2, email:"streetrd@peoplecapitalgroup.com" },
  { pc:"341350", paycor:"193920", name:"Yardley",         district:2, email:"yardley@peoplecapitalgroup.com" },
  { pc:"337839", paycor:"193888", name:"Warrington",      district:2, email:"warrington@peoplecapitalgroup.com" },
  { pc:"330338", paycor:"193887", name:"Drexel Hill",     district:3, email:"drexelhill@peoplecapitalgroup.com" },
  { pc:"337063", paycor:"193902", name:"Sharon Hill",     district:3, email:"sharonhill@peoplecapitalgroup.com" },
  { pc:"343832", paycor:"193876", name:"Lansdowne",       district:3, email:"lansdowne@peoplecapitalgroup.com" },
  { pc:"304669", paycor:"193894", name:"Collingdale",     district:3, email:"collingdale@peoplecapitalgroup.com" },
  { pc:"355146", paycor:"193895", name:"Gallery",         district:3, email:"gallery@peoplecapitalgroup.com" },
  { pc:"300496", paycor:"193906", name:"Cobbs Creek",     district:3, email:"cobbscreek@peoplecapitalgroup.com" },
  { pc:"304863", paycor:"193885", name:"18th St",         district:3, email:"18thst@peoplecapitalgroup.com" },
  { pc:"354561", paycor:"193910", name:"Carlisle",        district:3, email:"carlisle@peoplecapitalgroup.com" },
  { pc:"332393", paycor:"193907", name:"Lindbergh",       district:3, email:"lindbergh@peoplecapitalgroup.com" },
  { pc:"341167", paycor:"193893", name:"5th Street",      district:4, email:"5thst@peoplecapitalgroup.com" },
  { pc:"340870", paycor:"193912", name:"Hunting Park",    district:4, email:"huntingpark@peoplecapitalgroup.com" },
  { pc:"335981", paycor:"193873", name:"Lehigh",          district:4, email:"lehigh@peoplecapitalgroup.com" },
  { pc:"353150", paycor:"193903", name:"Bakers Square",   district:4, email:"bakerssquare@peoplecapitalgroup.com" },
  { pc:"351050", paycor:"193877", name:"Allegheny",       district:4, email:"allegheny@peoplecapitalgroup.com" },
  { pc:"345985", paycor:"193916", name:"Wissahickon",     district:4, email:"wissahickon@peoplecapitalgroup.com" },
  { pc:"356374", paycor:"193898", name:"Montgomeryville", district:5, email:"montgomeryville@peoplecapitalgroup.com" },
  { pc:"353843", paycor:"193891", name:"Tollgate",        district:5, email:"tollgate@peoplecapitalgroup.com" },
  { pc:"353047", paycor:"193875", name:"Silverdale",      district:5, email:"silverdale@peoplecapitalgroup.com" },
  { pc:"340538", paycor:"193879", name:"Easton",          district:5, email:"easton@peoplecapitalgroup.com" },
  { pc:"343079", paycor:"193901", name:"Downingtown",     district:6, email:"downingtown@peoplecapitalgroup.com" },
  { pc:"342144", paycor:"193908", name:"Westchester",     district:6, email:"westchester@peoplecapitalgroup.com" },
  { pc:"364295", paycor:"193881", name:"Lionville",       district:6, email:"lionville@peoplecapitalgroup.com" },
  { pc:"365361", paycor:"194373", name:"Little Welsh",    district:7, email:"littlewelsh@peoplecapitalgroup.com" },
  { pc:"310382", paycor:"193899", name:"Grant",           district:7, email:"grant@peoplecapitalgroup.com" },
  { pc:"332941", paycor:"193884", name:"Bustleton",       district:7, email:"bustleton@peoplecapitalgroup.com" },
  { pc:"343497", paycor:"193874", name:"Red Lion",        district:7, email:"redlion@peoplecapitalgroup.com" },
  { pc:"302446", paycor:"193878", name:"Little Red Lion", district:7, email:"littleredlion@peoplecapitalgroup.com" },
  { pc:"337079", paycor:"193911", name:"Holme Circle",    district:7, email:"holmecircle@peoplecapitalgroup.com" },
  { pc:"345986", paycor:"193896", name:"Willits",         district:7, email:"willits@peoplecapitalgroup.com" },
  { pc:"364412", paycor:"193905", name:"8200",            district:7, email:"8200@peoplecapitalgroup.com" },
  { pc:"345489", paycor:"193880", name:"Oxford",          district:7, email:"oxford@peoplecapitalgroup.com" },
  { pc:"336372", paycor:"193897", name:"Elkins Park",     district:7, email:"elkinspark@peoplecapitalgroup.com" },
  { pc:"358933", paycor:"193886", name:"Brace Rd",        district:8, email:"bracerd@peoplecapitalgroup.com" },
  { pc:"354865", paycor:"193915", name:"Quakertown",      district:8, email:"quakertown@peoplecapitalgroup.com" },
  { pc:"353689", paycor:"193883", name:"Fort Washington", district:8, email:"fortwashington@peoplecapitalgroup.com" },
  { pc:"342184", paycor:"193917", name:"Lansdale",        district:8, email:"lansdale@peoplecapitalgroup.com" },
  { pc:"356316", paycor:"193889", name:"BJ's",            district:8, email:"bjs@peoplecapitalgroup.com" },
];

// PA minor labor law thresholds. WARNING fires early enough for a manager to
// actually act (send them on break) before VIOLATION is reached at 5.0h.
const VIOLATION_HOURS = 5.0;
const WARNING_HOURS = 4.5;
// A clock-out/in gap shorter than this doesn't count as a real break (e.g. a
// 2-minute bathroom tap) — it's ignored rather than resetting the consecutive-
// hours clock, so a false "break satisfied" isn't recorded.
const MIN_BREAK_MINUTES = 15;
// How stale the cached minor-status roster can get before refetching per store.
const ROSTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── Paycor OAuth (same pattern as labor-cron.mjs) ─────────────────────────────
let tokenCache = {
  accessToken: null,
  refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null,
  expiresAt: 0,
};
let refreshPromise = null;
const PAYCOR_API_HOST = 'apis.paycor.com';
const TOKEN_ENDPOINT = '/sts/v1/common/token';

function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body || null;
    const options = { hostname, port: 443, path, method, headers: { ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, data: raw }); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function getAccessToken() {
  const clientId = process.env.PAYCOR_CLIENT_ID;
  const clientSecret = process.env.PAYCOR_CLIENT_SECRET;
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  if (!clientId || !clientSecret || !subscriptionKey) throw new Error('Missing Paycor credentials in environment variables');
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.accessToken;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    if (!tokenCache.refreshToken) throw new Error('NO_TOKEN: No refresh token available.');
    const formBody = [
      `grant_type=refresh_token`,
      `refresh_token=${encodeURIComponent(tokenCache.refreshToken)}`,
      `client_id=${encodeURIComponent(clientId)}`,
      `client_secret=${encodeURIComponent(clientSecret)}`,
    ].join('&');
    const tokenPath = `${TOKEN_ENDPOINT}?subscription-key=${subscriptionKey}`;
    const res = await httpsRequest(PAYCOR_API_HOST, tokenPath, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, formBody);
    if (res.status === 200 && res.data.access_token) {
      tokenCache = {
        accessToken: res.data.access_token,
        refreshToken: res.data.refresh_token || tokenCache.refreshToken,
        expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000,
      };
      return tokenCache.accessToken;
    }
    throw new Error(`Token refresh failed: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  })();

  try { return await refreshPromise; } finally { refreshPromise = null; }
}

async function callPaycor(path) {
  const token = await getAccessToken();
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  const makeCall = async (tok) => httpsRequest(PAYCOR_API_HOST, path, 'GET', {
    'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}`, 'Ocp-Apim-Subscription-Key': subscriptionKey,
  });
  let res = await makeCall(token);
  if (res.status === 401) {
    tokenCache.accessToken = null; tokenCache.expiresAt = 0;
    res = await makeCall(await getAccessToken());
  }
  return res;
}

// ── Blob helpers ──────────────────────────────────────────────────────────────
function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
async function blobLoad(key) {
  try { const raw = await getBlobStore().get(key, { type: 'json' }); if (!raw) return null; return raw.data !== undefined ? raw.data : raw; }
  catch { return null; }
}
async function blobSave(key, data) {
  await getBlobStore().setJSON(key, { savedAt: new Date().toISOString(), data });
}

// ── Minor roster (birthDate only — see file header) ───────────────────────────
// Maps a raw employeesIdentifyingData record down to exactly the two fields
// this feature is allowed to use. Never let the raw record (which includes
// socialSecurityNumber) pass beyond this function.
function mapIdentifyingRecord(rec) {
  return { employeeId: rec.employeeId, birthDate: rec.birthDate || null };
}

function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const dob = new Date(birthDate);
  if (isNaN(dob)) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const beforeBirthdayThisYear = (now.getMonth() < dob.getMonth()) || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  if (beforeBirthdayThisYear) age--;
  return age;
}

async function fetchIdentifyingData(legalEntityId) {
  try {
    let all = [];
    let path = `/v2/legalentities/${legalEntityId}/employeesIdentifyingData`;
    while (path) {
      const res = await callPaycor(path);
      if (res.status !== 200) break;
      const records = (res.data?.records || []).map(mapIdentifyingRecord);
      all = all.concat(records);
      const token = res.data?.continuationToken;
      path = token ? `/v2/legalentities/${legalEntityId}/employeesIdentifyingData?continuationToken=${encodeURIComponent(token)}` : null;
    }
    return all;
  } catch { return []; }
}

async function fetchActiveEmployees(legalEntityId) {
  try {
    const res = await callPaycor(`/v1/legalentities/${legalEntityId}/employees?include=All`);
    if (res.status !== 200) return [];
    const records = res.data?.records || [];
    return records
      .filter(e => e.statusData?.status === 'Active')
      .map(e => ({ employeeId: e.id, name: `${e.firstName || ''} ${e.lastName || ''}`.trim() }));
  } catch { return []; }
}

// Builds/refreshes the cached list of minor employees for one store. Only
// `birthDate` from the identifying-data call feeds this — see file header.
async function getMinorRoster(store, cache) {
  const cached = cache?.[store.pc];
  if (cached && Date.now() - new Date(cached.updatedAt).getTime() < ROSTER_MAX_AGE_MS) {
    return cached;
  }
  const [employees, identifying] = await Promise.all([
    fetchActiveEmployees(store.paycor),
    fetchIdentifyingData(store.paycor),
  ]);
  const birthDateById = new Map(identifying.map(r => [r.employeeId, r.birthDate]));
  const minors = employees
    .map(e => ({ ...e, birthDate: birthDateById.get(e.employeeId) || null }))
    .map(e => ({ ...e, age: ageFromBirthDate(e.birthDate) }))
    .filter(e => e.age != null && e.age < 18)
    .map(e => ({ employeeId: e.employeeId, name: e.name, birthDate: e.birthDate }));
  return { minors, updatedAt: new Date().toISOString() };
}

// ── Punch analysis ────────────────────────────────────────────────────────────
async function fetchEmployeePunchesToday(employeeId, busDt) {
  try {
    const res = await callPaycor(`/v1/employees/${employeeId}/employeePunches?startDate=${busDt}&endDate=${busDt}`);
    if (res.status !== 200) return [];
    const punches = res.data?.records || res.data || [];
    return Array.isArray(punches) ? punches : [];
  } catch { return []; }
}

const punchTime = (p) => p.punchDateTime || p.punchIn || p.timeIn || null;

// Returns null if not currently clocked in, else { consecutiveHours, since }.
// "Since" is the start of the current unbroken stretch — any earlier clock-out
// followed by a clock-in at least MIN_BREAK_MINUTES later resets the stretch;
// shorter gaps (a quick step-away) are treated as still part of the same
// consecutive stretch, since they don't satisfy a real break.
function analyzeShift(punches, nowMs) {
  if (!punches.length) return null;
  const sorted = [...punches].sort((a, b) => new Date(punchTime(a) || 0) - new Date(punchTime(b) || 0));
  if (sorted.length % 2 === 0) return null; // fully punched out — not on shift right now

  let stretchStart = new Date(punchTime(sorted[0]));
  for (let i = 1; i < sorted.length - 1; i += 2) {
    const outTime = new Date(punchTime(sorted[i]));
    const inTime = new Date(punchTime(sorted[i + 1]));
    const gapMin = (inTime - outTime) / 60000;
    if (gapMin >= MIN_BREAK_MINUTES) stretchStart = inTime;
  }
  const consecutiveHours = (nowMs - stretchStart.getTime()) / 3600000;
  return { consecutiveHours, since: stretchStart.toISOString() };
}

// ── SMS helper (Textbelt, same provider/normalization as sms.mjs) ─────────────
function sendSms(numbers, message) {
  const KEY = process.env.TEXTBELT_API_KEY;
  if (!KEY || !numbers.length) return Promise.resolve();
  return Promise.all(numbers.map(raw => new Promise((resolve) => {
    let cleaned = String(raw).replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = '1' + cleaned;
    const postData = new URLSearchParams({ phone: '+' + cleaned, message, key: KEY }).toString();
    const req = https.request({
      hostname: 'textbelt.com', port: 443, path: '/text', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.write(postData); req.end();
  })));
}

// ── Push + email helpers ──────────────────────────────────────────────────────
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
    const body = JSON.stringify({ from: 'PCG Portal <alerts@peoplecapitalgroup.com>', to: Array.isArray(to) ? to : [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

function buildAlertEmail(store, name, tier, hours) {
  const color = tier === 'violation' ? '#ef4444' : '#f59e0b';
  const label = tier === 'violation' ? 'Break Requirement Likely Missed' : 'Break Needed Soon';
  const msg = tier === 'violation'
    ? `${name} has now worked ${hours.toFixed(1)} consecutive hours without a qualifying break — PA's minor labor law requires a 30-minute break after 5 consecutive hours for employees under 18.`
    : `${name} is at ${hours.toFixed(1)} consecutive hours and approaching the 5-hour mark — send them on a 30-minute break soon to stay compliant with PA's minor labor law.`;
  return `
<!DOCTYPE html><html><body style="background:#0f1117;color:#e2e8f0;font-family:'Segoe UI',Arial,sans-serif;padding:24px;margin:0;">
  <div style="max-width:560px;margin:0 auto;">
    <div style="font-size:18px;font-weight:800;color:${color};margin-bottom:8px;">⚠ ${label} — ${store.name}</div>
    <div style="background:#1e2330;border:1px solid #2d3748;border-radius:12px;padding:20px;margin-bottom:16px;font-size:14px;line-height:1.6;">${msg}</div>
    <a href="https://pcg-ops.netlify.app" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Open Portal</a>
    <div style="margin-top:20px;font-size:11px;color:#4a5568;">Automated alert from PCG Operations Portal — not a substitute for confirming PA minor labor rules with HR/legal.</div>
  </div>
</body></html>`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  // Fail fast on a systemic auth problem instead of silently reporting "0 alerts".
  // Every per-store Paycor fetch below has its own try/catch (so one bad store
  // can't take down the whole run) — which means a credentials-level failure
  // would otherwise be swallowed at every single call site and this cron would
  // report a falsely reassuring "ok:true, 0 minors checked" instead of the real
  // problem (verified 2026-07-21: this exact failure mode happened in testing).
  try {
    await getAccessToken();
  } catch (err) {
    console.error('[break-compliance] Paycor auth failed — aborting run:', err.message);
    return new Response(JSON.stringify({ ok: false, error: `Paycor auth failed: ${err.message}` }), { status: 502, headers });
  }

  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const busDt = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;

  const [rosterCache, usersRaw, subsRaw, alertLogRaw] = await Promise.all([
    blobLoad('pcg_minor_roster_v1'),
    blobLoad('pcg_users_v1'),
    blobLoad('pcg_push_subscriptions_v1'),
    blobLoad('pcg_break_alerts_v1'),
  ]);
  const users = Array.isArray(usersRaw) ? usersRaw : [];
  const subs = subsRaw && typeof subsRaw === 'object' ? subsRaw : {};
  const alertedKeys = new Set(alertLogRaw?.alertedKeys || []);
  const alertLog = alertLogRaw?.log || [];

  const newRosterCache = { ...(rosterCache || {}) };
  let checked = 0, alerted = 0;
  const storeErrors = [];

  const BATCH = 6;
  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (store) => {
      try {
        const roster = await getMinorRoster(store, rosterCache);
        newRosterCache[store.pc] = roster;
        if (!roster.minors.length) return;

        for (const minor of roster.minors) {
          checked++;
          const punches = await fetchEmployeePunchesToday(minor.employeeId, busDt);
          const shift = analyzeShift(punches, now.getTime());
          if (!shift) continue; // not currently clocked in

          const tier = shift.consecutiveHours >= VIOLATION_HOURS ? 'violation'
            : shift.consecutiveHours >= WARNING_HOURS ? 'warning' : null;
          if (!tier) continue;

          const key = `${minor.employeeId}_${shift.since}_${tier}`;
          if (alertedKeys.has(key)) continue; // already alerted for this stretch/tier

          const mgr = users.find(u => u.active !== false && u.userType === 'manager' && String(u.storePC) === String(store.pc));
          // The warning tier (4.5h) only goes to the on-shift manager — they're the
          // one who can actually act on it right now (send the minor on break).
          // The DM only gets looped in once it's an actual violation (5h, already
          // missed) — a real compliance event worth their oversight, not every
          // early warning across their whole district.
          const dm = tier === 'violation'
            ? users.find(u => u.active !== false && u.userType === 'dm' && String(u.district) === String(store.district))
            : null;
          const pushIds = [mgr?.id, dm?.id].filter(Boolean).map(String);
          const emailRecipients = [mgr?.email || store.email, dm?.email].filter(Boolean);
          // SMS goes to whoever actually has a phone number on their account — no
          // separate opt-in toggle for this one, unlike routine notifications,
          // since a missed-break alert is a compliance/liability matter where
          // reaching someone reliably matters more than respecting a "don't text
          // me" preference meant for lower-stakes pings.
          const smsNumbers = [mgr?.phone, dm?.phone].filter(Boolean);

          if (pushIds.length > 0) {
            await sendPushToUsers(pushIds, subs, {
              title: tier === 'violation' ? `⚠ Break Requirement Missed — ${store.name}` : `⚠ Break Needed Soon — ${store.name}`,
              body: `${minor.name}: ${shift.consecutiveHours.toFixed(1)}h consecutive, no break yet`,
              url: 'https://pcg-ops.netlify.app', tag: `break-${minor.employeeId}`, icon: '/icon-192.png',
            });
          }
          for (const email of emailRecipients) {
            await sendEmail(email, `⚠ ${tier === 'violation' ? 'Break Requirement Missed' : 'Break Needed Soon'} — ${store.name}`, buildAlertEmail(store, minor.name, tier, shift.consecutiveHours));
          }
          if (smsNumbers.length > 0) {
            const smsMsg = tier === 'violation'
              ? `PCG Portal: ${minor.name} (${store.name}) has worked ${shift.consecutiveHours.toFixed(1)} consecutive hours with no break — PA requires a 30-min break by 5 hours for employees under 18.`
              : `PCG Portal: ${minor.name} (${store.name}) is at ${shift.consecutiveHours.toFixed(1)} consecutive hours, no break yet. Send them on break soon (PA requires one by 5 hours for under-18 employees).`;
            await sendSms(smsNumbers, smsMsg);
          }

          alertedKeys.add(key);
          alertLog.push({
            id: `${key}_${Date.now()}`, pc: store.pc, storeName: store.name, employeeId: minor.employeeId,
            name: minor.name, tier, consecutiveHours: Math.round(shift.consecutiveHours * 10) / 10,
            since: shift.since, alertedAt: now.toISOString(), mgrEmail: mgr?.email || store.email,
            dmEmail: dm?.email || null,
          });
          alerted++;
        }
      } catch (err) {
        console.error(`[break-compliance] ${store.name} error:`, err.message);
        storeErrors.push({ pc: store.pc, storeName: store.name, error: err.message });
      }
    }));
  }

  // Prune: keep alert keys/log for the last 24h only (a new day = fresh shifts, fresh dedup).
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const prunedLog = alertLog.filter(a => a.alertedAt > cutoff).slice(-500);
  const prunedKeys = [...alertedKeys].filter(k => prunedLog.some(a => k.startsWith(`${a.employeeId}_`)));

  await Promise.all([
    blobSave('pcg_minor_roster_v1', newRosterCache),
    blobSave('pcg_break_alerts_v1', { alertedKeys: prunedKeys, log: prunedLog, lastRun: now.toISOString() }),
  ]);

  const summary = { ok: true, busDt, minorsChecked: checked, alertsSent: alerted, storesWithErrors: storeErrors.length, ...(storeErrors.length ? { errors: storeErrors.slice(0, 10) } : {}) };
  console.log('[break-compliance] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
