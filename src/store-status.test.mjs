import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClosedOn, activeSubset, statusMapFromStores } from './store-status.mjs';

const closed = { pc: '1', status: 'Permanently Closed', closedDate: '2026-08-30' };
const open = { pc: '2', status: 'Open' };
const temp = { pc: '3', status: 'Temp Closed' };

test('isClosedOn: permanently closed counts only AFTER its closed date', () => {
  assert.equal(isClosedOn(closed, '2026-08-30'), false);
  assert.equal(isClosedOn(closed, '2026-08-31'), true);
});

test('isClosedOn: grace days keep a closed store through its final pay period', () => {
  assert.equal(isClosedOn(closed, '2026-09-13', 14), false);
  assert.equal(isClosedOn(closed, '2026-09-14', 14), true);
});

test('isClosedOn: no closedDate means closed now; Temp Closed / Remodel / Open are never closed', () => {
  assert.equal(isClosedOn({ status: 'Permanently Closed' }, '2026-01-01'), true);
  assert.equal(isClosedOn(temp, '2030-01-01'), false);
  assert.equal(isClosedOn({ status: 'Remodel' }, '2030-01-01'), false);
  assert.equal(isClosedOn(open, '2030-01-01'), false);
  assert.equal(isClosedOn(null, '2030-01-01'), false);
});

test('activeSubset: drops closed stores, keeps everything when statuses are unavailable', () => {
  const list = [{ pc: '1', name: 'A' }, { pc: '2', name: 'B' }, { pc: 3, name: 'C' }];
  const map = statusMapFromStores([closed, open, temp]);
  assert.deepEqual(activeSubset(list, map, '2026-10-01').map(s => s.name), ['B', 'C']);
  assert.deepEqual(activeSubset(list, null, '2026-10-01').map(s => s.name), ['A', 'B', 'C']);
});

test('statusMapFromStores: keyed by pc string, ignores rows without a pc', () => {
  const m = statusMapFromStores([{ pc: 339616, status: 'Open' }, { status: 'Open' }]);
  assert.equal(m.size, 1);
  assert.equal(m.get('339616').status, 'Open');
});
