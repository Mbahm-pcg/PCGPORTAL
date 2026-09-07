import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyFeed, rollup, classifyPerStore, diffForAlerts, FEEDS, buildSnapshot } from './system-health.mjs';

const MIN = 60000;
const NOW = 1_000_000_000_000;

describe('classifyFeed', () => {
  const spec = { expectedMaxAgeMin: 90 };
  test('fresh (age < expected) → OK', () => {
    assert.strictEqual(classifyFeed(NOW - 10 * MIN, NOW, spec), 'OK');
  });
  test('exactly at expected boundary → OK', () => {
    assert.strictEqual(classifyFeed(NOW - 90 * MIN, NOW, spec), 'OK');
  });
  test('between 1x and 2x → STALE', () => {
    assert.strictEqual(classifyFeed(NOW - 120 * MIN, NOW, spec), 'STALE');
  });
  test('exactly 2x boundary → STALE', () => {
    assert.strictEqual(classifyFeed(NOW - 180 * MIN, NOW, spec), 'STALE');
  });
  test('beyond 2x → DOWN', () => {
    assert.strictEqual(classifyFeed(NOW - 181 * MIN, NOW, spec), 'DOWN');
  });
  test('missing savedAt (null) → DOWN', () => {
    assert.strictEqual(classifyFeed(null, NOW, spec), 'DOWN');
  });
});

describe('rollup', () => {
  test('all OK → GREEN', () => {
    assert.strictEqual(rollup([{ status: 'OK', critical: true }, { status: 'OK', critical: false }]), 'GREEN');
  });
  test('critical DOWN → RED', () => {
    assert.strictEqual(rollup([{ status: 'DOWN', critical: true }, { status: 'OK', critical: false }]), 'RED');
  });
  test('critical STALE (no critical DOWN) → YELLOW', () => {
    assert.strictEqual(rollup([{ status: 'STALE', critical: true }]), 'YELLOW');
  });
  test('non-critical DOWN caps at YELLOW (never RED)', () => {
    assert.strictEqual(rollup([{ status: 'DOWN', critical: false }, { status: 'OK', critical: true }]), 'YELLOW');
  });
});

describe('classifyPerStore', () => {
  const spec = { expectedMaxAgeMin: 90 };
  const pcs = ['100', '200', '300'];
  test('all fresh → OK, storesOk = total, no stale', () => {
    const per = { '100': NOW, '200': NOW, '300': NOW };
    const r = classifyPerStore(per, NOW, spec, pcs);
    assert.strictEqual(r.status, 'OK');
    assert.strictEqual(r.storesOk, 3);
    assert.strictEqual(r.storesTotal, 3);
    assert.deepStrictEqual(r.staleStores, []);
  });
  test('one stale → STALE with that store listed', () => {
    const per = { '100': NOW, '200': NOW - 120 * MIN, '300': NOW };
    const r = classifyPerStore(per, NOW, spec, pcs);
    assert.strictEqual(r.status, 'STALE');
    assert.strictEqual(r.storesOk, 2);
    assert.deepStrictEqual(r.staleStores, [{ pc: '200', status: 'STALE' }]);
  });
  test('all missing → DOWN', () => {
    const per = { '100': null, '200': null, '300': null };
    const r = classifyPerStore(per, NOW, spec, pcs);
    assert.strictEqual(r.status, 'DOWN');
    assert.strictEqual(r.storesOk, 0);
  });
  test('zero active stores → DOWN', () => {
    assert.strictEqual(classifyPerStore({}, NOW, spec, []).status, 'DOWN');
  });
});

describe('diffForAlerts', () => {
  const next = { feeds: [
    { key: 'labor', status: 'DOWN', critical: true },
    { key: 'reviews', status: 'OK', critical: false },
  ] };
  test('OK→DOWN emits a critical transition', () => {
    const prev = { feeds: [{ key: 'labor', status: 'OK' }, { key: 'reviews', status: 'OK' }] };
    assert.deepStrictEqual(diffForAlerts(prev, next), [{ key: 'labor', from: 'OK', to: 'DOWN', critical: true }]);
  });
  test('STALE→STALE emits nothing', () => {
    const prev = { feeds: [{ key: 'labor', status: 'STALE' }] };
    const nx = { feeds: [{ key: 'labor', status: 'STALE', critical: true }] };
    assert.deepStrictEqual(diffForAlerts(prev, nx), []);
  });
  test('DOWN→OK emits a recovery transition', () => {
    const prev = { feeds: [{ key: 'labor', status: 'DOWN' }] };
    const nx = { feeds: [{ key: 'labor', status: 'OK', critical: true }] };
    assert.deepStrictEqual(diffForAlerts(prev, nx), [{ key: 'labor', from: 'DOWN', to: 'OK', critical: true }]);
  });
  test('new feed absent in prev treated as from OK', () => {
    const nx = { feeds: [{ key: 'newfeed', status: 'DOWN', critical: true }] };
    assert.deepStrictEqual(diffForAlerts(null, nx), [{ key: 'newfeed', from: 'OK', to: 'DOWN', critical: true }]);
  });
});

describe('FEEDS registry sanity', () => {
  test('every entry has the required fields', () => {
    for (const f of FEEDS) {
      assert.ok(f.key && typeof f.key === 'string', `key on ${JSON.stringify(f)}`);
      assert.ok(f.label && typeof f.label === 'string', `label on ${f.key}`);
      assert.ok(f.blobKey && typeof f.blobKey === 'string', `blobKey on ${f.key}`);
      assert.ok(Number.isFinite(f.expectedMaxAgeMin) && f.expectedMaxAgeMin > 0, `expectedMaxAgeMin on ${f.key}`);
      assert.strictEqual(typeof f.perStore, 'boolean', `perStore on ${f.key}`);
      assert.strictEqual(typeof f.critical, 'boolean', `critical on ${f.key}`);
      assert.ok(f.category && typeof f.category === 'string', `category on ${f.key}`);
    }
  });
  test('feed keys are unique', () => {
    const keys = FEEDS.map(f => f.key);
    assert.strictEqual(new Set(keys).size, keys.length);
  });
});

describe('buildSnapshot', () => {
  const NOW2 = 2_000_000_000_000;
  const pcs = ['100', '200'];
  test('all feeds fresh → GREEN', async () => {
    const readSavedAt = async () => NOW2; // every blob fresh
    const snap = await buildSnapshot({ readSavedAt, activePcs: pcs, nowMs: NOW2, beats: {} });
    assert.strictEqual(snap.overall, 'GREEN');
    assert.strictEqual(snap.asOf, NOW2);
    assert.strictEqual(snap.feeds.length, FEEDS.length);
  });
  test('a critical blob missing (null) → that feed DOWN → RED', async () => {
    const laborSpec = FEEDS.find(f => f.critical && !f.perStore);
    const readSavedAt = async (key) => (key === laborSpec.blobKey ? null : NOW2);
    const snap = await buildSnapshot({ readSavedAt, activePcs: pcs, nowMs: NOW2, beats: {} });
    const feed = snap.feeds.find(f => f.key === laborSpec.key);
    assert.strictEqual(feed.status, 'DOWN');
    assert.strictEqual(snap.overall, 'RED');
  });
  test('a throwing blob read is isolated → that feed DOWN with error, others fine', async () => {
    const target = FEEDS[0];
    const readSavedAt = async (key) => { if (key.startsWith(target.blobKey)) throw new Error('boom'); return NOW2; };
    const snap = await buildSnapshot({ readSavedAt, activePcs: pcs, nowMs: NOW2, beats: {} });
    const feed = snap.feeds.find(f => f.key === target.key);
    assert.strictEqual(feed.status, 'DOWN');
    assert.match(feed.error, /boom/);
  });
  test('a heartbeat with ok:false downgrades an otherwise-OK feed to STALE', async () => {
    const target = FEEDS[0];
    const readSavedAt = async () => NOW2;
    const beats = { [target.key]: { ok: false, error: 'token expired', durationMs: 12, at: 'x' } };
    const snap = await buildSnapshot({ readSavedAt, activePcs: pcs, nowMs: NOW2, beats });
    const feed = snap.feeds.find(f => f.key === target.key);
    assert.strictEqual(feed.status, 'STALE');
    assert.strictEqual(feed.error, 'token expired');
  });
  test('activePcsByKey scopes a per-store feed to its own blob set, ignoring pcs absent from it', async () => {
    // 'pnl-store' only has a blob for pc '100' (e.g. '200' is a closed/excluded
    // store with no P&L blob). Without scoping, '200' would be checked against
    // the shared labor store-set and flag this critical feed STALE.
    const subset = ['100'];
    const readSavedAt = async (key) => {
      if (key.startsWith('pcg_pnl_store_')) {
        const pc = key.slice('pcg_pnl_store_'.length);
        return subset.includes(pc) ? NOW2 : null; // '200' would be missing/stale
      }
      return NOW2;
    };
    const snap = await buildSnapshot({
      readSavedAt, activePcs: pcs, activePcsByKey: { 'pnl-store': subset }, nowMs: NOW2, beats: {},
    });
    const feed = snap.feeds.find(f => f.key === 'pnl-store');
    assert.strictEqual(feed.status, 'OK');
    assert.strictEqual(feed.storesTotal, subset.length);
    assert.strictEqual(feed.storesOk, subset.length);
    assert.deepStrictEqual(feed.staleStores, []);
    assert.strictEqual(snap.overall, 'GREEN');
  });
});
