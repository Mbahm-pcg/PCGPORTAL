// src/minor-timecard-lifecycle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIssueId, buildIssueRecord, mondayAfter, shouldEscalateToday,
  execBackstopDue, resolveNotificationRecipients, filterIssuesForRole, applyResolutionCheck,
} from './minor-timecard-lifecycle.mjs';

test('buildIssueId is stable and unique per store/employee/day', () => {
  assert.equal(buildIssueId('340538', 'emp-1', '2026-09-19'), buildIssueId('340538', 'emp-1', '2026-09-19'));
  assert.notEqual(buildIssueId('340538', 'emp-1', '2026-09-19'), buildIssueId('340538', 'emp-2', '2026-09-19'));
});

test('buildIssueRecord matches the spec schema with status open and empty escalation/resolution fields', () => {
  const now = new Date('2026-09-21T10:04:00Z');
  const issue = buildIssueRecord({ pc: '340538', storeName: 'Easton', district: 5, employeeId: 'emp-1', employeeName: 'Brajbala Mehta', weekStart: '2026-09-13', weekEnd: '2026-09-19', violationDate: '2026-09-19', consecutiveHours: 5.4, now });
  assert.equal(issue.status, 'open');
  assert.equal(issue.escalatedAt, null);
  assert.equal(issue.resolvedAt, null);
  assert.equal(issue.resolvedVia, null);
  assert.deepEqual(issue.notifications, []);
  assert.equal(issue.firstFlaggedAt, now.toISOString());
  assert.equal(issue.id, buildIssueId('340538', 'emp-1', '2026-09-19'));
});

test('mondayAfter: the Monday strictly after the week-ending Saturday', () => {
  assert.equal(mondayAfter('2026-09-19'), '2026-09-21'); // Sat 9/19 -> Mon 9/21
  assert.equal(mondayAfter('2026-09-26'), '2026-09-28');
});

test('shouldEscalateToday: false on the Sunday it was flagged, true from Monday onward', () => {
  const issue = { status: 'open', escalatedAt: null, weekEnd: '2026-09-19' };
  assert.equal(shouldEscalateToday(issue, '2026-09-20'), false); // still Sunday
  assert.equal(shouldEscalateToday(issue, '2026-09-21'), true);  // Monday
  assert.equal(shouldEscalateToday(issue, '2026-09-25'), true);  // later, still not escalated
});

test('shouldEscalateToday: false once already escalated or resolved', () => {
  assert.equal(shouldEscalateToday({ status: 'open', escalatedAt: '2026-09-21T10:00:00Z', weekEnd: '2026-09-19' }, '2026-09-22'), false);
  assert.equal(shouldEscalateToday({ status: 'resolved', escalatedAt: null, weekEnd: '2026-09-19' }, '2026-09-22'), false);
});

test('execBackstopDue: fires once, exactly 7+ days after escalation, only if not already sent', () => {
  const issue = { status: 'open', escalatedAt: '2026-09-21T10:00:00Z', notifications: [] };
  assert.equal(execBackstopDue(issue, '2026-09-27'), false); // day 6
  assert.equal(execBackstopDue(issue, '2026-09-28'), true);  // day 7
  const alreadySent = { ...issue, notifications: [{ recipientRole: 'exec_backstop', recipientEmail: 'x@y.com', sentAt: '2026-09-28T10:00:00Z', success: true, error: null }] };
  assert.equal(execBackstopDue(alreadySent, '2026-09-29'), false);
});

test('resolveNotificationRecipients: manager only before escalation', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: null };
  const users = [
    { userType: 'manager', storePC: '340538', district: 5, email: 'mgr@x.com', active: true },
    { userType: 'dm', storePC: null, district: 5, email: 'dm@x.com', active: true },
    { userType: 'office_staff', email: 'office1@x.com', active: true },
  ];
  const recipients = resolveNotificationRecipients(issue, users);
  assert.deepEqual(recipients, [{ role: 'manager', email: 'mgr@x.com' }]);
});

// Added 2026-10-02 — the Rosemore/Hatboro gap: no manager user record with
// this store's PC set meant zero recipients at all before escalation. Now
// falls back to the DM immediately instead of notifying nobody.
test('resolveNotificationRecipients: no manager on file falls back to DM immediately, even before escalation', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: null };
  const users = [
    { userType: 'dm', storePC: null, district: 5, email: 'dm@x.com', active: true },
    { userType: 'office_staff', email: 'office1@x.com', active: true },
  ];
  const recipients = resolveNotificationRecipients(issue, users);
  assert.deepEqual(recipients, [{ role: 'dm', email: 'dm@x.com' }]);
});

test('resolveNotificationRecipients: no manager AND no DM on file is genuinely zero recipients', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: null };
  const users = [{ userType: 'office_staff', email: 'office1@x.com', active: true }];
  assert.deepEqual(resolveNotificationRecipients(issue, users), []);
});

// Replaced "all active office_staff" with the manually-curated notify list
// (ManualNotifyListPanel / pcg_minor_timecard_notify_v1) — specific addresses
// IT explicitly added, not every office_staff account.
test('resolveNotificationRecipients: manager + DM + the curated notify list once escalated', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: '2026-09-21T10:00:00Z' };
  const users = [
    { userType: 'manager', storePC: '340538', district: 5, email: 'mgr@x.com', active: true },
    { userType: 'dm', storePC: null, district: 5, email: 'dm@x.com', active: true },
    { userType: 'office_staff', email: 'office1@x.com', active: true }, // NOT on the curated list — excluded
  ];
  const notifyEmails = ['maria@x.com', 'ella@x.com'];
  const recipients = resolveNotificationRecipients(issue, users, notifyEmails);
  assert.deepEqual(recipients, [
    { role: 'manager', email: 'mgr@x.com' },
    { role: 'dm', email: 'dm@x.com' },
    { role: 'minor_timecard_notify', email: 'maria@x.com' },
    { role: 'minor_timecard_notify', email: 'ella@x.com' },
  ]);
});

// Confirmed real (2026-10-06): the curated list has no store/district
// scoping at all — a manager or DM account added to it (by mistake, or on
// purpose wanting broader visibility) got paged for every escalation
// network-wide, not just their own store/district. Per explicit direction
// ("DM will get the alert for the stores they are looking after... there
// shouldn't be any reason why its going to every DM or manager"), this is
// now hard-excluded rather than left to list hygiene — a manager/DM account
// in notifyEmails is silently dropped, even though they'll still correctly
// receive their own store/district's issues via the normal manager/dm path.
test('resolveNotificationRecipients: a manager or DM account in the curated list is excluded — they still get their OWN store/district, never every store', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: '2026-09-21T10:00:00Z' };
  const users = [
    { userType: 'manager', storePC: '340538', district: 5, email: 'mgr@x.com', active: true },
    { userType: 'dm', storePC: null, district: 5, email: 'dm@x.com', active: true },
    // A DIFFERENT district's DM, manually added to the curated list — must
    // NOT receive this district-5 issue just because they're on the list.
    { userType: 'dm', storePC: null, district: 9, email: 'other-dm@x.com', active: true },
    { userType: 'office_staff', email: 'office1@x.com', active: true },
  ];
  const notifyEmails = ['other-dm@x.com', 'office1@x.com'];
  const recipients = resolveNotificationRecipients(issue, users, notifyEmails);
  assert.deepEqual(recipients, [
    { role: 'manager', email: 'mgr@x.com' },
    { role: 'dm', email: 'dm@x.com' },
    { role: 'minor_timecard_notify', email: 'office1@x.com' },
  ]);
});

test('resolveNotificationRecipients: no-manager DM fallback + escalation never double-lists the DM', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: '2026-09-21T10:00:00Z' };
  const users = [{ userType: 'dm', storePC: null, district: 5, email: 'dm@x.com', active: true }];
  const recipients = resolveNotificationRecipients(issue, users, ['maria@x.com']);
  assert.deepEqual(recipients, [
    { role: 'dm', email: 'dm@x.com' },
    { role: 'minor_timecard_notify', email: 'maria@x.com' },
  ]);
});

test('filterIssuesForRole: exec/it/office_staff see everything, dm sees their district, manager sees their store, anyone else sees nothing', () => {
  const issues = [
    { pc: '340538', district: 5 },
    { pc: '342144', district: 6 },
  ];
  assert.equal(filterIssuesForRole(issues, { userType: 'executive' }).length, 2);
  assert.equal(filterIssuesForRole(issues, { userType: 'it' }).length, 2);
  assert.equal(filterIssuesForRole(issues, { userType: 'office_staff' }).length, 2);
  assert.deepEqual(filterIssuesForRole(issues, { userType: 'dm', district: 5 }), [issues[0]]);
  assert.deepEqual(filterIssuesForRole(issues, { userType: 'manager', storePC: '342144' }), [issues[1]]);
  assert.deepEqual(filterIssuesForRole(issues, { userType: 'construction' }), []);
});

test('applyResolutionCheck: resolves when the fresh check comes back clean', () => {
  const issue = { status: 'open' };
  const now = new Date('2026-09-22T10:00:00Z');
  const result = applyResolutionCheck(issue, { status: 'ok', violates: false }, now);
  assert.equal(result.status, 'resolved');
  assert.equal(result.resolvedVia, 'auto');
  assert.equal(result.resolvedAt, now.toISOString());
});

test('applyResolutionCheck: leaves the issue open when still violating', () => {
  const issue = { status: 'open' };
  const result = applyResolutionCheck(issue, { status: 'ok', violates: true }, new Date());
  assert.equal(result.status, 'open');
});

test('applyResolutionCheck: refreshes consecutiveHours/longestGapMinutes from fresh live data when still violating', () => {
  // Confirmed real (2026-10-05): an issue first detected with a 5.0h stretch
  // stayed open (correctly — the real shift later had zero break at all),
  // but kept showing the stale original "5.0h Worked" forever because this
  // function never updated those fields on anything but the resolve path.
  const issue = { status: 'open', consecutiveHours: 5.0, longestGapMinutes: 0 };
  const result = applyResolutionCheck(issue, { status: 'ok', violates: true, consecutiveHours: 9.47, violationGapMinutes: 0 }, new Date());
  assert.equal(result.status, 'open');
  assert.equal(result.consecutiveHours, 9.47);
  assert.equal(result.longestGapMinutes, 0);
});

test('applyResolutionCheck: leaves the issue unchanged (never auto-resolves, never overwrites numbers) on indeterminate data', () => {
  const issue = { status: 'open', consecutiveHours: 5.4, longestGapMinutes: 10 };
  const result = applyResolutionCheck(issue, { status: 'indeterminate', violates: false, consecutiveHours: null }, new Date());
  assert.deepEqual(result, issue);
});
