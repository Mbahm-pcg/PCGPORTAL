// src/minor-timecard-email.mjs — pure HTML builders for the weekly minor-
// timecard-compliance emails. No network calls here; netlify/functions/
// minor-timecard-detect-cron.mjs and -followup-cron.mjs call these to get a
// string, then send it themselves via Resend.
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

export function buildViolationCardHtml(issue, dayPunches) {
  const sorted = [...(dayPunches || [])].sort((a, b) => new Date(punchTime(a)) - new Date(punchTime(b)));
  const clockIn = sorted[0] ? fmtTime(punchTime(sorted[0])) : '--';
  const clockOut = sorted[sorted.length - 1] ? fmtTime(punchTime(sorted[sorted.length - 1])) : '--';

  let longestGapMinutes = 0;
  for (let i = 1; i < sorted.length; i += 2) {
    if (!sorted[i] || !sorted[i + 1]) break;
    const gap = (new Date(punchTime(sorted[i + 1])) - new Date(punchTime(sorted[i]))) / 60000;
    if (gap > longestGapMinutes) longestGapMinutes = gap;
  }
  const breakLine = longestGapMinutes >= 30
    ? `Break taken: ${Math.round(longestGapMinutes)} min`
    : longestGapMinutes > 0
      ? `Break attempt: ${Math.round(longestGapMinutes)} min (below the 30-minute requirement)`
      : 'No break recorded during shift';

  const dateLabel = new Date(issue.violationDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

  return `
<div style="background:#1c1c1c;border:1px solid #2a2a2a;border-left:3px solid #f59e0b;border-radius:0.65rem;padding:16px 18px;margin-bottom:14px;">
  <div style="font-weight:700;color:#e8e8e8;font-size:0.92rem;font-family:'Raleway',sans-serif;">${issue.employeeName}</div>
  <div style="color:#8a8a8a;font-size:0.78rem;margin-top:1px;">${dateLabel}</div>
  <div style="margin-top:12px;padding-top:12px;border-top:1px solid #2a2a2a;font-size:0.82rem;color:#d0d0d0;">
    Clocked in ${clockIn} · ${breakLine} · Clocked out ${clockOut}
  </div>
  <div style="display:flex;gap:0;margin-top:12px;background:#161616;border-radius:0.5rem;overflow:hidden;">
    <div style="flex:1;text-align:center;padding:9px 6px;border-right:1px solid #262626;">
      <div style="font-weight:800;font-size:0.95rem;color:#f0f0f0;">${issue.consecutiveHours.toFixed(1)}h</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">Worked</div>
    </div>
    <div style="flex:1;text-align:center;padding:9px 6px;border-right:1px solid #262626;">
      <div style="font-weight:800;font-size:0.95rem;color:#f0f0f0;">5.0h</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">PA Limit</div>
    </div>
    <div style="flex:1;text-align:center;padding:9px 6px;">
      <div style="font-weight:800;font-size:0.95rem;color:${longestGapMinutes >= 30 ? '#4ade80' : '#f87171'};">${Math.round(longestGapMinutes)} min</div>
      <div style="font-size:0.62rem;color:#7a7a7a;text-transform:uppercase;">Break Taken</div>
    </div>
  </div>
</div>`;
}

export function buildDigestEmailHtml(storeName, issuesWithPunches) {
  const cards = issuesWithPunches.map(({ issue, dayPunches }) => buildViolationCardHtml(issue, dayPunches)).join('\n');
  return `
<!DOCTYPE html><html><body style="background:#0f0f0f;color:#e8e8e8;font-family:'Source Sans 3',Arial,sans-serif;padding:26px;margin:0;">
  <div style="max-width:520px;margin:0 auto;">
    <div style="font-family:'Raleway',sans-serif;font-weight:800;font-size:1.15rem;color:#f0f0f0;margin-bottom:4px;">${storeName} — ${issuesWithPunches.length} timecard${issuesWithPunches.length !== 1 ? 's' : ''} need${issuesWithPunches.length === 1 ? 's' : ''} a look</div>
    <div style="color:#8a8a8a;font-size:0.85rem;margin-bottom:20px;">Pennsylvania requires a 30-minute break after 5 consecutive hours for employees under 18. Please review and correct the timecard(s) below in Paycor.</div>
    ${cards}
    <a href="https://apps.paycor.com" style="display:inline-block;background:#FF671F;color:#fff;text-decoration:none;padding:11px 22px;border-radius:0.55rem;font-weight:700;font-size:0.85rem;margin-top:6px;">Open Paycor</a>
    <div style="color:#5a5a5a;font-size:0.7rem;margin-top:22px;line-height:1.5;">Automated message from PCG Operations Portal — not a substitute for confirming PA minor labor rules with HR/legal.</div>
  </div>
</body></html>`;
}
