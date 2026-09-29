import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmailSubject, buildViolationCardHtml, buildDigestEmailHtml } from './minor-timecard-email.mjs';

test('buildEmailSubject: calm framing before escalation', () => {
  assert.equal(buildEmailSubject('Easton', false, null), '⚠ Minor Timecard Review Needed — Easton');
});

test('buildEmailSubject: escalated framing includes the day count', () => {
  assert.equal(buildEmailSubject('Westchester', true, 3), '⚠ Minor Timecard Still Open — Westchester (Day 3)');
});

test('buildViolationCardHtml: includes employee name, date, hours, and a clean-break timeline', () => {
  const issue = { employeeName: 'Brajbala Mehta', violationDate: '2026-09-19', consecutiveHours: 5.4 };
  const dayPunches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
  ];
  const html = buildViolationCardHtml(issue, dayPunches);
  assert.match(html, /Brajbala Mehta/);
  assert.match(html, /5\.4/);
  assert.match(html, /No break recorded/i);
  assert.match(html, /6:00 AM/);
  assert.match(html, /11:24 AM/);
});

test('buildViolationCardHtml: a sub-qualifying break shows its actual length, not "no break"', () => {
  const issue = { employeeName: 'Test Person', violationDate: '2026-09-19', consecutiveHours: 6.5 };
  const dayPunches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T09:00:00' },
    { punchDateTime: '2026-09-19T09:10:00' },
    { punchDateTime: '2026-09-19T12:30:00' },
  ];
  const html = buildViolationCardHtml(issue, dayPunches);
  assert.match(html, /10 min/);
  assert.doesNotMatch(html, /No break recorded/i);
});

test('buildDigestEmailHtml: bundles multiple issues for the same store into one email with multiple cards', () => {
  const issues = [
    { issue: { employeeName: 'Person A', violationDate: '2026-09-19', consecutiveHours: 5.4 }, dayPunches: [{ punchDateTime: '2026-09-19T06:00:00' }, { punchDateTime: '2026-09-19T11:24:00' }] },
    { issue: { employeeName: 'Person B', violationDate: '2026-09-20', consecutiveHours: 6.0 }, dayPunches: [{ punchDateTime: '2026-09-20T07:00:00' }, { punchDateTime: '2026-09-20T13:00:00' }] },
  ];
  const html = buildDigestEmailHtml('Easton', issues);
  assert.match(html, /Person A/);
  assert.match(html, /Person B/);
  assert.match(html, /30-minute break/i);
  assert.match(html, /not a substitute for confirming/i);
});
