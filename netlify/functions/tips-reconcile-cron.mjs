// tips-reconcile-cron.mjs — Daily Late-Punch Reconciliation
// Runs daily, 9am ET (after both tips-report-cron-background's nightly run
// and tips-report-morning-sweep-background's retry pass). Re-checks the last
// few days' already-saved tips snapshots against LIVE Paycor punch data —
// catches employees whose punches were entered/corrected in Paycor AFTER
// their day's report already ran and got saved (confirmed real, 2026-08-19:
// Shyam Patel at Rosemore had 6h real punches on 8/14 and 8/15 that weren't
// in either day's snapshot because they were added to Paycor later; same
// class of issue found separately at Wadsworth — Rodney Jeanty's hours were
// under-counted by 3h for the same reason). This is the exact "known
// limitation (accepted)" called out in tips-report-cron-background.mjs's own
// header comment — this file closes that gap automatically instead of
// relying on someone noticing and asking for a manual fix.
//
// Auto-corrects any mismatch found (safe: only ever replaces one store's crew
// array for one specific day, using the same tip pool already captured —
// never touches Pulse data or other stores) and emails a daily summary of
// exactly what changed, so corrections are never silent.
import https from 'node:https';
import { STORES, fetchStoreCrew, saveDaySnapshot, getBlobStore, etDate, MANUALLY_EXCLUDED_EMPLOYEES } from './tips-report-cron-background.mjs';

export const config = { schedule: '0 13 * * *' };

async function loadDaySnapshotUncached(busDt) {
  try {
    const raw = await getBlobStore().get(`pcg_tips_snapshot_${busDt}`, { type: 'json' });
    return raw?.data || null;
  } catch { return null; }
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

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Shared by the daily cron (short lookback), the manual refresh sibling
// (longer on-demand trace-back), and the biweekly-boundary settle pass in
// tips-report-cron-background.mjs (which needs the exact dates of a
// closed pay period, not "N days back from today" — those aren't the
// same thing once the settle runs days after the period actually ended).
//
// opts (all optional; omitting the whole object preserves the exact
// pre-existing behavior for the daily cron and the manual refresh):
//   budgetMs  — override the internal time budget. The 12-minute default
//               assumes this function owns nearly a whole 15-minute
//               background invocation; the biweekly settle pass does NOT
//               (it runs after the payroll report is already built and
//               sent), so it passes a much smaller budget.
//   sendEmail — set false to suppress this function's own correction
//               email. The biweekly settle path sends its own period-
//               finalize email instead, and two reconcile-flavored emails
//               with different framing on the same night is worse than one.
export async function runReconcileForDates(dates, onlyPc = null, opts = {}) {
  const targetStores = onlyPc ? STORES.filter(s => String(s.pc) === String(onlyPc)) : STORES;
  const emailEnabled = opts.sendEmail !== false;

  const corrections = [];
  const invocationStart = Date.now();
  const BUDGET_MS = opts.budgetMs ?? 12 * 60 * 1000;
  let skippedForBudget = false;

  outer:
  for (const busDt of dates) {
    const snapArr = await loadDaySnapshotUncached(busDt);
    if (!Array.isArray(snapArr)) continue;

    for (const s of targetStores) {
      if (Date.now() - invocationStart > BUDGET_MS) { skippedForBudget = true; break outer; }

      const idx = snapArr.findIndex(x => String(x.pc) === String(s.pc));
      const saved = idx >= 0 ? snapArr[idx] : null;
      // Only reconcile days that already succeeded — a day still crewStatus:
      // 'error' is a separate concern (a real outage, handled by the morning
      // sweep / manual retry), not a late-punch-correction case.
      if (!saved || saved.crewStatus !== 'ok') continue;

      const { crew: liveCrew, crewStatus } = await fetchStoreCrew(s, busDt);
      if (crewStatus !== 'ok') continue; // live fetch itself failed — don't risk overwriting good saved data with a bad live read

      // 0.5h tolerance, not a tight one — confirmed directly (2026-08-19) that
      // Paycor quietly fine-tunes/rounds punch hourAmount by a few minutes in
      // the day or two after a punch is recorded (e.g. 6.06667h settling to
      // exactly 6h), with zero connection to any real schedule correction. A
      // tight tolerance flagged nearly every employee on every day as
      // "changed" purely from that noise. Real corrections (someone entirely
      // missing, or genuinely off by an hour+) are nowhere near this size.
      // Match by ANY shared identifier (guid, then payrollId, then name),
      // not a single preferred key — confirmed via direct testing
      // (2026-08-20) that a single-preferred-key version broke the exact
      // transition this fix needs to survive: data saved BEFORE this change
      // has no `guid` field at all, so comparing it against a live fetch
      // that now always has one would key them differently (guid-based vs
      // name-based) and make EVERY employee at EVERY store look like a
      // simultaneous add+drop the first time this runs post-deploy — worse
      // than the bug being fixed. Trying every available key (most to least
      // specific) means an old name-only saved entry still matches a new
      // guid-carrying live entry via the shared name, while two guid-
      // carrying entries match directly via guid regardless of payrollId
      // drift (the original problem this was built to solve).
      function candidateKeys(c) {
        const keys = [];
        if (c.guid) keys.push('g:' + c.guid);
        if (c.payrollId) keys.push('p:' + c.payrollId);
        if (c.name) keys.push('n:' + c.name);
        return keys;
      }
      function indexByAnyKey(crew) {
        const map = {};
        crew.forEach(c => { candidateKeys(c).forEach(k => { if (!map[k]) map[k] = c; }); });
        return map;
      }
      function findMatch(c, indexMap) {
        for (const k of candidateKeys(c)) { if (indexMap[k]) return indexMap[k]; }
        return null;
      }
      const savedIndex = indexByAnyKey(saved.crew || []);
      const matchedSavedEntries = new Set();

      const pendingCorrections = [];
      let mismatch = false;
      for (const lc of liveCrew) {
        const prev = findMatch(lc, savedIndex);
        if (!prev) {
          pendingCorrections.push({ store: s.name, pc: s.pc, busDt, employee: lc.name, change: `added — ${lc.hours.toFixed(2)}h (was missing entirely)` });
          mismatch = true;
        } else {
          matchedSavedEntries.add(prev);
          if (Math.abs(prev.hours - lc.hours) > 0.5) {
            pendingCorrections.push({ store: s.name, pc: s.pc, busDt, employee: lc.name, change: `${prev.hours.toFixed(2)}h → ${lc.hours.toFixed(2)}h` });
            mismatch = true;
          }
        }
      }

      // Someone with real saved hours missing from the live fetch entirely —
      // could be a genuine drop (voided punch, corrected timecard) or the
      // same transient Paycor fetch glitch already confirmed this week
      // (BJ's, Grant, and Red Lion all silently lost a real employee's punch
      // this exact way). This job runs unattended and writes its own fixes
      // automatically, so guessing wrong here means automatically deleting
      // someone's pay with nobody in the loop — worse than delaying a
      // legitimate correction by a day. Flag it and skip the auto-fix for
      // this store/day ENTIRELY (even a real correction found above) rather
      // than risk it; a genuine drop should go through as a reviewed manual
      // correction instead, and this alert is exactly what surfaces it.
      // A saved crew member who's now permanently, intentionally excluded
      // (MANUALLY_EXCLUDED_EMPLOYEES — see tips-report-cron-background.mjs)
      // is EXPECTED to be missing from every live fetch going forward,
      // regardless of the date being checked (fetchStoreCrew's exclusion
      // filter isn't date-aware). Confirmed via audit (2026-08-21): without
      // this check, an intentional exclusion looked identical to a genuine
      // suspicious drop and silently withheld every OTHER, unrelated,
      // legitimate correction for that same store/day — the exact class of
      // late-punch fix this file exists to apply automatically. Matched by
      // guid first (stable), falling back to name for snapshots saved
      // before the guid field existed.
      const excludedAtThisStore = MANUALLY_EXCLUDED_EMPLOYEES.filter(e => e.pc === String(s.pc));
      const isKnownExcluded = (sc) => excludedAtThisStore.some(e => (sc.guid && sc.guid === e.guid) || sc.name === e.name);

      let hasSuspiciousDrop = false;
      const dropNotices = [];
      for (const sc of (saved.crew || [])) {
        if (matchedSavedEntries.has(sc) || isKnownExcluded(sc)) continue;
        dropNotices.push({ store: s.name, pc: s.pc, busDt, employee: sc.name, change: `POSSIBLE DROP — missing from live fetch (was ${sc.hours.toFixed(2)}h saved); NOT auto-removed, needs manual review` });
        hasSuspiciousDrop = true;
      }

      if (hasSuspiciousDrop) {
        // Confirmed via re-audit (2026-08-20): previously these still landed
        // in the same `corrections` list as genuinely-applied fixes, so the
        // email's blanket "All were auto-corrected... no action needed"
        // summary was FALSE for these specific rows with no way to tell —
        // explicitly label them as withheld instead of silently conflating
        // "found" with "applied."
        pendingCorrections.forEach(c => corrections.push({ ...c, change: `${c.change} — NOT APPLIED (withheld: a different employee looked dropped in this same fetch, see below)` }));
        corrections.push(...dropNotices);
        continue;
      }
      if (!mismatch) continue;

      corrections.push(...pendingCorrections);
      // Rebuild just this store's entry for this day — same tip pool/rows
      // already captured (Pulse data doesn't need refetching), only the crew
      // array changes.
      const nextEntry = { ...saved, crew: liveCrew, crewStatus: 'ok' };
      const nextArr = idx >= 0 ? snapArr.map((x, i) => i === idx ? nextEntry : x) : [...snapArr, nextEntry];
      await saveDaySnapshot(busDt, nextArr);
      snapArr[idx] = nextEntry; // keep in-memory copy in sync in case the same store/day is touched again this run
    }
  }

  if (corrections.length > 0 && emailEnabled) {
    // Not every row here was actually applied — a row can be "NOT APPLIED"
    // or "POSSIBLE DROP" (withheld because a different employee looked
    // dropped in the same fetch, see the per-store/day skip logic above).
    // Confirmed via re-audit (2026-08-20) that the summary line below
    // previously claimed "all were auto-corrected" unconditionally, which
    // was false for exactly these rows with no way to tell from the email.
    const withheldCount = corrections.filter(c => c.change.includes('NOT APPLIED') || c.change.includes('POSSIBLE DROP')).length;
    const appliedCount = corrections.length - withheldCount;
    const rows = corrections.map(c => `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee;">${escapeHtml(c.busDt)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;">${escapeHtml(c.store)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;">${escapeHtml(c.employee)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;">${escapeHtml(c.change)}</td></tr>`).join('');
    const summaryLine = withheldCount > 0
      ? `Daily tips reconciliation found ${corrections.length} item${corrections.length !== 1 ? 's' : ''} across the last ${dates.length} day${dates.length !== 1 ? 's' : ''}: ${appliedCount} correction${appliedCount !== 1 ? 's' : ''} auto-applied, and ${withheldCount} flagged but NOT applied (marked "NOT APPLIED"/"POSSIBLE DROP" below) because a possible employee drop was detected in the same fetch — those need a manual look before anything changes.`
      : `Daily tips reconciliation found ${corrections.length} correction${corrections.length !== 1 ? 's' : ''} across the last ${dates.length} day${dates.length !== 1 ? 's' : ''} — employees whose Paycor punches were entered/corrected after their day's report already ran. All were auto-corrected in the Portal; no action needed unless something here looks wrong.`;
    const html = `
      <p>${summaryLine}</p>
      <table style="border-collapse:collapse;width:100%;margin-top:10px;font-size:13px;">
        <tr style="background:#f5f5f5;"><th style="padding:4px 10px;text-align:left;">Date</th><th style="padding:4px 10px;text-align:left;">Store</th><th style="padding:4px 10px;text-align:left;">Employee</th><th style="padding:4px 10px;text-align:left;">Change</th></tr>
        ${rows}
      </table>
      ${skippedForBudget ? '<p style="color:#e03131;">Note: hit the time budget partway through — some stores/days may not have been checked this run.</p>' : ''}
    `;
    try { await sendEmail(['ahmed@peoplecapitalgroup.com'], `Tips Reconciliation — ${corrections.length} correction${corrections.length !== 1 ? 's' : ''} auto-fixed`, html); }
    catch (err) { console.error('[tips-reconcile] email error:', err.message); }
  }

  const summary = { ok: true, daysChecked: dates.length, storesChecked: targetStores.length, corrections: corrections.length, details: corrections, skippedForBudget };
  console.log('[tips-reconcile] done:', JSON.stringify({ ...summary, details: undefined }));
  return summary;
}

export async function runReconcile(daysBack = 3, onlyPc = null) {
  const dates = [];
  for (let i = 1; i <= daysBack; i++) dates.push(etDate(i));
  return runReconcileForDates(dates, onlyPc);
}

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    const summary = await runReconcile(3);
    return new Response(JSON.stringify(summary), { status: 200, headers });
  } catch (err) {
    console.error('[tips-reconcile] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
