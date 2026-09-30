// netlify/functions/minor-timecard-followup-cron.mjs — runs every morning.
// For every currently-open minor-timecard issue: re-checks that one specific
// employee/day against live Paycor data. Resolves it automatically if the
// violation is gone; otherwise escalates it (Manager -> +DM +Office Staff)
// once it crosses into the Monday after the week it was flagged, and sends a
// fresh reminder to whoever is currently in the loop — every day, until
// resolved. See docs/superpowers/specs/2026-09-29-minor-timecard-compliance-design.md.
//
// Scheduled at 11:30 UTC, deliberately 90 minutes AFTER the Sunday detect run
// (10:00 UTC): both functions read-modify-write pcg_minor_timecard_issues_v1,
// and running them at the same minute guaranteed a lost update every Sunday.
// The gap is the primary defence; the merge-onto-a-fresh-read at the bottom of
// this file is the belt-and-braces second one.
//
// ── Rollout switch — env MINOR_TIMECARD_LIVE ────────────────────────────────
// Same 3-state, fail-safe shape as NO_CLOCKIN_LIVE (no-clockin-cron.mjs):
//   unset / anything else -> off:    computes resolutions/escalations and logs
//                                    what it WOULD do. Sends nothing (not even
//                                    to the shadow address), writes nothing.
//   'shadow'              -> shadow: every email is redirected to
//                                    MINOR_TIMECARD_SHADOW_EMAIL; issue state
//                                    IS written normally.
//   'true'                -> live:   real manager / DM / office staff / exec.
//
// ── GO-LIVE RUNBOOK — read before setting MINOR_TIMECARD_LIVE=true ──────────
//   1. Deploy with MINOR_TIMECARD_LIVE unset. Confirm from the logs that the
//      Sunday detect run finds a sane number of issues and that this cron's
//      daily "(log-only)" lines name the right recipients.
//   2. Set MINOR_TIMECARD_LIVE=shadow and MINOR_TIMECARD_SHADOW_EMAIL=<you>.
//      Run for at least one FULL week, so the whole Sunday-detect -> Monday-
//      escalation -> daily-reminder arc lands in one inbox and can be checked
//      against real Paycor data.
//   3. BEFORE flipping to 'true', CLEAR pcg_minor_timecard_issues_v1 (delete
//      the blob, or write an empty array to it). This is not optional. Shadow
//      runs write REAL issue records, REAL escalatedAt timestamps and REAL
//      notifications entries — including recipientRole:'exec_backstop' rows —
//      even though the mail only ever reached the shadow address. Carrying
//      those into live operation would (a) permanently suppress the real exec
//      backstop for those issues, because execBackstopDue() sees an
//      'exec_backstop' entry and treats it as already sent, and (b) make the
//      first email a real manager ever receives an already-escalated
//      "Still Open — Day 12" notice CC'ing their DM and every office_staff
//      user, for a violation nobody ever told them about.
//   4. Then set MINOR_TIMECARD_LIVE=true. The next Sunday detect run
//      re-creates the current week's issues from scratch, cleanly.
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { analyzeDayForViolation } from '../../src/minor-timecard-detect.mjs';
import { shouldEscalateToday, execBackstopDue, resolveNotificationRecipients, applyResolutionCheck } from '../../src/minor-timecard-lifecycle.mjs';
import { buildEmailSubject, buildDigestEmailHtml } from '../../src/minor-timecard-email.mjs';

export const config = { schedule: '30 11 * * *' }; // 7:30 AM ET, every day (after the Sunday detect run)

const ISSUES_KEY = 'pcg_minor_timecard_issues_v1';

function resolveMode() {
  const flag = process.env.MINOR_TIMECARD_LIVE;
  let mode = flag === 'true' ? 'live' : flag === 'shadow' ? 'shadow' : 'off';
  if (mode === 'shadow' && !process.env.MINOR_TIMECARD_SHADOW_EMAIL) {
    console.warn('[minor-timecard-followup] shadow mode needs MINOR_TIMECARD_SHADOW_EMAIL to be set; falling back to off (nothing sent, nothing written)');
    mode = 'off';
  }
  return mode;
}

// ── Paycor OAuth (same as minor-timecard-detect-cron-background.mjs) ──
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

// Paycor has a confirmed failure mode where an ERROR comes back as valid JSON
// with HTTP 200 and no `records` array at all — just a Title/CorrelationId
// (2026-08-19 Westchester incident; same guard lives in
// tips-report-cron-background.mjs's fetchStoreCrew). Reading that as "this
// employee worked zero hours that day" would auto-resolve a live violation with
// no evidence whatsoever, so it is turned into a thrown error — which the
// caller's catch converts to `null` ("fetch failed, don't resolve"), never `[]`.
function extractPunchRecords(data, ctx) {
  if (data == null || typeof data !== 'object') {
    throw new Error(`Paycor returned a non-JSON punches payload for ${ctx}`);
  }
  if (!Array.isArray(data.records) && !Array.isArray(data) && (data.Title || data.CorrelationId)) {
    throw new Error(`Paycor error response: ${data.Title || 'unknown'} — ${data.Detail || ''}`);
  }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.records)) return data.records;
  // Object with neither a records array nor an error marker — ambiguous.
  // Treated as empty (matching fetchStoreCrew's convention) but logged, so a
  // never-before-seen response shape is visible rather than silent.
  console.warn(`[minor-timecard-followup] employeePunches ${ctx}: unrecognised payload shape, treating as zero punches`);
  return [];
}

// Returns an array of punches on success (possibly empty — a real "nothing was
// worked/logged that day"), or null when the fetch itself failed. The caller
// MUST keep those two apart: only a successful fetch can resolve an issue.
async function fetchDayPunches(employeeId, dateStr) {
  try {
    const res = await callPaycor(`/v1/employees/${employeeId}/employeePunches?startDate=${dateStr}&endDate=${dateStr}`);
    if (res.status !== 200) { console.error(`[minor-timecard-followup] employeePunches ${employeeId} failed: HTTP ${res.status}`); return null; } // fetch failure — distinct from "no punches", never treat as resolved
    return extractPunchRecords(res.data, employeeId);
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

// Same shadow-mode testing as minor-timecard-detect-cron-background.mjs — see
// that file's comment for the full rationale. Both crons must apply this the
// same way so a shadow-mode test sees the complete Sunday-through-escalation
// flow in one inbox, not just the initial email. 'off' never reaches here
// (nothing is sent in that mode); 'live' passes straight through.
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

const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

// Cheap change-detector: every field this run is allowed to mutate on an issue
// record is covered below, so comparing this signature before and after is
// enough to know exactly which issues to merge back on save — without having
// to remember to touch a Set at every mutation site.
const issueSignature = (i) => `${i.status}|${i.escalatedAt || ''}|${(i.notifications || []).length}|${i.resolvedAt || ''}`;

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const mode = resolveMode();

  try { await getAccessToken(); }
  catch (err) {
    console.error('[minor-timecard-followup] Paycor auth failed — aborting:', err.message);
    return new Response(JSON.stringify({ ok: false, error: `Paycor auth failed: ${err.message}` }), { status: 502, headers });
  }

  const now = new Date();
  const todayDateStr = now.toISOString().slice(0, 10);

  const [issuesRaw, usersRaw] = await Promise.all([blobLoad(ISSUES_KEY), blobLoad('pcg_users_v1')]);
  const issues = Array.isArray(issuesRaw) ? issuesRaw : [];
  const users = Array.isArray(usersRaw) ? usersRaw : [];
  const signatureAtLoad = new Map(issues.map(i => [i.id, issueSignature(i)]));

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
      // dayPunches is passed through RAW — null (fetch failed) must stay null
      // all the way into the email builder, which renders "punch data
      // unavailable" for it. Flattening it to [] here made a Paycor outage
      // read as a confirmed "no break recorded", which is the same wrong
      // failure mode already fixed on the UI side.
      openByStore[issue.pc].issues.push({ issue, dayPunches });
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
      const { recipients, subject, html } = applyShadowMode(realRecipients, buildEmailSubject(storeName, anyEscalated, anyEscalated ? dayN : null), buildDigestEmailHtml(storeName, storeIssues), mode);
      if (mode === 'off') {
        console.log(`[minor-timecard-followup] (log-only) ${storeName}: ${storeIssues.length} open issue(s)${anyEscalated ? ` (escalated, day ${dayN})` : ''}; would email ${realRecipients.map(r => `${r.role}: ${r.email}`).join(', ') || '(no recipients)'}`);
        if (realRecipients.length) emailsSent++;
      } else {
        if (!realRecipients.length) console.warn(`[minor-timecard-followup] ${storeName} has ${storeIssues.length} open issue(s) but no resolvable recipients — NOBODY was notified`);
        for (const r of recipients) {
          const status = await sendEmail(r.email, subject, html);
          const record = { recipientRole: r.role, recipientEmail: r.email, sentAt: now.toISOString(), success: status >= 200 && status < 300, error: status >= 200 && status < 300 ? null : `HTTP ${status}` };
          storeIssues.forEach(({ issue }) => issue.notifications.push(record));
        }
        if (recipients.length) emailsSent++;
      }

      // 7-day exec backstop — once per issue, independent of the regular digest
      // above. dayPunches is the SAME value already fetched for this issue at
      // the top of this run (null when that fetch failed), not a hardcoded
      // empty array — passing [] made every backstop email claim "no break
      // recorded during shift" regardless of what Paycor actually held.
      for (const { issue, dayPunches } of storeIssues) {
        if (execBackstopDue(issue, todayDateStr)) {
          const realExecUsers = users.filter(u => u.active !== false && (u.userType === 'executive' || u.userType === 'it') && u.email).map(u => ({ role: 'exec_backstop', email: u.email }));
          const backstop = applyShadowMode(realExecUsers, `⚠ Minor Timecard Unresolved 7+ Days — ${storeName}`, buildDigestEmailHtml(storeName, [{ issue, dayPunches }]), mode);
          if (mode === 'off') {
            console.log(`[minor-timecard-followup] (log-only) exec backstop for issue ${issue.id}; would email ${realExecUsers.map(r => r.email).join(', ') || '(no exec/IT recipients)'}`);
            continue;
          }
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

  // ── Save ────────────────────────────────────────────────────────────────
  // Never blind-write `issues` back: the Sunday detect run and the manual
  // resolve endpoint write this same key, so the array loaded at the top of
  // this run can already be stale by the time we get here. Re-read, then apply
  // ONLY the records this run actually changed onto that fresher array.
  let saved = false;
  // `i.id` guard: merging by id is only sound for records that have one — an
  // id-less record could otherwise match the wrong entry in the fresh array.
  const changed = issues.filter(i => i && i.id && issueSignature(i) !== signatureAtLoad.get(i.id));
  if (mode === 'off') {
    console.log(`[minor-timecard-followup] (log-only) would have updated ${changed.length} issue(s); nothing written. Set MINOR_TIMECARD_LIVE=shadow or =true to act.`);
  } else if (!changed.length) {
    saved = true; // nothing to write is a successful no-op, not a failure
  } else {
    const freshIssuesRaw = await blobLoad(ISSUES_KEY);
    const freshIssues = Array.isArray(freshIssuesRaw) ? freshIssuesRaw : null;
    if (freshIssues === null) {
      // Writing `changed` alone here would erase every untouched issue. A
      // skipped save just means these resolutions/escalations get recomputed
      // (and re-emailed) tomorrow — strictly better than destroying state.
      console.error('[minor-timecard-followup] issues blob re-read failed before save — SKIPPING the write rather than risk overwriting live state with a partial array. Changes will be recomputed next run.');
    } else {
      for (const c of changed) {
        const idx = freshIssues.findIndex(f => f.id === c.id);
        if (idx >= 0) freshIssues[idx] = c; else freshIssues.push(c);
      }
      try { await blobSave(ISSUES_KEY, freshIssues); saved = true; }
      catch (err) { console.error('[minor-timecard-followup] BLOB SAVE FAILED after emails were already sent — this run\'s resolutions/escalations lost:', err.message); }
    }
  }

  const summary = { ok: true, mode, checked: issues.filter(i => i.status === 'open').length + resolvedCount, resolved: resolvedCount, newlyEscalated: escalatedCount, storesEmailed: emailsSent, issuesUpdated: changed.length, saved };
  console.log('[minor-timecard-followup] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers });
};
