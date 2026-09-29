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

test('resolveNotificationRecipients: manager + DM + all active office_staff once escalated', () => {
  const issue = { pc: '340538', district: 5, escalatedAt: '2026-09-21T10:00:00Z' };
  const users = [
    { userType: 'manager', storePC: '340538', district: 5, email: 'mgr@x.com', active: true },
    { userType: 'dm', storePC: null, district: 5, email: 'dm@x.com', active: true },
    { userType: 'office_staff', email: 'office1@x.com', active: true },
    { userType: 'office_staff', email: 'office2@x.com', active: true },
    { userType: 'office_staff', email: '', active: true }, // no email on file — excluded
    { userType: 'office_staff', email: 'inactive@x.com', active: false }, // inactive — excluded
  ];
  const recipients = resolveNotificationRecipients(issue, users);
  assert.deepEqual(recipients, [
    { role: 'manager', email: 'mgr@x.com' },
    { role: 'dm', email: 'dm@x.com' },
    { role: 'office_staff', email: 'office1@x.com' },
    { role: 'office_staff', email: 'office2@x.com' },
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

test('applyResolutionCheck: leaves the issue unchanged (never auto-resolves) on indeterminate data', () => {
  const issue = { status: 'open' };
  const result = applyResolutionCheck(issue, { status: 'indeterminate', violates: false }, new Date());
  assert.deepEqual(result, issue);
});
