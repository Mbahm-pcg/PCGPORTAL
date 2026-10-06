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
    // Confirmed real (2026-10-06): the curated list doesn't filter by store/
    // district at all, so any manager or DM account someone adds to it here
    // — by mistake (the original 43-manager bulk-add) or on purpose (4 real
    // DMs were manually added, wanting broader visibility) — ends up getting
    // paged for EVERY store/district network-wide, not just their own. Per
    // explicit direction: a DM only ever sees their own stores, a manager
    // only ever their own store, with NO code path that can widen that,
    // rather than relying on whoever edits this list to never add one by
    // hand again. Hard-excluded here at the source, not just by convention.
    const managerOrDmEmails = new Set(
      list.filter(u => u.active !== false && (u.userType === 'manager' || u.userType === 'dm') && u.email)
        .map(u => u.email.toLowerCase())
    );
    (notifyEmails || []).forEach((email) => {
      if (email && !managerOrDmEmails.has(email.toLowerCase())) push('minor_timecard_notify', email);
    });
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
  // Still open — but confirmed real (2026-10-05, Jessup Charlotte/Sunday 9/27):
  // this used to return `issue` completely unchanged on every single day it
  // stays open, which means `consecutiveHours`/`longestGapMinutes` were
  // frozen at whatever they were the moment the issue was FIRST detected,
  // forever — even though `buildViolationCardHtml` re-derives the clock-in/
  // clock-out/break text fresh from live punches every time it renders. A
  // card could show a truthful "no break recorded, clocked in 8:55 AM,
  // clocked out 6:23 PM" (today's real punches) right next to a stale
  // "5.0h Worked" left over from whichever earlier day the violation was
  // first caught — looking exactly like the fixed exactly-5.0-hours bug had
  // regressed, when the real bug was that the number simply never updates.
  // `freshDayResult` is the exact same live analyzeDayForViolation() result
  // that just reconfirmed this is still a violation, so reuse it here too
  // rather than re-deriving a second time. Guarded on `status === 'ok'`
  // (not just `typeof consecutiveHours === 'number'`) so an indeterminate
  // run (Paycor unreadable this pass) can never overwrite a good stored
  // number with a coincidentally-numeric but meaningless value.
  if (freshDayResult.status === 'ok' && typeof freshDayResult.consecutiveHours === 'number') {
    return { ...issue, consecutiveHours: freshDayResult.consecutiveHours, longestGapMinutes: freshDayResult.violationGapMinutes ?? issue.longestGapMinutes };
  }
  return issue;
}
