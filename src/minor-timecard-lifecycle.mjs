// src/minor-timecard-lifecycle.mjs — pure issue lifecycle: creation, escalation
// timing, notification-recipient resolution, role-based visibility, and
// resolution checking. No network, no blobs. See the spec (docs/superpowers/
// specs/2026-09-29-minor-timecard-compliance-design.md) for the schema and
// the escalation timeline this implements.
const EXEC_BACKSTOP_DAYS = 7;

export function buildIssueId(pc, employeeId, violationDate) {
  return `${pc}_${employeeId}_${violationDate}`;
}

// `longestGapMinutes` here is analyzeDayForViolation's `violationGapMinutes`:
// the longest gap INSIDE the stretch that actually violated (0 if there was
// none), not the day's longest gap. Stored on the issue so every email/UI
// rendering of "did they get a break" reports the same figure the violation
// was decided on, instead of re-deriving a second one from raw punches later.
export function buildIssueRecord({ pc, storeName, district, employeeId, employeeName, weekStart, weekEnd, violationDate, consecutiveHours, longestGapMinutes = null, now = new Date() }) {
  return {
    id: buildIssueId(pc, employeeId, violationDate),
    pc, storeName, district, employeeId, employeeName,
    weekStart, weekEnd, violationDate, consecutiveHours, longestGapMinutes,
    status: 'open',
    firstFlaggedAt: now.toISOString(),
    escalatedAt: null,
    resolvedAt: null,
    resolvedVia: null,
    resolvedBy: null,
    notifications: [],
  };
}

function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toISODate(d) { return d.toISOString().slice(0, 10); }
function addDays(dateStr, days) { return toISODate(new Date(parseDateOnly(dateStr).getTime() + days * 86400000)); }

// weekEnd is always a Saturday (see minor-timecard-detect.mjs's weekRangeEndingYesterday)
// -> the following Monday is always exactly 2 days later.
export function mondayAfter(weekEndDateStr) {
  return addDays(weekEndDateStr, 2);
}

export function shouldEscalateToday(issue, todayDateStr) {
  if (issue.status !== 'open' || issue.escalatedAt != null) return false;
  return todayDateStr >= mondayAfter(issue.weekEnd);
}

export function execBackstopDue(issue, todayDateStr) {
  if (issue.status !== 'open' || issue.escalatedAt == null) return false;
  const alreadySent = (issue.notifications || []).some(n => n.recipientRole === 'exec_backstop');
  if (alreadySent) return false;
  const escalatedDateStr = issue.escalatedAt.slice(0, 10);
  return todayDateStr >= addDays(escalatedDateStr, EXEC_BACKSTOP_DAYS);
}

export function resolveNotificationRecipients(issue, users) {
  const list = users || [];
  const out = [];
  const manager = list.find(u => u.active !== false && u.userType === 'manager' && String(u.storePC) === String(issue.pc) && u.email);
  if (manager) out.push({ role: 'manager', email: manager.email });
  if (issue.escalatedAt) {
    const dm = list.find(u => u.active !== false && u.userType === 'dm' && String(u.district) === String(issue.district) && u.email);
    if (dm) out.push({ role: 'dm', email: dm.email });
    list.filter(u => u.active !== false && u.userType === 'office_staff' && u.email)
      .forEach(u => out.push({ role: 'office_staff', email: u.email }));
  }
  return out;
}

export function filterIssuesForRole(issues, user) {
  const ut = user?.userType;
  if (ut === 'executive' || ut === 'it' || ut === 'office_staff') return issues;
  if (ut === 'dm') return issues.filter(i => String(i.district) === String(user.district));
  if (ut === 'manager') return issues.filter(i => String(i.pc) === String(user.storePC));
  return [];
}

export function applyResolutionCheck(issue, freshDayResult, now = new Date()) {
  if (freshDayResult.status === 'ok' && !freshDayResult.violates) {
    return { ...issue, status: 'resolved', resolvedAt: now.toISOString(), resolvedVia: 'auto' };
  }
  return issue;
}
