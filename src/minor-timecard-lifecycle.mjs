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

// `notifyEmails` is the manually-curated "Minor Timecard" list (Admin ·
// Notifications tab, ManualNotifyListPanel / pcg_minor_timecard_notify_v1) —
// specific addresses IT explicitly added, not every office_staff account.
// Replaces the old blanket "every active office_staff user" query (2026-10-02,
// per explicit direction: pick exactly who is and isn't on it, the same
// add/remove pattern Project/Ticket/Food License/System Health already use).
export function resolveNotificationRecipients(issue, users, notifyEmails = []) {
  const list = users || [];
  const out = [];
  const seen = new Set();
  const push = (role, email) => {
    const key = email.toLowerCase();
    if (seen.has(key)) return; // de-dupe: DM can land here via both the no-manager fallback and the escalation add
    seen.add(key);
    out.push({ role, email });
  };
  const manager = list.find(u => u.active !== false && u.userType === 'manager' && String(u.storePC) === String(issue.pc) && u.email);
  const dm = list.find(u => u.active !== false && u.userType === 'dm' && String(u.district) === String(issue.district) && u.email);
  if (manager) {
    push('manager', manager.email);
  } else if (dm) {
    // No manager account/email on file for this store at all — email the DM
    // immediately (day of detection), rather than silently notifying nobody
    // until the Monday escalation. This was the exact Rosemore/Hatboro gap:
    // a store with no manager user record previously got zero emails for
    // days until the next Monday's formal escalation added the DM.
    push('dm', dm.email);
  }
  if (issue.escalatedAt) {
    // Ensure the DM is included once formally escalated even when a manager
    // WAS found above (so the no-manager branch never fired) — de-duped by
    // `push` if the fallback already added them.
    if (dm) push('dm', dm.email);
    (notifyEmails || []).forEach((email) => { if (email) push('minor_timecard_notify', email); });
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
