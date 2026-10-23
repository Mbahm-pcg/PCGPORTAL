import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClosedOn, activeSubset, statusMapFromStores, districtMapFromStores, applyDistricts } from './store-status.mjs';

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

test('districtMapFromStores: keyed by pc string, skips blank / Unassigned (0) districts', () => {
  const m = districtMapFromStores([
    { pc: 339616, district: '3', dmName: 'Sonia' },
    { pc: '340794', district: 0 },
    { pc: '351099', district: '' },
    { district: 2 },
  ]);
  assert.equal(m.size, 1);
  assert.deepEqual(m.get('339616'), { district: 3, dmName: 'Sonia' });
});

test('applyDistricts: moves stores in place, so every list sharing the objects sees it', () => {
  const ALL = [{ pc: '1', district: 2 }, { pc: '2', district: 2 }, { pc: '3', district: 5 }];
  const TRIMMED = [ALL[0], ALL[2]]; // e.g. STORES after closed stores were dropped
  const live = districtMapFromStores([{ pc: '1', district: 4 }, { pc: '2', district: 2 }, { pc: '3', district: 0 }]);
  assert.equal(applyDistricts(ALL, live), 1);
  assert.equal(TRIMMED[0].district, 4);           // same object, so the trimmed list moved too
  assert.equal(ALL[1].district, 2);               // unchanged
  assert.equal(ALL[2].district, 5);               // Unassigned in Locations → keep the job's own value
  assert.equal(typeof ALL[0].district, 'number'); // callers compare with ===
});

test('applyDistricts: copies the DM name only onto stores that carry one; no Locations = no change', () => {
  const list = [{ pc: '1', district: 2, dmName: 'Jay Patel' }, { pc: '2', district: 2 }];
  applyDistricts(list, districtMapFromStores([{ pc: '1', district: 2, dmName: 'Farhana Khalique' }, { pc: '2', district: 3, dmName: 'X' }]));
  assert.equal(list[0].dmName, 'Farhana Khalique');
  assert.equal('dmName' in list[1], false);
  assert.equal(list[1].district, 3);
  assert.equal(applyDistricts(list, null), 0);
});
