// Force UTC regardless of the machine running these tests. Netlify Functions run in UTC;
// this dev box's own local TZ happens to be America/New_York, which would silently hide the
// naive-punch-timezone bug these tests exist to catch (Date.parse on a naive/no-zone string
// uses the process's local TZ — it must be pinned so the tests mean the same thing everywhere).
process.env.TZ = 'UTC';

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  WARN_MIN, ABSENT_MIN, normalizeShift, shiftKey, candidateShifts, hasClockedIn,
  planAlerts, buildMessages, pruneState, fmtEt, shortName,
} from './no-clockin.mjs';

const MIN = 60000;
const START = '2026-09-21T10:00:00Z';           // 6:00a ET (EDT)
const START_MS = Date.parse(START);
const END = '2026-09-21T16:00:00Z';
const at = (minAfterStart) => START_MS + minAfterStart * MIN;
const shift = (over = {}) => ({ employeeId: 'e1', employeeName: 'Jane Doe', startDateTime: START, endDateTime: END, ...over });

describe('normalizeShift', () => {
  test('maps Paycor field variants', () => {
    const n = normalizeShift({ EmployeeId: 'x', firstName: 'A', lastName: 'B', StartDateTime: START, EndDateTime: END });
    assert.deepStrictEqual(n, { employeeId: 'x', employeeName: 'A B', startDateTime: START, endDateTime: END });
  });
});

describe('candidateShifts', () => {
  test('29 min after start is too early', () => assert.strictEqual(candidateShifts([shift()], at(29)).length, 0));
  test('30 min after start is a candidate', () => assert.strictEqual(candidateShifts([shift()], at(30)).length, 1));
  test('90 min is still a candidate, 91 is not', () => {
    assert.strictEqual(candidateShifts([shift()], at(90)).length, 1);
    assert.strictEqual(candidateShifts([shift()], at(91)).length, 0);
  });
  test('shift that already ended is skipped', () => {
    assert.strictEqual(candidateShifts([shift({ endDateTime: '2026-09-21T10:20:00Z' })], at(40)).length, 0);
  });
  test('missing employeeId or bad start is skipped', () => {
    assert.strictEqual(candidateShifts([shift({ employeeId: null }), shift({ startDateTime: 'nope' })], at(40)).length, 0);
  });
});

describe('hasClockedIn', () => {
  test('no punches -> false', () => assert.strictEqual(hasClockedIn([], START_MS, at(40)), false));
  test('punch 30 min before start counts', () => {
    assert.strictEqual(hasClockedIn([{ punchDateTime: new Date(at(-30)).toISOString() }], START_MS, at(40)), true);
  });
  test('punch 61 min before start does not count', () => {
    assert.strictEqual(hasClockedIn([{ punchDateTime: new Date(at(-61)).toISOString() }], START_MS, at(40)), false);
  });
  test('punch in the future does not count', () => {
    assert.strictEqual(hasClockedIn([{ punchDateTime: new Date(at(50)).toISOString() }], START_MS, at(40)), false);
  });
  test('accepts the punchIn field', () => {
    assert.strictEqual(hasClockedIn([{ punchIn: new Date(at(5)).toISOString() }], START_MS, at(40)), true);
  });
  // Confirmed live 2026-09-22: Paycor's employeePunches returns punchDateTime with NO
  // timezone marker (e.g. "2026-09-22T04:02:00"), unlike schedulingShifts' UTC "...Z"
  // times. That naive string is Eastern wall-clock time, not UTC — mis-parsing it as UTC
  // shifts every real on-time punch ~4-5 hours "earlier" (EDT/EST), which is exactly what
  // produced a network-wide false "no clock-in" wave in shadow-mode testing.
  test('naive (no-zone) punch is read as Eastern wall-clock time, not UTC', () => {
    // Shift starts 2026-09-22T08:00:00Z = 4:00a ET. A punch at "04:02:00" (naive) is really
    // 4:02a ET = 08:02:00Z — 2 minutes after start, not ~4 hours before it.
    const shiftStart = Date.parse('2026-09-22T08:00:00Z');
    const now = Date.parse('2026-09-22T09:00:00Z'); // 60 min after start
    assert.strictEqual(hasClockedIn([{ punchDateTime: '2026-09-22T04:02:00' }], shiftStart, now), true);
  });
  test('naive punch during EST (winter) is still read as Eastern time, not off by a fixed 4h', () => {
    // Jan: ET is EST (UTC-5). Shift starts 2026-01-15T13:00:00Z = 8:00a ET. Naive punch
    // "08:02:00" = 8:02a ET = 13:02:00Z — 2 minutes after start.
    const shiftStart = Date.parse('2026-01-15T13:00:00Z');
    const now = Date.parse('2026-01-15T14:00:00Z');
    assert.strictEqual(hasClockedIn([{ punchDateTime: '2026-01-15T08:02:00' }], shiftStart, now), true);
  });
  test('a punch string that already carries "Z" or an offset is parsed as-is (unaffected)', () => {
    assert.strictEqual(hasClockedIn([{ punchDateTime: '2026-09-22T08:02:00Z' }], Date.parse('2026-09-22T08:00:00Z'), Date.parse('2026-09-22T09:00:00Z')), true);
    assert.strictEqual(hasClockedIn([{ punchDateTime: '2026-09-22T04:02:00-04:00' }], Date.parse('2026-09-22T08:00:00Z'), Date.parse('2026-09-22T09:00:00Z')), true);
  });
  test('a naive punch genuinely outside the window is still correctly rejected', () => {
    // "01:00:00" naive = 1:00a ET = 05:00:00Z, well before the -60min window for an 08:00Z start.
    assert.strictEqual(hasClockedIn([{ punchDateTime: '2026-09-22T01:00:00' }], Date.parse('2026-09-22T08:00:00Z'), Date.parse('2026-09-22T09:00:00Z')), false);
  });
});

describe('planAlerts', () => {
  const base = (nowMs, punchesByEmp, state = {}, candidates = [shift()]) =>
    planAlerts({ pc: '339616', storeName: 'Wadsworth', candidates, punchesByEmp, state, nowMs });

  test('35 min, no punch -> one warn30, and not again on the next run', () => {
    const r1 = base(at(35), { e1: [] });
    assert.deepStrictEqual(r1.alerts.map(a => a.stage), ['warn30']);
    const r2 = base(at(50), { e1: [] }, r1.nextState);
    assert.strictEqual(r2.alerts.length, 0);
  });
  test('65 min after a warn30 -> absent once, then never again', () => {
    const r1 = base(at(35), { e1: [] });
    const r2 = base(at(65), { e1: [] }, r1.nextState);
    assert.deepStrictEqual(r2.alerts.map(a => a.stage), ['absent']);
    const r3 = base(at(80), { e1: [] }, r2.nextState);
    assert.strictEqual(r3.alerts.length, 0);
  });
  test('first seen at 65 min (no prior warn) -> absent only', () => {
    assert.deepStrictEqual(base(at(65), { e1: [] }).alerts.map(a => a.stage), ['absent']);
  });
  test('unknown punches (null) never alert', () => {
    assert.strictEqual(base(at(65), { e1: null }).alerts.length, 0);
  });
  test('clocked in -> no alert', () => {
    assert.strictEqual(base(at(65), { e1: [{ punchDateTime: new Date(at(3)).toISOString() }] }).alerts.length, 0);
  });
  test('3 missing at one store -> a single dataProblem, not repeated', () => {
    const cands = ['e1', 'e2', 'e3'].map(id => shift({ employeeId: id }));
    const punches = { e1: [], e2: [], e3: [] };
    const r1 = base(at(35), punches, {}, cands);
    assert.deepStrictEqual(r1.alerts.map(a => a.stage), ['dataProblem']);
    assert.strictEqual(r1.alerts[0].count, 3);
    const r2 = base(at(50), punches, r1.nextState, cands);
    assert.strictEqual(r2.alerts.length, 0);
  });
  test('2 missing is not a data problem', () => {
    const cands = ['e1', 'e2'].map(id => shift({ employeeId: id }));
    const r = base(at(35), { e1: [], e2: [] }, {}, cands);
    assert.deepStrictEqual(r.alerts.map(a => a.stage), ['warn30', 'warn30']);
  });
});

describe('buildMessages', () => {
  const mk = (stage, name) => ({ stage, pc: '339616', storeName: 'Wadsworth', name, startMs: START_MS, key: 'k' + name });
  test('groups people per stage and sets audience', () => {
    const msgs = buildMessages([mk('warn30', 'Jane Doe'), mk('warn30', 'Bob Smith'), mk('absent', 'Ann Lee')]);
    const warn = msgs.find(m => m.stage === 'warn30');
    const absent = msgs.find(m => m.stage === 'absent');
    assert.deepStrictEqual(warn.audience, ['manager']);
    assert.deepStrictEqual(absent.audience, ['manager', 'dm']);
    assert.match(warn.text, /Wadsworth/);
    assert.match(warn.text, /Jane D\. \(6:00a\)/);
    assert.match(warn.text, /Bob S\. \(6:00a\)/);
    assert.match(absent.text, /ABSENT/);
    assert.match(absent.text, /Ann L\./);
  });
  test('dataProblem message names nobody and goes to manager only', () => {
    const [m] = buildMessages([{ stage: 'dataProblem', pc: '339616', storeName: 'Wadsworth', count: 4 }]);
    assert.deepStrictEqual(m.audience, ['manager']);
    assert.match(m.text, /4 scheduled employees/);
    assert.match(m.text, /verify/i);
  });
  // Confirmed live 2026-09-22: two genuinely different incidents hours apart at the same
  // store shared the exact subject "No clock-in — Street Rd", so Gmail threaded them into one
  // conversation and the newer one read as a repeat of the older. The subject must include a
  // shift time so different incidents at the same store never collide.
  test('subject includes the shift time, so different incidents at one store never share a subject', () => {
    const [warn] = buildMessages([mk('warn30', 'Jane Doe')]);
    assert.strictEqual(warn.subject, 'No clock-in — Wadsworth (6:00a)');
    const [absent] = buildMessages([mk('absent', 'Ann Lee')]);
    assert.strictEqual(absent.subject, 'Absent — Wadsworth (6:00a)');
  });
  test('one batch spanning two shift times lists both, deduped, in the subject', () => {
    const early = mk('warn30', 'Jane Doe');
    const later = { ...mk('warn30', 'Bob Smith'), startMs: START_MS + 30 * 60000 }; // 6:30a
    const sameTimeAsEarly = { ...mk('warn30', 'Ann Lee'), startMs: START_MS }; // 6:00a again
    const [warn] = buildMessages([early, later, sameTimeAsEarly]);
    assert.strictEqual(warn.subject, 'No clock-in — Wadsworth (6:00a/6:30a)');
  });
});

describe('pruneState / helpers', () => {
  test('drops entries older than 14 days, keeps recent ones', () => {
    const now = Date.parse('2026-09-21T12:00:00Z');
    const out = pruneState({ old: { startMs: now - 15 * 86400000 }, fresh: { startMs: now - 1 * 86400000 } }, now);
    assert.deepStrictEqual(Object.keys(out), ['fresh']);
  });
  test('fmtEt renders Eastern time like 6:00a / 3:30p', () => {
    assert.strictEqual(fmtEt(Date.parse('2026-09-21T10:00:00Z')), '6:00a');
    assert.strictEqual(fmtEt(Date.parse('2026-09-21T19:30:00Z')), '3:30p');
  });
  test('shortName', () => {
    assert.strictEqual(shortName('Jane Doe'), 'Jane D.');
    assert.strictEqual(shortName('William Isaac Feliciano'), 'William F.');
    assert.strictEqual(shortName('Nathan c'), 'Nathan C.');
    assert.strictEqual(shortName('Prince'), 'Prince');
    assert.strictEqual(shortName(''), 'Employee');
  });
  test('shiftKey', () => assert.strictEqual(shiftKey('339616', shift()), `339616|e1|${START}`));
  test('constants match the spec', () => { assert.strictEqual(WARN_MIN, 30); assert.strictEqual(ABSENT_MIN, 60); });
});
