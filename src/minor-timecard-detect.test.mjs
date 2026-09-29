import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageFromBirthDate, isMinor, weekRangeEndingYesterday, groupPunchesByDate, analyzeDayForViolation } from './minor-timecard-detect.mjs';

test('ageFromBirthDate: exact age before and after the birthday this year', () => {
  assert.equal(ageFromBirthDate('2010-03-15', new Date('2026-03-14T12:00:00Z')), 15);
  assert.equal(ageFromBirthDate('2010-03-15', new Date('2026-03-15T12:00:00Z')), 16);
  assert.equal(ageFromBirthDate('2010-03-15', new Date('2026-06-01T12:00:00Z')), 16);
});

test('ageFromBirthDate: null/invalid input returns null, never throws', () => {
  assert.equal(ageFromBirthDate(null), null);
  assert.equal(ageFromBirthDate('not-a-date'), null);
});

test('isMinor: true under 18, false at or above, false for null', () => {
  assert.equal(isMinor(17), true);
  assert.equal(isMinor(18), false);
  assert.equal(isMinor(25), false);
  assert.equal(isMinor(null), false);
});

test('weekRangeEndingYesterday: called Sunday morning returns the just-finished Sun-Sat week', () => {
  // Sunday 2026-09-27 "now" -> the week that just ended is Sun 9/20 - Sat 9/26
  const { weekStart, weekEnd, days } = weekRangeEndingYesterday(new Date('2026-09-27T10:00:00Z'));
  assert.equal(weekStart, '2026-09-20');
  assert.equal(weekEnd, '2026-09-26');
  assert.deepEqual(days, ['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24','2026-09-25','2026-09-26']);
});

test('groupPunchesByDate: buckets by America/New_York calendar date', () => {
  const punches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
    { punchDateTime: '2026-09-20T07:00:00' },
  ];
  const grouped = groupPunchesByDate(punches);
  assert.equal(grouped['2026-09-19'].length, 2);
  assert.equal(grouped['2026-09-20'].length, 1);
  assert.equal(grouped['2026-09-21'], undefined);
});

test('groupPunchesByDate: handles both string and Date instance punch times', () => {
  const punches = [
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: new Date('2026-09-19T11:24:00Z') },
    { punchDateTime: new Date('2026-09-20T07:00:00Z') },
  ];
  const grouped = groupPunchesByDate(punches);
  assert.equal(grouped['2026-09-19'].length, 2);
  assert.equal(grouped['2026-09-20'].length, 1);
});

test('analyzeDayForViolation: no break at all over 5h is a violation', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
  ]);
  assert.equal(result.status, 'ok');
  assert.equal(Math.round(result.consecutiveHours * 10) / 10, 5.4);
  assert.equal(result.violates, true);
});

test('analyzeDayForViolation: a genuine 30+ minute break resets the consecutive-hours clock, no violation', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' }, // in
    { punchDateTime: '2026-09-19T10:00:00' }, // out (4h stretch)
    { punchDateTime: '2026-09-19T10:35:00' }, // in (35 min break — qualifies)
    { punchDateTime: '2026-09-19T14:00:00' }, // out (3.42h stretch)
  ]);
  assert.equal(result.status, 'ok');
  assert.equal(result.violates, false);
  assert.ok(result.consecutiveHours < 5.0);
  assert.equal(Math.round(result.longestGapMinutes), 35);
});

test('analyzeDayForViolation: a break under 30 minutes does not reset the clock and does not prevent a violation', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' }, // in
    { punchDateTime: '2026-09-19T09:00:00' }, // out (3h)
    { punchDateTime: '2026-09-19T09:10:00' }, // in (10 min gap — does not qualify)
    { punchDateTime: '2026-09-19T12:30:00' }, // out (3.33h) -> combined stretch 6.5h
  ]);
  assert.equal(result.status, 'ok');
  assert.equal(result.violates, true);
  assert.equal(Math.round(result.longestGapMinutes), 10);
  assert.ok(result.consecutiveHours > 5.0);
});

test('analyzeDayForViolation: exactly 5.0 hours is a violation (>=, not >)', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:00:00' },
  ]);
  assert.equal(result.violates, true);
});

test('analyzeDayForViolation: under 5.0 hours total is never a violation even with zero break', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T10:30:00' },
  ]);
  assert.equal(result.violates, false);
});

test('analyzeDayForViolation: no punches at all is ok, zero hours, no violation', () => {
  const result = analyzeDayForViolation([]);
  assert.deepEqual(result, { status: 'ok', consecutiveHours: 0, longestGapMinutes: null, violates: false });
});

test('analyzeDayForViolation: an odd/unpaired punch count is indeterminate, never guessed as a violation', () => {
  const result = analyzeDayForViolation([
    { punchDateTime: '2026-09-19T06:00:00' },
    { punchDateTime: '2026-09-19T11:24:00' },
    { punchDateTime: '2026-09-19T21:52:00' }, // trailing unpaired punch, e.g. a forgotten clock-out
  ]);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.violates, false);
});
