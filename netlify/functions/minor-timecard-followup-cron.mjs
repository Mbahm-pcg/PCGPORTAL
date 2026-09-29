// netlify/functions/minor-timecard-followup-cron.mjs — runs every morning.
// For every currently-open minor-timecard issue: re-checks that one specific
// employee/day against live Paycor data. Resolves it automatically if the
// violation is gone; otherwise escalates it (Manager -> +DM +Office Staff)
// once it crosses into the Monday after the week it was flagged, and sends a
// fresh reminder to whoever is currently in the loop — every day, until
// resolved. See docs/superpowers/specs/2026-09-29-minor-timecard-compliance-design.md.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { analyzeDayForViolation } from '../../src/minor-timecard-detect.mjs';
import { shouldEscalateToday, execBackstopDue, resolveNotificationRecipients, applyResolutionCheck } from '../../src/minor-timecard-lifecycle.mjs';
import { buildEmailSubject, buildDigestEmailHtml } from '../../src/minor-timecard-email.mjs';

export const config = { schedule: '0 10 * * *' }; // 6:00 AM ET, every day

// ── Paycor OAuth (same as minor-timecard-detect-cron.mjs) ──
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

async function fetchDayPunches(employeeId, dateStr) {
  try {
    const res = await callPaycor(`/v1/employees/${employeeId}/employeePunches?startDate=${dateStr}&endDate=${dateStr}`);
    if (res.status !== 200) { console.error(`[minor-timecard-followup] employeePunches ${employeeId} failed: HTTP ${res.status}`); return null; } // fetch failure — distinct from "no punches", never treat as resolved
    const punches = res.data?.records || res.data || [];
    return Array.isArray(punches) ? punches : [];
  } catch (err) { console.error(`[minor-timecard-followup] employeePunches ${employeeId} error:`, err.message); return null; }
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <alerts@peoplecapitalgroup.com>', to: Array.isArray(to) ? to : [to], subject, html });
    const req = https.request({ hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

// Same shadow-mode testing as minor-timecard-detect-cron.mjs — see that
// file's comment for the full rationale. Both crons must apply this the same
// way so a shadow-mode test sees the complete Sunday-through-escalation flow
// in one inbox, not just the initial email.
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

const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try { await getAccessToken(); }
  catch (err) {
    console.error('[minor-timecard-followup] Paycor auth failed — aborting:', err.message);
    return new Response(JSON.stringify({ ok: false, error: `Paycor auth failed: ${err.message}` }), { status: 502, headers });
  }

  const now = new Date();
  const todayDateStr = now.toISOString().slice(0, 10);

  const [issuesRaw, usersRaw] = await Promise.all([blobLoad('pcg_minor_timecard_issues_v1'), blobLoad('pcg_users_v1')]);
  const issues = Array.isArray(issuesRaw) ? issuesRaw : [];
  const users = Array.isArray(usersRaw) ? usersRaw : [];

  // Group open issues (not first-flagged today — see the file's own schedule
  // comment) by store, so each store gets exactly one digest email covering
  // every one of its still-open issues today.
  const openByStore = {};
  let resolvedCount = 0, escalatedCount = 0;

  // Each issue is processed inside its own try/catch — one malformed record
  // (e.g. a corrupted date field) must never abort the whole run and lose
  // every other store's already-computed resolutions/escalations, matching
  // the per-store isolation the sibling detect-cron already uses.
  for (const issue of issues) {
    try {
      if (issue.status !== 'open') continue;
      if (issue.firstFlaggedAt.slice(0, 10) === todayDateStr) continue; // don't double-notify the day it was created

      const dayPunches = await fetchDayPunches(issue.employeeId, issue.violationDate);
      if (dayPunches !== null) {
        const freshResult = analyzeDayForViolation(dayPunches);
        const updated = applyResolutionCheck(issue, freshResult, now);
        if (updated.status === 'resolved') { resolvedCount++; Object.assign(issue, updated); continue; }
      }
      // still open (or fetch failed this run — leave it open, try again tomorrow)

      if (shouldEscalateToday(issue, todayDateStr)) { issue.escalatedAt = now.toISOString(); escalatedCount++; }

      if (!openByStore[issue.pc]) openByStore[issue.pc] = { storeName: issue.storeName, issues: [] };
      openByStore[issue.pc].issues.push({ issue, dayPunches: dayPunches || [] });
    } catch (err) {
      console.error(`[minor-timecard-followup] issue ${issue.id} error:`, err.message);
    }
  }

  let emailsSent = 0;
  for (const [pc, { storeName, issues: storeIssues }] of Object.entries(openByStore)) {
    try {
      const anyEscalated = storeIssues.some(({ issue }) => issue.escalatedAt);
      // Recipients must reflect the STORE's aggregate escalation state, not
      // just the first issue's — a store can have one long-escalated issue
      // and one freshly-flagged one in the same run. Picking whichever issue
      // is actually escalated (if any) keeps resolveNotificationRecipients'
      // per-issue contract correct without changing that function itself.
      // Confirmed necessary via review (2026-09-29): the naive
      // storeIssues[0].issue version silently dropped DM/office-staff from
      // an escalated issue's email whenever a not-yet-escalated issue
      // happened to sort first in the array.
      const representativeIssue = anyEscalated ? storeIssues.find(({ issue }) => issue.escalatedAt).issue : storeIssues[0].issue;
      const oldestFlagged = storeIssues.reduce((min, { issue }) => issue.firstFlaggedAt < min ? issue.firstFlaggedAt : min, storeIssues[0].issue.firstFlaggedAt);
      const dayN = daysBetween(oldestFlagged.slice(0, 10), todayDateStr) + 1;
      const realRecipients = resolveNotificationRecipients(representativeIssue, users);
      const { recipients, subject, html } = applyShadowMode(realRecipients, buildEmailSubject(storeName, anyEscalated, anyEscalated ? dayN : null), buildDigestEmailHtml(storeName, storeIssues));
      for (const r of recipients) {
        const status = await sendEmail(r.email, subject, html);
        const record = { recipientRole: r.role, recipientEmail: r.email, sentAt: now.toISOString(), success: status >= 200 && status < 300, error: status >= 200 && status < 300 ? null : `HTTP ${status}` };
        storeIssues.forEach(({ issue }) => issue.notifications.push(record));
      }
      if (recipients.length) emailsSent++;

      // 7-day exec backstop — once per issue, independent of the regular digest above.
      for (const { issue } of storeIssues) {
        if (execBackstopDue(issue, todayDateStr)) {
          const realExecUsers = users.filter(u => u.active !== false && (u.userType === 'executive' || u.userType === 'it') && u.email).map(u => ({ role: 'exec_backstop', email: u.email }));
          const backstop = applyShadowMode(realExecUsers, `⚠ Minor Timecard Unresolved 7+ Days — ${storeName}`, buildDigestEmailHtml(storeName, [{ issue, dayPunches: [] }]));
          for (const r of backstop.recipients) {
            const status = await sendEmail(r.email, backstop.subject, backstop.html);
            issue.notifications.push({ recipientRole: 'exec_backstop', recipientEmail: r.email, sentAt: now.toISOString(), success: status >= 200 && status < 300, error: status >= 200 && status < 300 ? null : `HTTP ${status}` });
          }
        }
      }
    } catch (err) {
      console.error(`[minor-timecard-followup] store ${pc} notification error:`, err.message);
    }
  }

  await blobSave('pcg_minor_timecard_issues_v1', issues);

  const summary = { ok: true, checked: issues.filter(i => i.status === 'open').length + resolvedCount, resolved: resolvedCount, newlyEscalated: escalatedCount, storesEmailed: emailsSent };
  console.log('[minor-timecard-followup] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
