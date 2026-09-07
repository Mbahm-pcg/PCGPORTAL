import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyFeed, rollup } from './system-health.mjs';

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
