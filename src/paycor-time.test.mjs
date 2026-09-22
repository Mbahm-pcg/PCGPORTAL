process.env.TZ = 'UTC'; // pin regardless of the machine running this — see no-clockin.test.mjs

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parsePaycorPunchMs } from './paycor-time.mjs';

describe('parsePaycorPunchMs', () => {
  test('naive string in EDT (summer) is read as Eastern wall-clock time, not UTC', () => {
    // "04:02:00" naive on a September date = 4:02a ET = 08:02:00Z (EDT is UTC-4).
    assert.strictEqual(parsePaycorPunchMs('2026-09-22T04:02:00'), Date.parse('2026-09-22T08:02:00Z'));
  });
  test('naive string in EST (winter) is read as Eastern wall-clock time, not a fixed 4h', () => {
    // "08:02:00" naive on a January date = 8:02a ET = 13:02:00Z (EST is UTC-5).
    assert.strictEqual(parsePaycorPunchMs('2026-01-15T08:02:00'), Date.parse('2026-01-15T13:02:00Z'));
  });
  test('a string with "Z" is trusted as UTC, untouched', () => {
    assert.strictEqual(parsePaycorPunchMs('2026-09-22T08:02:00Z'), Date.parse('2026-09-22T08:02:00Z'));
  });
  test('a string with an explicit offset is trusted as-is, untouched', () => {
    assert.strictEqual(parsePaycorPunchMs('2026-09-22T04:02:00-04:00'), Date.parse('2026-09-22T08:02:00Z'));
  });
  test('falsy/empty input returns NaN', () => {
    assert.ok(Number.isNaN(parsePaycorPunchMs('')));
    assert.ok(Number.isNaN(parsePaycorPunchMs(null)));
    assert.ok(Number.isNaN(parsePaycorPunchMs(undefined)));
  });
  test('unparseable garbage returns NaN, not a wrong number', () => {
    assert.ok(Number.isNaN(parsePaycorPunchMs('not-a-date')));
  });
});
