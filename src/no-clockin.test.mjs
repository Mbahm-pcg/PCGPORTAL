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
  test('180 min is still a candidate, 181 is not', () => {
    assert.strictEqual(candidateShifts([shift()], at(180)).length, 1);
    assert.strictEqual(candidateShifts([shift()], at(181)).length, 0);
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
    assert.strictEqual(shortName('Prince'), 'Prince');
    assert.strictEqual(shortName(''), 'Employee');
  });
  test('shiftKey', () => assert.strictEqual(shiftKey('339616', shift()), `339616|e1|${START}`));
  test('constants match the spec', () => { assert.strictEqual(WARN_MIN, 30); assert.strictEqual(ABSENT_MIN, 60); });
});
