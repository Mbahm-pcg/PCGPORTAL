// netlify/functions/minor-timecard-detect-cron-background.mjs — Sunday morning:
// scans every store's under-18 employees for the week that just ended, flags any
// PA minor-labor-law violation (5+ consecutive hours, no qualifying 30-min
// break), and emails each affected store's manager.
//
// Named "-background" (NOT plain "-cron") on purpose: only a "-background"
// filename gets Netlify's 15-minute execution budget; everything else gets the
// default ~60s. employee-directory-cron-background.mjs hit a flat 60000 ms
// timeout on 2026-09-28 doing 45+ stores x 2 Paycor calls, and this function
// does strictly more than that (46 stores x 2 calls, PLUS a week-of-punches
// call per minor). Emails go out inside the per-store loop but the issue blob
// is only written at the very end, so a hard timeout here would notify managers
// and then lose every issue record — never rename this back.
//
// IMPORTANT — data scope: Paycor's employeesIdentifyingData endpoint also
// returns socialSecurityNumber alongside birthDate. This file never talks to
// that endpoint directly: it goes through tips-report-cron-background.mjs's
// fetchAllIdentifyingData, which calls our own paycor.mjs proxy — and that
// proxy strips every field except {employeeId, birthDate} before the response
// ever leaves it. Only ever read/store `birthDate`. See memory:
// project_paycor_identifying_data_scope.
//
// Rollout switch — env MINOR_TIMECARD_LIVE (same 3-state, fail-safe shape as
// NO_CLOCKIN_LIVE in no-clockin-cron.mjs):
//   unset / anything else -> off:    detects and logs only. Sends NOTHING (not
//                                    even to the shadow address) and writes
//                                    NOTHING. Safe to deploy unconfigured.
//   'shadow'              -> shadow: every email is redirected to
//                                    MINOR_TIMECARD_SHADOW_EMAIL (labelled with
//                                    who it would really have reached); issue
//                                    state IS written normally.
//   'true'                -> live:   real managers / DMs / office staff.
// Going from 'shadow' to 'true' requires clearing pcg_minor_timecard_issues_v1
// first — see the go-live runbook in minor-timecard-followup-cron.mjs's header.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { STORES, fetchAllEmployees, fetchAllIdentifyingData } from './tips-report-cron-background.mjs';
import { weekRangeEndingYesterday, groupPunchesByDate, analyzeDayForViolation, ageFromBirthDate, isMinor } from '../../src/minor-timecard-detect.mjs';
import { buildIssueRecord, resolveNotificationRecipients } from '../../src/minor-timecard-lifecycle.mjs';
import { buildEmailSubject, buildDigestEmailHtml } from '../../src/minor-timecard-email.mjs';

export const config = { schedule: '0 10 * * 0' }; // 6:00 AM ET, Sundays

const ROSTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ISSUES_KEY = 'pcg_minor_timecard_issues_v1';

function resolveMode() {
  const flag = process.env.MINOR_TIMECARD_LIVE;
  let mode = flag === 'true' ? 'live' : flag === 'shadow' ? 'shadow' : 'off';
  if (mode === 'shadow' && !process.env.MINOR_TIMECARD_SHADOW_EMAIL) {
    console.warn('[minor-timecard-detect] shadow mode needs MINOR_TIMECARD_SHADOW_EMAIL to be set; falling back to off (nothing sent, nothing written)');
    mode = 'off';
  }
  return mode;
}

// ── Paycor OAuth ──
// Still needed here for employeePunches only: the employees/identifyingData
// reads now go through tips-report-cron-background.mjs's shared, SSN-stripping
// proxy helpers (see the file header), but there is no shared export for a
// per-employee punches read, so this file keeps its own minimal token path for
// that one call — same arrangement employee-directory-cron-background.mjs has
// for its own non-shared calls.
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

// Paycor has a confirmed failure mode where an ERROR is returned as valid JSON
// with HTTP 200 and no `records` array at all — just a Title/CorrelationId
// (2026-08-19 Westchester incident; same guard lives in
// tips-report-cron-background.mjs's fetchStoreCrew/fetchAllEmployees). Reading
// that as "this employee worked zero hours" would silently clear a real
// violation, so it is turned into a thrown error here instead.
function extractPunchRecords(data, ctx) {
  if (data == null || typeof data !== 'object') {
    throw new Error(`Paycor returned a non-JSON punches payload for ${ctx}`);
  }
  if (!Array.isArray(data.records) && !Array.isArray(data) && (data.Title || data.CorrelationId)) {
    throw new Error(`Paycor error response: ${data.Title || 'unknown'} — ${data.Detail || ''}`);
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.records)) return data.records;
  // Object with neither a records array nor an error marker — genuinely
  // ambiguous. Treated as empty (matching fetchStoreCrew's convention) but
  // logged, so a never-before-seen response shape is visible rather than silent.
  console.warn(`[minor-timecard-detect] employeePunches ${ctx}: unrecognised payload shape, treating as zero punches`);
  return [];
}

// Single call spanning the whole week, grouped locally by day — far fewer
// Paycor calls than fetching each of the 7 days separately across every minor
// at every store.
//
// Non-200/thrown failures are logged, not silently swallowed — confirmed
// necessary the hard way (2026-07-21, the original break-compliance-cron.mjs):
// a Paycor call failing this way is otherwise indistinguishable from "this
// employee genuinely worked no hours," which for a legal-compliance detector
// means silently reporting "all fine" while never actually checking anything.
async function fetchWeekPunches(employeeId, weekStart, weekEnd) {
  try {
    const res = await callPaycor(`/v1/employees/${employeeId}/employeePunches?startDate=${weekStart}&endDate=${weekEnd}`);
    if (res.status !== 200) { console.error(`[minor-timecard-detect] employeePunches ${employeeId} failed: HTTP ${res.status}`); return []; }
    return extractPunchRecords(res.data, employeeId);
  } catch (err) { console.error(`[minor-timecard-detect] employeePunches ${employeeId} error:`, err.message); return []; }
}

// Only `birthDate` is ever read off an identifyingData record — see file header.
// fetchAllEmployees/fetchAllIdentifyingData throw on a Paycor failure (including
// the disguised-error shape above), which the per-store try/catch below turns
// into "skip this store, log it" rather than "this store has no minors".
async function getMinorRoster(store, cache) {
  const cached = cache?.[store.pc];
  if (cached && Date.now() - new Date(cached.updatedAt).getTime() < ROSTER_MAX_AGE_MS) return cached.minors;
  const [employees, identifying] = await Promise.all([
    fetchAllEmployees(store.paycor),
    fetchAllIdentifyingData(store.paycor),
  ]);
  const birthDateById = new Map((identifying || []).map(r => [r.employeeId, r.birthDate || null]));
  return (employees || [])
    .filter(e => e && e.id && e.statusData?.status === 'Active')
    .map(e => ({
      employeeId: e.id,
      name: `${e.firstName || ''} ${e.lastName || ''}`.trim(),
      age: ageFromBirthDate(birthDateById.get(e.id) || null),
    }))
    .filter(e => isMinor(e.age))
    .map(e => ({ employeeId: e.employeeId, name: e.name }));
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <alerts@peoplecapitalgroup.com>', to: Array.isArray(to) ? to : [to], subject, html });
    const req = https.request({ hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.write(body); req.end();
  });
}

// Shadow-mode testing (matches the established NO_CLOCKIN_SHADOW_USER pattern
// in no-clockin-lib/run.mjs): in 'shadow' mode every real recipient is
// collapsed into MINOR_TIMECARD_SHADOW_EMAIL instead, labelled with who it
// would really have gone to — lets this be validated against real Paycor data
// without ever reaching a real manager/DM/office-staff inbox. 'off' never gets
// here at all (nothing is sent in that mode); 'live' passes straight through.
function applyShadowMode(recipients, subject, html, mode) {
  const shadowEmail = process.env.MINOR_TIMECARD_SHADOW_EMAIL;
  if (mode !== 'shadow' || !shadowEmail) return { recipients, subject, html };
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

  const mode = resolveMode();

  try { await getAccessToken(); }
  catch (err) {
    console.error('[minor-timecard-detect] Paycor auth failed — aborting:', err.message);
    return new Response(JSON.stringify({ ok: false, error: `Paycor auth failed: ${err.message}` }), { status: 502, headers });
  }

  const now = new Date();
  const { weekStart, weekEnd } = weekRangeEndingYesterday(now);

  const [rosterCache, existingIssuesRaw, usersRaw] = await Promise.all([
    blobLoad('pcg_minor_roster_v1'),
    blobLoad(ISSUES_KEY),
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
              consecutiveHours: result.consecutiveHours,
              // The gap INSIDE the stretch that actually violated — stored so
              // every email about this issue shows the same break figure the
              // violation was decided on, instead of re-deriving a second,
              // possibly-different number from raw punches later.
              longestGapMinutes: result.violationGapMinutes,
              now,
            });
            if (existingIds.has(issue.id)) continue; // already tracked from a prior run this week
            storeNewIssues.push({ issue, dayPunches });
          }
        }
        if (!storeNewIssues.length) return;

        const realRecipients = resolveNotificationRecipients(storeNewIssues[0].issue, users); // manager-only pre-escalation, same for every issue at this store today
        const { recipients, subject, html } = applyShadowMode(realRecipients, buildEmailSubject(store.name, false, null), buildDigestEmailHtml(store.name, storeNewIssues), mode);
        const notifications = [];
        if (mode === 'off') {
          console.log(`[minor-timecard-detect] (log-only) ${store.name}: ${storeNewIssues.length} new issue(s); would email ${realRecipients.map(r => `${r.role}: ${r.email}`).join(', ') || '(no recipients)'}`);
        } else {
          // Misleading wording fixed 2026-10-02 (live-tested 2026-09-30, see
          // [[project_minor_timecard_compliance]]): this fires whenever no REAL
          // recipient could be resolved (no manager record with this store's PC
          // set) — but in shadow mode, applyShadowMode above unconditionally
          // redirects to MINOR_TIMECARD_SHADOW_EMAIL regardless of whether
          // realRecipients was empty, so the email DOES still send in that case.
          // Confirmed live: Ahmed received the Rosemore/Hatboro shadow test
          // emails despite this exact warning firing for both. Only claim
          // "NOBODY was notified" when that's actually true — i.e. the final
          // post-shadow-mode `recipients` list (not `realRecipients`) is also
          // empty, which only happens in live ('true') mode.
          if (!realRecipients.length) {
            if (recipients.length) {
              console.warn(`[minor-timecard-detect] ${store.name} has ${storeNewIssues.length} new issue(s) but no resolvable REAL recipient (no manager record with this store's PC set) — shadow mode redirected the email to ${recipients.map(r => r.email).join(', ')} instead, so it DID send, just not to a real manager`);
            } else {
              console.warn(`[minor-timecard-detect] ${store.name} has ${storeNewIssues.length} new issue(s) but no resolvable recipients — NOBODY was notified`);
            }
          }
          for (const r of recipients) {
            const status = await sendEmail(r.email, subject, html);
            notifications.push({ recipientRole: r.role, recipientEmail: r.email, sentAt: now.toISOString(), success: status >= 200 && status < 300, error: status >= 200 && status < 300 ? null : `HTTP ${status}` });
          }
        }
        for (const { issue } of storeNewIssues) { issue.notifications = notifications; newIssues.push(issue); }
        emailsSent.push({ pc: store.pc, storeName: store.name, issueCount: storeNewIssues.length });
      } catch (err) {
        console.error(`[minor-timecard-detect] ${store.name} error:`, err.message);
      }
    }));
  }

  // 'off' is fully inert: nothing sent above, nothing written here. That makes
  // deploying this with no configuration at all a no-op instead of a blast of
  // 46 stores' worth of real manager email on the first Sunday.
  let saved = false;
  if (mode === 'off') {
    console.log(`[minor-timecard-detect] (log-only) would have recorded ${newIssues.length} new issue(s) across ${emailsSent.length} store(s); nothing written. Set MINOR_TIMECARD_LIVE=shadow or =true to act.`);
  } else {
    // Re-read the issues blob immediately before writing and merge onto THAT,
    // rather than blind-writing the copy loaded at the top of this run: the
    // manual-resolve endpoint (and, if schedules ever drift, the followup cron)
    // write the same key, and a run this long leaves a real window for one of
    // them to land in between. Only genuinely-new ids are appended.
    const freshRaw = await blobLoad(ISSUES_KEY);
    let base = existingIssues;
    if (Array.isArray(freshRaw)) base = freshRaw;
    else console.warn('[minor-timecard-detect] issues blob re-read returned nothing before save — falling back to the copy loaded at the start of this run');
    const baseIds = new Set(base.map(i => i.id));
    const merged = [...base, ...newIssues.filter(i => !baseIds.has(i.id))];
    try {
      await Promise.all([
        blobSave('pcg_minor_roster_v1', newRosterCache),
        blobSave(ISSUES_KEY, merged),
      ]);
      saved = true;
    } catch (err) {
      // Emails have already gone out at this point, so a lost write means
      // managers were told about issues nothing is now tracking. Loud on purpose.
      console.error('[minor-timecard-detect] BLOB SAVE FAILED after emails were already sent — issue records lost for this run:', err.message);
    }
  }

  const summary = { ok: true, mode, weekStart, weekEnd, newIssues: newIssues.length, storesAffected: emailsSent.length, storesEmailed: mode === 'off' ? 0 : emailsSent.length, saved };
  console.log('[minor-timecard-detect] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
