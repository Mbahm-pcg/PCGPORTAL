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
import { STORES, fetchStoreCrew, saveDaySnapshot, getBlobStore, etDate } from './tips-report-cron-background.mjs';

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

// Shared by the daily cron (short lookback) and the manual refresh sibling
// (longer on-demand trace-back). `daysBack` = how many already-closed days
// to re-check, counting back from yesterday-ET. `onlyPc` optionally scopes
// to a single store (used by the manual tool).
export async function runReconcile(daysBack = 3, onlyPc = null) {
  const dates = [];
  for (let i = 1; i <= daysBack; i++) dates.push(etDate(i));
  const targetStores = onlyPc ? STORES.filter(s => String(s.pc) === String(onlyPc)) : STORES;

  const corrections = [];
  const invocationStart = Date.now();
  const BUDGET_MS = 12 * 60 * 1000;
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
      const savedByKey = {};
      (saved.crew || []).forEach(c => { savedByKey[c.payrollId || c.name] = c; });
      let mismatch = false;
      for (const lc of liveCrew) {
        const key = lc.payrollId || lc.name;
        const prev = savedByKey[key];
        if (!prev) {
          corrections.push({ store: s.name, pc: s.pc, busDt, employee: lc.name, change: `added — ${lc.hours.toFixed(2)}h (was missing entirely)` });
          mismatch = true;
        } else if (Math.abs(prev.hours - lc.hours) > 0.5) {
          corrections.push({ store: s.name, pc: s.pc, busDt, employee: lc.name, change: `${prev.hours.toFixed(2)}h → ${lc.hours.toFixed(2)}h` });
          mismatch = true;
        }
      }
      if (!mismatch) continue;

      // Rebuild just this store's entry for this day — same tip pool/rows
      // already captured (Pulse data doesn't need refetching), only the crew
      // array changes.
      const nextEntry = { ...saved, crew: liveCrew, crewStatus: 'ok' };
      const nextArr = idx >= 0 ? snapArr.map((x, i) => i === idx ? nextEntry : x) : [...snapArr, nextEntry];
      await saveDaySnapshot(busDt, nextArr);
      snapArr[idx] = nextEntry; // keep in-memory copy in sync in case the same store/day is touched again this run
    }
  }

  if (corrections.length > 0) {
    const rows = corrections.map(c => `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee;">${escapeHtml(c.busDt)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;">${escapeHtml(c.store)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;">${escapeHtml(c.employee)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;">${escapeHtml(c.change)}</td></tr>`).join('');
    const html = `
      <p>Daily tips reconciliation found ${corrections.length} correction${corrections.length !== 1 ? 's' : ''} across the last ${daysBack} day${daysBack !== 1 ? 's' : ''} — employees whose Paycor punches were entered/corrected after their day's report already ran. All were auto-corrected in the Portal; no action needed unless something here looks wrong.</p>
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
