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

test('buildViolationCardHtml: escapes HTML special characters in employee name', () => {
  const issue = { employeeName: 'Anne & <script>alert(1)</script>', violationDate: '2026-09-19', consecutiveHours: 5.4 };
  const dayPunches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
  ];
  const html = buildViolationCardHtml(issue, dayPunches);
  // Should contain escaped version, not the raw script tag
  assert.match(html, /Anne &amp; &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('buildViolationCardHtml: null punches read as "unavailable", never as a confirmed "no break"', () => {
  const issue = { employeeName: 'Test Person', violationDate: '2026-09-19', consecutiveHours: 5.4 };
  const html = buildViolationCardHtml(issue, null);
  assert.match(html, /Punch data unavailable this run/i);
  assert.doesNotMatch(html, /No break recorded/i);
  assert.doesNotMatch(html, /Break taken/i);
  // Neutral, not the green "compliant" colour and not a fabricated 0 min.
  assert.doesNotMatch(html, /#4ade80/);
  assert.match(html, /Break \(Unknown\)/);
});

test('buildViolationCardHtml: an empty punch array still reads as a confirmed "no break", distinct from unavailable', () => {
  const issue = { employeeName: 'Test Person', violationDate: '2026-09-19', consecutiveHours: 5.4, longestGapMinutes: 0 };
  const html = buildViolationCardHtml(issue, []);
  assert.match(html, /No break recorded/i);
  assert.doesNotMatch(html, /unavailable/i);
});

test('buildViolationCardHtml: an earlier qualifying break does not make a later unbroken violation look compliant', () => {
  // Split shift: a real 30-minute break at 08:00-08:30, then an unbroken 5.5h
  // stretch that is the actual violation. The day's longest gap is 30 min;
  // the violating stretch had no break at all. The tile must show the latter.
  const issue = { employeeName: 'Split Shift', violationDate: '2026-09-19', consecutiveHours: 5.5, longestGapMinutes: 0 };
  const dayPunches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T08:00:00' },
    { punchDateTime: '2026-09-19T08:30:00' },
    { punchDateTime: '2026-09-19T14:00:00' },
  ];
  const html = buildViolationCardHtml(issue, dayPunches);
  assert.match(html, /No break recorded/i);
  assert.doesNotMatch(html, /Break taken: 30 min/i);
  assert.doesNotMatch(html, /#4ade80/);            // no green "compliant" tile on a violation notice
  assert.match(html, /No Break<\/div>/);           // tile label, not the old always-"Break Taken"
});

test('buildViolationCardHtml: with no stored gap, the fallback still uses the violation-stretch analysis, not a day-wide scan', () => {
  // Same split shift, but an issue record from before longestGapMinutes was
  // stored — the fallback must reach the same answer, not the old 30 min.
  const issue = { employeeName: 'Legacy Record', violationDate: '2026-09-19', consecutiveHours: 5.5 };
  const dayPunches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T08:00:00' },
    { punchDateTime: '2026-09-19T08:30:00' },
    { punchDateTime: '2026-09-19T14:00:00' },
  ];
  const html = buildViolationCardHtml(issue, dayPunches);
  assert.match(html, /No break recorded/i);
  assert.doesNotMatch(html, /30 min/);
});

test('buildViolationCardHtml: a sub-30-minute gap is labelled "Break Attempt", not "Break Taken"', () => {
  const issue = { employeeName: 'Test Person', violationDate: '2026-09-19', consecutiveHours: 6.5, longestGapMinutes: 10 };
  const html = buildViolationCardHtml(issue, [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T09:00:00' },
    { punchDateTime: '2026-09-19T09:10:00' },
    { punchDateTime: '2026-09-19T12:30:00' },
  ]);
  assert.match(html, /Break Attempt<\/div>/);
  assert.doesNotMatch(html, /Break Taken<\/div>/);
});

test('buildViolationCardHtml: a qualifying 30+ minute gap still renders the green "Break Taken" tile', () => {
  const issue = { employeeName: 'Test Person', violationDate: '2026-09-19', consecutiveHours: 5.2, longestGapMinutes: 35 };
  const html = buildViolationCardHtml(issue, [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:12:00' },
  ]);
  assert.match(html, /Break taken: 35 min/);
  assert.match(html, /Break Taken<\/div>/);
  assert.match(html, /#4ade80/);
});

test('buildViolationCardHtml: a punch with a missing/invalid timestamp is dropped, never rendered as a 1970 time', () => {
  const issue = { employeeName: 'Bad Punch', violationDate: '2026-09-19', consecutiveHours: 5.4, longestGapMinutes: 0 };
  const html = buildViolationCardHtml(issue, [
    { punchDateTime: null },
    { punchDateTime: 'not-a-date' },
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
  ]);
  assert.match(html, /Clocked in 6:00 AM/);
  assert.match(html, /Clocked out 11:24 AM/);
  assert.doesNotMatch(html, /1969|1970/);
});

test('buildDigestEmailHtml: escapes HTML special characters in store name', () => {
  const issues = [
    { issue: { employeeName: 'Person A', violationDate: '2026-09-19', consecutiveHours: 5.4 }, dayPunches: [{ punchDateTime: '2026-09-19T06:00:00' }, { punchDateTime: '2026-09-19T11:24:00' }] },
  ];
  const html = buildDigestEmailHtml('Store & <img onerror=alert(1)>', issues);
  // Should contain escaped version, not the raw script
  assert.match(html, /Store &amp; &lt;img onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img onerror=/);
});
