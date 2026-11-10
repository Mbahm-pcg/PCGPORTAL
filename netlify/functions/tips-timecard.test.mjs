import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timecardHours } from './tips-report-cron-background.mjs';

const p = (t) => ({ punchDateTime: t });

test('timecard punches pair in time order: in→out', () => {
  assert.equal(timecardHours([p('2026-11-05T15:18:00'), p('2026-11-05T06:09:00')], '2026-11-05'), 9.15);
});
test('a meal break (out + back in) is not counted', () => {
  assert.equal(timecardHours([p('2026-11-06T06:00:00'), p('2026-11-06T10:00:00'), p('2026-11-06T10:30:00'), p('2026-11-06T14:00:00')], '2026-11-06'), 7.5);
});
test('a trailing unmatched punch (still clocked in) is ignored; other days are ignored', () => {
  assert.equal(timecardHours([p('2026-11-05T06:00:00'), p('2026-11-05T12:00:00'), p('2026-11-05T13:00:00')], '2026-11-05'), 6);
  assert.equal(timecardHours([p('2026-11-04T22:00:00'), p('2026-11-05T06:00:00'), p('2026-11-05T14:00:00')], '2026-11-05'), 8);
  assert.equal(timecardHours([], '2026-11-05'), 0);
});
