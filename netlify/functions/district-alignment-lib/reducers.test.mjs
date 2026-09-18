import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReassignStore, applyAddDm, applyRemoveDm } from './reducers.mjs';

const BASE_DRAFT = {
  stores: { '100001': { district: 1 }, '100002': { district: 2 } },
  dms: [
    { id: 'dm_1', name: 'Taylor Cormier', email: 'taylor@peoplecapitalgroup.com', district: 1 },
    { id: 'dm_2', name: 'Jay Patel', email: 'jay@peoplecapitalgroup.com', district: 2 },
  ],
  seededFromLiveAt: '2026-09-17T00:00:00.000Z',
};

test('applyReassignStore: moves a store to a different district', () => {
  const next = applyReassignStore(BASE_DRAFT, '100001', 2);
  assert.equal(next.stores['100001'].district, 2);
});

test('applyReassignStore: does not mutate the input draft', () => {
  const before = JSON.stringify(BASE_DRAFT);
  applyReassignStore(BASE_DRAFT, '100001', 2);
  assert.equal(JSON.stringify(BASE_DRAFT), before);
});

test('applyReassignStore: leaves other stores untouched', () => {
  const next = applyReassignStore(BASE_DRAFT, '100001', 2);
  assert.equal(next.stores['100002'].district, 2);
});

test('applyAddDm: appends a new dm with a generated id', () => {
  const next = applyAddDm(BASE_DRAFT, { name: 'New DM', email: 'newdm@peoplecapitalgroup.com', district: 9 });
  assert.equal(next.dms.length, 3);
  const added = next.dms.find(d => d.district === 9);
  assert.equal(added.name, 'New DM');
  assert.ok(added.id);
});

test('applyAddDm: rejects a duplicate district', () => {
  assert.throws(() => applyAddDm(BASE_DRAFT, { name: 'Dup', email: 'x@peoplecapitalgroup.com', district: 1 }), /already has a DM/);
});

test('applyRemoveDm: removes the dm entry', () => {
  const next = applyRemoveDm(BASE_DRAFT, 'dm_1');
  assert.equal(next.dms.length, 1);
  assert.ok(!next.dms.find(d => d.id === 'dm_1'));
});

test('applyRemoveDm: stores that belonged to that DM keep their district number (become "unassigned" only in display, not deleted)', () => {
  const next = applyRemoveDm(BASE_DRAFT, 'dm_1');
  assert.equal(next.stores['100001'].district, 1);
});

test('applyRemoveDm: unknown id is a no-op returning an equivalent draft', () => {
  const next = applyRemoveDm(BASE_DRAFT, 'dm_nonexistent');
  assert.equal(next.dms.length, 2);
});
