import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  punchStatusAndActivity, payPeriodEndFor, findIncompleteDays,
  dailyHoursFromPunches, weeklyRegOtFromPunches,
} from './office-clock-lib.mjs';

test('punchStatusAndActivity maps all four buttons correctly', () => {
  assert.deepEqual(punchStatusAndActivity('clock_in'), { status: 'In', activity: 'Work' });
  assert.deepEqual(punchStatusAndActivity('meal_start'), { status: 'Out', activity: 'Meal' });
  assert.deepEqual(punchStatusAndActivity('meal_end'), { status: 'In', activity: 'Work' });
  assert.deepEqual(punchStatusAndActivity('clock_out'), { status: 'Out', activity: 'Work' });
});

test('punchStatusAndActivity throws on an unknown button type', () => {
  assert.throws(() => punchStatusAndActivity('lunch'), /unknown punch type/i);
});

test('payPeriodEndFor resolves a date to the correct closing Saturday', () => {
  assert.equal(payPeriodEndFor('2026-08-15'), '2026-08-15');
  assert.equal(payPeriodEndFor('2026-08-02'), '2026-08-15');
  assert.equal(payPeriodEndFor('2026-08-16'), '2026-08-29');
  assert.equal(payPeriodEndFor('2026-08-29'), '2026-08-29');
});

test('findIncompleteDays flags a clock-in with no matching clock-out', () => {
  const punches = [{ punchType: 'clock_in', capturedAt: '2026-08-10T13:00:00Z' }];
  const days = findIncompleteDays(punches);
  assert.equal(days.length, 1);
  assert.equal(days[0].reason, 'open_clock_in');
});

test('findIncompleteDays does not flag a complete in/out pair', () => {
  const punches = [
    { punchType: 'clock_in', capturedAt: '2026-08-10T13:00:00Z' },
    { punchType: 'clock_out', capturedAt: '2026-08-10T21:00:00Z' },
  ];
  assert.deepEqual(findIncompleteDays(punches), []);
});

test('findIncompleteDays buckets by ET calendar day, not UTC (I4)', () => {
  // 2026-08-11T02:00:00Z is 2026-08-10 22:00 ET (EDT, UTC-4) — a late-night
  // clock-out that lands on the NEXT UTC calendar day but is still the SAME
  // ET day as the clock-in. Before the I4 fix (raw `capturedAt.slice(0,10)`
  // UTC bucketing), this clock-out would have been bucketed under 2026-08-11
  // and the clock-in under 2026-08-10, falsely flagging an open clock-in.
  const punches = [
    { punchType: 'clock_in', capturedAt: '2026-08-10T13:00:00Z' },
    { punchType: 'clock_out', capturedAt: '2026-08-11T02:00:00Z' },
  ];
  assert.deepEqual(findIncompleteDays(punches), []);
});

test('findIncompleteDays flags a meal_start with no matching meal_end', () => {
  const punches = [
    { punchType: 'clock_in', capturedAt: '2026-08-10T13:00:00Z' },
    { punchType: 'meal_start', capturedAt: '2026-08-10T17:00:00Z' },
    { punchType: 'clock_out', capturedAt: '2026-08-10T21:00:00Z' },
  ];
  const days = findIncompleteDays(punches);
  assert.equal(days.length, 1);
  assert.equal(days[0].reason, 'open_meal');
});

test('dailyHoursFromPunches totals an exact in/out pair, minus an exact meal', () => {
  const punches = [
    { punchType: 'clock_in', capturedAt: '2026-08-18T13:00:00Z' },   // 9am ET
    { punchType: 'meal_start', capturedAt: '2026-08-18T17:00:00Z' }, // 1pm ET
    { punchType: 'meal_end', capturedAt: '2026-08-18T17:30:00Z' },   // 1:30pm ET
    { punchType: 'clock_out', capturedAt: '2026-08-18T21:30:00Z' },  // 5:30pm ET
  ];
  const rows = dailyHoursFromPunches(punches);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, '2026-08-18');
  assert.equal(rows[0].totalMinutes, 8 * 60); // 8.5 hrs gross - 30 min meal = 8h exact
});

test('dailyHoursFromPunches leaves a malformed day (no clock-out) as null, not a guess', () => {
  const punches = [{ punchType: 'clock_in', capturedAt: '2026-08-18T13:00:00Z' }];
  const rows = dailyHoursFromPunches(punches);
  assert.equal(rows[0].totalMinutes, null);
});

test('weeklyRegOtFromPunches: a normal week under 40 hours has zero OT', () => {
  // 2026-08-18 is a Tuesday inside week 1 (2026-08-16..2026-08-22) of the
  // period ending 2026-08-29 — one 8-hour day, well under 40 for the week.
  const punches = [
    { punchType: 'clock_in', capturedAt: '2026-08-18T13:00:00Z' },
    { punchType: 'clock_out', capturedAt: '2026-08-18T21:00:00Z' },
  ];
  const weeks = weeklyRegOtFromPunches(punches, '2026-08-29');
  assert.equal(weeks.length, 2);
  assert.deepEqual(weeks[0], { weekStart: '2026-08-16', weekEnd: '2026-08-22', regHours: 8, otHours: 0, incomplete: false });
  assert.deepEqual(weeks[1], { weekStart: '2026-08-23', weekEnd: '2026-08-29', regHours: 0, otHours: 0, incomplete: false });
});

test('weeklyRegOtFromPunches splits a 50-hour week into 40 Reg + 10 OT', () => {
  // Five 10-hour days (Mon-Fri) inside week 2 (2026-08-23..2026-08-29).
  const days = ['24', '25', '26', '27', '28'];
  const punches = days.flatMap(d => [
    { punchType: 'clock_in', capturedAt: `2026-08-${d}T13:00:00Z` },
    { punchType: 'clock_out', capturedAt: `2026-08-${d}T23:00:00Z` },
  ]);
  const weeks = weeklyRegOtFromPunches(punches, '2026-08-29');
  assert.equal(weeks[1].regHours, 40);
  assert.equal(weeks[1].otHours, 10);
  assert.equal(weeks[1].incomplete, false);
});

test('weeklyRegOtFromPunches flags a week incomplete rather than understating hours', () => {
  // An open clock-in with no clock-out inside week 1 must never be silently
  // counted as 0 hours — the week comes back incomplete so the caller can
  // refuse to stage it.
  const punches = [{ punchType: 'clock_in', capturedAt: '2026-08-18T13:00:00Z' }];
  const weeks = weeklyRegOtFromPunches(punches, '2026-08-29');
  assert.equal(weeks[0].incomplete, true);
});

test('weeklyRegOtFromPunches keeps the two weeks of a period independent (no cross-week OT)', () => {
  // 35 hours in week 1, 35 hours in week 2 — 70 total, but neither week
  // crosses 40 on its own, so there should be no OT at all.
  const week1Days = ['17', '18', '19', '20', '21']; // Mon-Fri of week 1
  const week2Days = ['24', '25', '26', '27', '28']; // Mon-Fri of week 2
  const punches = [...week1Days, ...week2Days].flatMap(d => [
    { punchType: 'clock_in', capturedAt: `2026-08-${d}T13:00:00Z` },
    { punchType: 'clock_out', capturedAt: `2026-08-${d}T20:00:00Z` }, // 7 hrs/day
  ]);
  const weeks = weeklyRegOtFromPunches(punches, '2026-08-29');
  assert.equal(weeks[0].regHours, 35);
  assert.equal(weeks[0].otHours, 0);
  assert.equal(weeks[1].regHours, 35);
  assert.equal(weeks[1].otHours, 0);
});
