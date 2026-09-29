// netlify/functions/minor-timecard-detect-cron.mjs — Sunday morning: scans
// every store's under-18 employees for the week that just ended, flags any
// PA minor-labor-law violation (5+ consecutive hours, no qualifying 30-min
// break), and emails each affected store's manager.
//
// IMPORTANT — data scope: Paycor's employeesIdentifyingData endpoint also
// returns socialSecurityNumber alongside birthDate. Only ever read/store
// `birthDate` from that response. See memory: project_paycor_identifying_data_scope.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { STORES } from './tips-report-cron-background.mjs';
import { weekRangeEndingYesterday, groupPunchesByDate, analyzeDayForViolation, ageFromBirthDate, isMinor } from '../../src/minor-timecard-detect.mjs';
import { buildIssueRecord, resolveNotificationRecipients } from '../../src/minor-timecard-lifecycle.mjs';
import { buildEmailSubject, buildDigestEmailHtml } from '../../src/minor-timecard-email.mjs';

export const config = { schedule: '0 10 * * 0' }; // 6:00 AM ET, Sundays

const ROSTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ── Paycor OAuth (same pattern as the removed break-compliance-cron.mjs / labor-cron.mjs) ──
let tokenCache = { accessToken: null, refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null, expiresAt: 0 };
let refreshPromise = null;
const PAYCOR_API_HOST = 'apis.paycor.com';

function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const options = { hostname, port: 443, path, method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, data: raw }); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken() {
  const clientId = process.env.PAYCOR_CLIENT_ID, clientSecret = process.env.PAYCOR_CLIENT_SECRET, subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  if (!clientId || !clientSecret || !subscriptionKey) throw new Error('Missing Paycor credentials');
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.accessToken;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    if (!tokenCache.refreshToken) throw new Error('NO_TOKEN');
    const formBody = [`grant_type=refresh_token`, `refresh_token=${encodeURIComponent(tokenCache.refreshToken)}`, `client_id=${encodeURIComponent(clientId)}`, `client_secret=${encodeURIComponent(clientSecret)}`].join('&');
    const res = await httpsRequest(PAYCOR_API_HOST, `/sts/v1/common/token?subscription-key=${subscriptionKey}`, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, formBody);
    if (res.status === 200 && res.data.access_token) {
      tokenCache = { accessToken: res.data.access_token, refreshToken: res.data.refresh_token || tokenCache.refreshToken, expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000 };
      return tokenCache.accessToken;
    }
    throw new Error(`Token refresh failed: ${res.status}`);
  })();
  try { return await refreshPromise; } finally { refreshPromise = null; }
}

async function callPaycor(path) {
  const token = await getAccessToken();
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  const makeCall = async (tok) => httpsRequest(PAYCOR_API_HOST, path, 'GET', { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tok}`, 'Ocp-Apim-Subscription-Key': subscriptionKey });
  let res = await makeCall(token);
  if (res.status === 401) { tokenCache.accessToken = null; tokenCache.expiresAt = 0; res = await makeCall(await getAccessToken()); }
  return res;
}

function getBlobStore() { return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN }); }
async function blobLoad(key) { try { const raw = await getBlobStore().get(key, { type: 'json' }); return raw ? (raw.data !== undefined ? raw.data : raw) : null; } catch { return null; } }
async function blobSave(key, data) { await getBlobStore().setJSON(key, { savedAt: new Date().toISOString(), data }); }

// Only ever extracts employeeId + birthDate. See file header.
function mapIdentifyingRecord(rec) { return { employeeId: rec.employeeId, birthDate: rec.birthDate || null }; }

async function fetchIdentifyingData(legalEntityId) {
  try {
    let all = [], path = `/v2/legalentities/${legalEntityId}/employeesIdentifyingData`;
    while (path) {
      const res = await callPaycor(path);
      if (res.status !== 200) break;
      all = all.concat((res.data?.records || []).map(mapIdentifyingRecord));
      const token = res.data?.continuationToken;
      path = token ? `/v2/legalentities/${legalEntityId}/employeesIdentifyingData?continuationToken=${encodeURIComponent(token)}` : null;
    }
    return all;
  } catch { return []; }
}

async function fetchActiveEmployees(legalEntityId) {
  try {
    const res = await callPaycor(`/legalentities/${legalEntityId}/employees?include=All`);
    if (res.status !== 200) return [];
    return (res.data?.records || []).filter(e => e.statusData?.status === 'Active').map(e => ({ employeeId: e.id, name: `${e.firstName || ''} ${e.lastName || ''}`.trim() }));
  } catch { return []; }
}

async function getMinorRoster(store, cache) {
  const cached = cache?.[store.pc];
  if (cached && Date.now() - new Date(cached.updatedAt).getTime() < ROSTER_MAX_AGE_MS) return cached.minors;
  const [employees, identifying] = await Promise.all([fetchActiveEmployees(store.paycor), fetchIdentifyingData(store.paycor)]);
  const birthDateById = new Map(identifying.map(r => [r.employeeId, r.birthDate]));
  const minors = employees
    .map(e => ({ ...e, birthDate: birthDateById.get(e.employeeId) || null }))
    .map(e => ({ ...e, age: ageFromBirthDate(e.birthDate) }))
    .filter(e => isMinor(e.age))
    .map(e => ({ employeeId: e.employeeId, name: e.name }));
  return minors;
}

// Single call spanning the whole week, grouped locally by day — far fewer
// Paycor calls than fetching each of the 7 days separately across every minor
// at every store.
async function fetchWeekPunches(employeeId, weekStart, weekEnd) {
  try {
    const res = await callPaycor(`/employees/${employeeId}/employeePunches?startDate=${weekStart}&endDate=${weekEnd}`);
    if (res.status !== 200) return [];
    const punches = res.data?.records || res.data || [];
    return Array.isArray(punches) ? punches : [];
  } catch { return []; }
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: 'PCG Portal <alerts@peoplecapitalgroup.com>', to: Array.isArray(to) ? to : [to], subject, html });
    const req = https.request({ hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

// Shadow-mode testing (matches the established NO_CLOCKIN_SHADOW_USER pattern
// in no-clockin-lib/run.mjs): when MINOR_TIMECARD_SHADOW_EMAIL is set, every
// real recipient is collapsed into that one address instead, labelled with
// who it would really have gone to — lets this be tested against real Paycor
// data without ever reaching a real manager/DM/office-staff inbox. Unset in
// production once testing is done.
function applyShadowMode(recipients, subject, html) {
  const shadowEmail = process.env.MINOR_TIMECARD_SHADOW_EMAIL;
  if (!shadowEmail) return { recipients, subject, html };
  const wouldGoTo = recipients.map(r => `${r.role}: ${r.email}`).join(', ') || '(no recipients)';
  return {
    recipients: [{ role: 'shadow', email: shadowEmail }],
    subject: `[TEST] ${subject}`,
    html: `<div style="background:#f59e0b18;border:1px solid #f59e0b55;border-radius:0.5rem;padding:10px 14px;margin-bottom:16px;font-family:sans-serif;font-size:0.8rem;color:#fbbf24;">SHADOW MODE — would really go to: ${wouldGoTo}</div>${html}`,
  };
}

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await getAccessToken(); }
  catch (err) {
    console.error('[minor-timecard-detect] Paycor auth failed — aborting:', err.message);
    return new Response(JSON.stringify({ ok: false, error: `Paycor auth failed: ${err.message}` }), { status: 502, headers });
  }

  const now = new Date();
  const { weekStart, weekEnd } = weekRangeEndingYesterday(now);

  const [rosterCache, existingIssuesRaw, usersRaw] = await Promise.all([
    blobLoad('pcg_minor_roster_v1'),
    blobLoad('pcg_minor_timecard_issues_v1'),
    blobLoad('pcg_users_v1'),
  ]);
  const existingIssues = Array.isArray(existingIssuesRaw) ? existingIssuesRaw : [];
  const users = Array.isArray(usersRaw) ? usersRaw : [];
  const existingIds = new Set(existingIssues.map(i => i.id));
  const newRosterCache = { ...(rosterCache || {}) };

  const newIssues = [];
  const emailsSent = [];

  const BATCH = 6;
  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (store) => {
      try {
        const minors = await getMinorRoster(store, rosterCache);
        newRosterCache[store.pc] = { minors, updatedAt: now.toISOString() };
        if (!minors.length) return;

        const storeNewIssues = [];
        for (const minor of minors) {
          const punches = await fetchWeekPunches(minor.employeeId, weekStart, weekEnd);
          const byDate = groupPunchesByDate(punches);
          for (const [dateStr, dayPunches] of Object.entries(byDate)) {
            const result = analyzeDayForViolation(dayPunches);
            if (result.status !== 'ok' || !result.violates) continue;
            const issue = buildIssueRecord({
              pc: store.pc, storeName: store.name, district: store.district,
              employeeId: minor.employeeId, employeeName: minor.name,
              weekStart, weekEnd, violationDate: dateStr,
              consecutiveHours: result.consecutiveHours, now,
            });
            if (existingIds.has(issue.id)) continue; // already tracked from a prior run this week
            storeNewIssues.push({ issue, dayPunches });
          }
        }
        if (!storeNewIssues.length) return;

        const realRecipients = resolveNotificationRecipients(storeNewIssues[0].issue, users); // manager-only pre-escalation, same for every issue at this store today
        const { recipients, subject, html } = applyShadowMode(realRecipients, buildEmailSubject(store.name, false, null), buildDigestEmailHtml(store.name, storeNewIssues));
        const notifications = [];
        for (const r of recipients) {
          const status = await sendEmail(r.email, subject, html);
          notifications.push({ recipientRole: r.role, recipientEmail: r.email, sentAt: now.toISOString(), success: status >= 200 && status < 300, error: status >= 200 && status < 300 ? null : `HTTP ${status}` });
        }
        for (const { issue } of storeNewIssues) { issue.notifications = notifications; newIssues.push(issue); }
        emailsSent.push({ pc: store.pc, storeName: store.name, issueCount: storeNewIssues.length });
      } catch (err) {
        console.error(`[minor-timecard-detect] ${store.name} error:`, err.message);
      }
    }));
  }

  await Promise.all([
    blobSave('pcg_minor_roster_v1', newRosterCache),
    blobSave('pcg_minor_timecard_issues_v1', [...existingIssues, ...newIssues]),
  ]);

  const summary = { ok: true, weekStart, weekEnd, newIssues: newIssues.length, storesEmailed: emailsSent.length };
  console.log('[minor-timecard-detect] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
