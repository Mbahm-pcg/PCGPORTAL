import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  punchStatusAndActivity, payPeriodEndFor, findIncompleteDays,
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
