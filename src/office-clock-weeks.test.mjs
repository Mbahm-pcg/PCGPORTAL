import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, periodWeeks, weekTotals, weekContaining } from './office-clock-weeks.mjs';
import { payPeriodEndFor } from './office-clock-lib.mjs';

test('periodWeeks: two Sunday–Saturday weeks ending on the period-end Saturday', () => {
  const end = payPeriodEndFor('2026-10-23'); // the real current period
  assert.equal(new Date(`${end}T12:00:00Z`).getUTCDay(), 6);
  const [w1, w2] = periodWeeks(end);
  assert.equal(new Date(`${w1.weekStart}T12:00:00Z`).getUTCDay(), 0);
  assert.equal(w2.weekEnd, end);
  assert.equal(addDays(w1.weekEnd, 1), w2.weekStart);
});

test('weekTotals: sums each week separately, never guesses an incomplete day', () => {
  const end = '2026-10-24';
  const daily = [
    { day: '2026-10-12', totalMinutes: 480 }, { day: '2026-10-13', totalMinutes: 450 },
    { day: '2026-10-14', totalMinutes: null },                                    // no clock-out
    { day: '2026-10-20', totalMinutes: 509 }, { day: '2026-10-21', totalMinutes: 509 },
  ];
  const [w1, w2] = weekTotals(daily, end);
  assert.deepEqual([w1.weekStart, w1.weekEnd, w1.minutes, w1.incompleteDays], ['2026-10-11', '2026-10-17', 930, 1]);
  assert.deepEqual([w2.minutes, w2.incompleteDays], [1018, 0]);
  assert.deepEqual(w2.days.map(d => d.day), ['2026-10-21', '2026-10-20']); // most recent first
});

test('weekTotals: today still clocked in counts its hours so far, flagged in progress', () => {
  const [, w2] = weekTotals([{ day: '2026-10-21', totalMinutes: 480 }, { day: '2026-10-23', totalMinutes: null }], '2026-10-24', { today: '2026-10-23', todayMinutes: 125 });
  assert.equal(w2.minutes, 605);
  assert.equal(w2.inProgress, true);
  assert.equal(w2.incompleteDays, 0);
});

test('weekContaining: finds the week for a day, null outside the period', () => {
  const weeks = periodWeeks('2026-10-24');
  assert.equal(weekContaining(weeks, '2026-10-23').weekStart, '2026-10-18');
  assert.equal(weekContaining(weeks, '2026-10-01'), null);
});
