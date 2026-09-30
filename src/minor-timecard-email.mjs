// src/minor-timecard-email.mjs — pure HTML builders for the weekly minor-
// timecard-compliance emails. No network calls here; netlify/functions/
// minor-timecard-detect-cron-background.mjs and -followup-cron.mjs call these
// to get a string, then send it themselves via Resend.
import { analyzeDayForViolation } from './minor-timecard-detect.mjs';

// Escape HTML special characters to prevent XSS when interpolating untrusted
// data (e.g. employee names, store names) into HTML templates.
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function fmtTime(isoLocal) {
  // Paycor punch timestamps are ET wall-clock with no timezone suffix
  // (e.g. "2026-09-19T06:00:00") — format directly, no timezone conversion.
  const [, h, m] = /T(\d{2}):(\d{2})/.exec(isoLocal) || [];
  if (h == null) return '--';
  let hour = Number(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12; if (hour === 0) hour = 12;
  return `${hour}:${m} ${ampm}`;
}

const punchTime = (p) => p.punchDateTime || p.punchIn || p.timeIn || null;

export function buildEmailSubject(storeName, escalated, dayN) {
  return escalated
    ? `⚠ Minor Timecard Still Open — ${storeName} (Day ${dayN})`
    : `⚠ Minor Timecard Review Needed — ${storeName}`;
}

// `dayPunches` is either an array of punches or null/undefined, and the two
// mean very different things: [] is "Paycor answered, this day has no punches",
// null is "we could not read Paycor this run". Rendering the second as the
// first put a fabricated "No break recorded during shift" in front of a
// manager on every outage — the same wrong failure mode already fixed on the
// Admin UI side, which must never show an all-clear for a failed load.
export function buildViolationCardHtml(issue, dayPunches) {
  const punchesUnavailable = dayPunches == null;
  // Mirror analyzeDayForViolation's own filter: a punch with a missing or
  // unparseable timestamp is dropped, never silently rendered as a 1970 epoch
  // clock time in a compliance email.
  const sorted = (punchesUnavailable ? [] : [...dayPunches])
    .filter(p => p && punchTime(p) != null && !isNaN(new Date(punchTime(p))))
    .sort((a, b) => new Date(punchTime(a)) - new Date(punchTime(b)));
  const clockIn = sorted[0] ? fmtTime(punchTime(sorted[0])) : '--';
  const clockOut = sorted[sorted.length - 1] ? fmtTime(punchTime(sorted[sorted.length - 1])) : '--';

  // The break figure MUST come from the same gap analysis that decided the
  // violation. `issue.longestGapMinutes` is written at detection time from
  // analyzeDayForViolation's `violationGapMinutes` — the longest gap INSIDE
  // the stretch that actually violated. Re-deriving a number here by scanning
  // every gap in the day produced a different answer on split shifts (a real
  // 30-minute break early in the day, then a second, unbroken 5.5h stretch:
  // the tile showed a green "compliant" 30 min next to text describing a real
  // violation). The fallback below re-uses the very same function rather than
  // a second, hand-rolled scan, so older issue records without the stored
  // field still can't disagree with it.
  const gapMinutes = punchesUnavailable
    ? null
    : (typeof issue.longestGapMinutes === 'number'
        ? issue.longestGapMinutes
        : (analyzeDayForViolation(sorted).violationGapMinutes ?? 0));

  const breakLine = gapMinutes >= 30
    ? `Break taken: ${Math.round(gapMinutes)} min`
    : gapMinutes > 0
      ? `Break attempt: ${Math.round(gapMinutes)} min (below the 30-minute requirement)`
      : 'No break recorded during shift';
  const timelineLine = punchesUnavailable
    ? 'Punch data unavailable this run — please check Paycor directly'
    : `Clocked in ${clockIn} · ${breakLine} · Clocked out ${clockOut}`;

  // Label and colour track which of those three cases it is — the tile used to
  // always read "Break Taken" and lean on colour alone to say otherwise.
  const breakTileLabel = punchesUnavailable ? 'Break (Unknown)' : gapMinutes >= 30 ? 'Break Taken' : gapMinutes > 0 ? 'Break Attempt' : 'No Break';
  const breakTileValue = punchesUnavailable ? '—' : `${Math.round(gapMinutes)} min`;
  const breakTileColor = punchesUnavailable ? '#a0a0a0' : gapMinutes >= 30 ? '#4ade80' : '#f87171';
  const hoursLabel = typeof issue.consecutiveHours === 'number' ? `${issue.consecutiveHours.toFixed(1)}h` : '--';

  const dateLabel = new Date(issue.violationDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  return `
<div style="background:#1c1c1c;border:1px solid #2a2a2a;border-left:3px solid #f59e0b;border-radius:0.65rem;padding:16px 18px;margin-bottom:14px;">
  <div style="font-weight:700;color:#e8e8e8;font-size:0.92rem;font-family:'Raleway',sans-serif;">${escapeHtml(issue.employeeName)}</div>
  <div style="color:#8a8a8a;font-size:0.78rem;margin-top:1px;">${dateLabel}</div>
  <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2a2a2a;font-size:0.82rem;color:#d0d0d0;">
    ${timelineLine}
  </div>
  <div style="display:flex;gap:0;margin-top:12px;background:#161616;border-radius:0.5rem;overflow:hidden;">
    <div style="flex:1;text-align:center;padding:9px 6px;border-right:1px solid #262626;">
      <div style="font-weight:800;font-size:0.95rem;color:#f0f0f0;">${hoursLabel}</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">Worked</div>
    </div>
    <div style="flex:1;text-align:center;padding:9px 6px;border-right:1px solid #262626;">
      <div style="font-weight:800;font-size:0.95rem;color:#f0f0f0;">5.0h</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">PA Limit</div>
    </div>
    <div style="flex:1;text-align:center;padding:9px 6px;">
      <div style="font-weight:800;font-size:0.95rem;color:${breakTileColor};">${breakTileValue}</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">${breakTileLabel}</div>
    </div>
  </div>
</div>`;
}

export function buildDigestEmailHtml(storeName, issuesWithPunches) {
  const cards = issuesWithPunches.map(({ issue, dayPunches }) => buildViolationCardHtml(issue, dayPunches)).join('\n');
  return `
<!DOCTYPE html><html><body style="background:#0f0f0f;color:#e8e8e8;font-family:'Source Sans 3',Arial,sans-serif;padding:26px;margin:0;">
  <div style="max-width:520px;margin:0 auto;">
    <div style="font-family:'Raleway',sans-serif;font-weight:800;font-size:1.15rem;color:#f0f0f0;margin-bottom:4px;">${escapeHtml(storeName)} — ${issuesWithPunches.length} timecard${issuesWithPunches.length !== 1 ? 's' : ''} need${issuesWithPunches.length === 1 ? 's' : ''} a look</div>
    <div style="color:#8a8a8a;font-size:0.85rem;margin-bottom:20px;">Pennsylvania requires a 30-minute break after 5 consecutive hours for employees under 18. Please review and correct the timecard(s) below in Paycor.</div>
    ${cards}
    <a href="https://apps.paycor.com" style="display:inline-block;background:#FF671F;color:#fff;text-decoration:none;padding:11px 22px;border-radius:0.55rem;font-weight:700;font-size:0.85rem;margin-top:6px;">Open Paycor</a>
    <div style="color:#5a5a5a;font-size:0.7rem;margin-top:22px;line-height:1.5;">Automated message from PCG Operations Portal — not a substitute for confirming PA minor labor rules with HR/legal.</div>
  </div>
</body></html>`;
}
