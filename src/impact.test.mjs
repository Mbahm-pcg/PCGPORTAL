import { test, describe } from 'node:test';
import assert from 'node:assert';
import { haversineMiles } from './impact.mjs';

describe('haversineMiles', () => {
  test('identical points → 0', () => {
    assert.strictEqual(haversineMiles({ lat: 39.92, lng: -75.18 }, { lat: 39.92, lng: -75.18 }), 0);
  });

  test('1° of latitude ≈ 69.1 miles', () => {
    const d = haversineMiles({ lat: 40.0, lng: -75.0 }, { lat: 41.0, lng: -75.0 });
    assert.ok(Math.abs(d - 69.09) < 0.5, `expected ~69.09, got ${d}`);
  });

  test('1° of longitude at 40°N ≈ 53.0 miles', () => {
    const d = haversineMiles({ lat: 40.0, lng: -75.0 }, { lat: 40.0, lng: -76.0 });
    assert.ok(Math.abs(d - 53.0) < 0.6, `expected ~53.0, got ${d}`);
  });

  test('two points ~0.40 mi apart (0.0058° lat)', () => {
    const d = haversineMiles({ lat: 39.9200, lng: -75.1800 }, { lat: 39.9258, lng: -75.1800 });
    assert.ok(Math.abs(d - 0.40) < 0.02, `expected ~0.40, got ${d}`);
  });
});
