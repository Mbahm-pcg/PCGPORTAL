import { test, describe } from 'node:test';
import assert from 'node:assert';
import { removeShiftFromEmployee, addShiftToEmployee } from './schedule-grid.mjs';

const shift = { dayOffset: 1, startTime: '09:00', endTime: '17:00' };
function makeList() {
  return [
    { employeeId: 'a', shifts: [shift] },
    { employeeId: 'b', shifts: [] },
  ];
}

describe('removeShiftFromEmployee', () => {
  test('removes the exact shift instance from the matching employee', () => {
    const result = removeShiftFromEmployee(makeList(), 'a', shift);
    assert.deepStrictEqual(result.find(c => c.employeeId === 'a').shifts, []);
  });
  test('leaves other employees untouched (same object reference)', () => {
    const list = makeList();
    const result = removeShiftFromEmployee(list, 'a', shift);
    assert.strictEqual(result.find(c => c.employeeId === 'b'), list[1]);
  });
  test('is a no-op when the employeeId is not present', () => {
    const list = makeList();
    const result = removeShiftFromEmployee(list, 'nobody', shift);
    assert.deepStrictEqual(result, list);
  });
  test('a value-equal but different-instance shift is not removed', () => {
    const lookalike = { dayOffset: 1, startTime: '09:00', endTime: '17:00' };
    const result = removeShiftFromEmployee(makeList(), 'a', lookalike);
    assert.strictEqual(result.find(c => c.employeeId === 'a').shifts.length, 1);
  });
  test('does not mutate the input list', () => {
    const list = makeList();
    removeShiftFromEmployee(list, 'a', shift);
    assert.strictEqual(list[0].shifts.length, 1);
  });
});

describe('addShiftToEmployee', () => {
  test('appends the shift to the matching employee', () => {
    const result = addShiftToEmployee(makeList(), 'b', shift);
    assert.deepStrictEqual(result.find(c => c.employeeId === 'b').shifts, [shift]);
  });
  test('is a no-op when the employeeId is not present', () => {
    const list = makeList();
    const result = addShiftToEmployee(list, 'nobody', shift);
    assert.deepStrictEqual(result, list);
  });
  test('does not mutate the input list', () => {
    const list = makeList();
    addShiftToEmployee(list, 'b', shift);
    assert.strictEqual(list[1].shifts.length, 0);
  });
});

describe('composing a reassign from the two primitives', () => {
  test('moves a shift from one employee to another', () => {
    const moved = addShiftToEmployee(removeShiftFromEmployee(makeList(), 'a', shift), 'b', shift);
    assert.deepStrictEqual(moved.find(c => c.employeeId === 'a').shifts, []);
    assert.deepStrictEqual(moved.find(c => c.employeeId === 'b').shifts, [shift]);
  });
  test('moving within the same employee to a new day works via remove-then-add', () => {
    const newShift = { ...shift, dayOffset: 3 };
    const moved = addShiftToEmployee(removeShiftFromEmployee(makeList(), 'a', shift), 'a', newShift);
    assert.deepStrictEqual(moved.find(c => c.employeeId === 'a').shifts, [newShift]);
  });
});
