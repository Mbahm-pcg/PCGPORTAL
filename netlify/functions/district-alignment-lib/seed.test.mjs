import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedFromLive } from './seed.mjs';

const SAMPLE_STORES = [
  { pc: '100001', district: 1, dmName: 'Taylor Cormier', dmEmail: 'taylor@peoplecapitalgroup.com', status: 'Open' },
  { pc: '100002', district: 1, dmName: 'Taylor Cormier', dmEmail: 'taylor@peoplecapitalgroup.com', status: 'Open' },
  { pc: '100003', district: 2, dmName: 'Jay Patel', dmEmail: 'jay@peoplecapitalgroup.com', status: 'Remodel' },
  { pc: '100004', district: 7, dmName: 'Sharmin Akter', dmEmail: 'sharmin@peoplecapitalgroup.com', status: 'Permanently Closed' },
];

test('buildSeedFromLive: includes open/remodel stores, excludes permanently closed', () => {
  const seed = buildSeedFromLive(SAMPLE_STORES);
  assert.equal(Object.keys(seed.stores).length, 3);
  assert.ok(!seed.stores['100004']);
});

test('buildSeedFromLive: assigns correct district per store', () => {
  const seed = buildSeedFromLive(SAMPLE_STORES);
  assert.equal(seed.stores['100001'].district, 1);
  assert.equal(seed.stores['100003'].district, 2);
});

test('buildSeedFromLive: one dms entry per distinct district, with that district\'s name/email', () => {
  const seed = buildSeedFromLive(SAMPLE_STORES);
  assert.equal(seed.dms.length, 2);
  const d1 = seed.dms.find(d => d.district === 1);
  assert.equal(d1.name, 'Taylor Cormier');
  assert.equal(d1.email, 'taylor@peoplecapitalgroup.com');
  const d2 = seed.dms.find(d => d.district === 2);
  assert.equal(d2.name, 'Jay Patel');
});

test('buildSeedFromLive: each dm gets a stable string id', () => {
  const seed = buildSeedFromLive(SAMPLE_STORES);
  seed.dms.forEach(d => assert.equal(typeof d.id, 'string'));
  const ids = seed.dms.map(d => d.id);
  assert.equal(new Set(ids).size, ids.length); // all unique
});

test('buildSeedFromLive: records a seededFromLiveAt ISO timestamp', () => {
  const seed = buildSeedFromLive(SAMPLE_STORES);
  assert.doesNotThrow(() => new Date(seed.seededFromLiveAt).toISOString());
});

test('buildSeedFromLive: a store with no district becomes null, not skipped', () => {
  const seed = buildSeedFromLive([
    { pc: '100005', district: null, dmName: '', dmEmail: '', status: 'Permanently Closed' === 'x' ? '' : 'Open' },
  ]);
  assert.equal(seed.stores['100005'].district, null);
});
