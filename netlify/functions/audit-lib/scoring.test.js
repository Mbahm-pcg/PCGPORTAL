const { test, describe } = require('node:test');
const assert = require('node:assert');
const { computeScore, bandFor } = require('./scoring');
const { TEMPLATE_V1 } = require('./template');

const allPass = () => {
  const r = {};
  for (const s of TEMPLATE_V1.sections) for (const i of s.items) r[i.id] = 'pass';
  return r;
};

describe('computeScore', () => {
  test('all pass → 100, band excellent, no cap', () => {
    const out = computeScore(TEMPLATE_V1, allPass());
    assert.strictEqual(out.score, 100);
    assert.strictEqual(out.band, 'excellent');
    assert.strictEqual(out.cappedByCritical, false);
    for (const s of TEMPLATE_V1.sections) assert.strictEqual(out.sectionScores[s.id], 100);
  });
  test('non-critical fail deducts weighted points only', () => {
    const r = allPass();
    r.bg_uniform = 'fail'; // 3 pts of brand_guest, non-critical
    const out = computeScore(TEMPLATE_V1, r);
    assert.ok(out.score < 100 && out.score > 90);
    assert.strictEqual(out.cappedByCritical, false);
    assert.strictEqual(out.sectionScores.food_safety, 100);
  });
  test('critical fail caps at 69 even with high raw score', () => {
    const r = allPass();
    r.fs_cold_chain = 'fail';
    const out = computeScore(TEMPLATE_V1, r);
    assert.ok(out.score <= 69);
    assert.strictEqual(out.cappedByCritical, true);
    assert.strictEqual(out.band, 'fail');
  });
  test('na items excluded from denominator', () => {
    const r = allPass();
    r.fa_drive_thru = 'na'; // store without drive-thru
    const out = computeScore(TEMPLATE_V1, r);
    assert.strictEqual(out.score, 100);
  });
  test('all-na section scores null and weight redistributes', () => {
    const r = allPass();
    for (const i of TEMPLATE_V1.sections.find(s => s.id === 'facility').items) r[i.id] = 'na';
    const out = computeScore(TEMPLATE_V1, r);
    assert.strictEqual(out.sectionScores.facility, null);
    assert.strictEqual(out.score, 100);
  });
  test('missing result counts as fail', () => {
    const r = allPass();
    delete r.bg_coffee;
    const out = computeScore(TEMPLATE_V1, r);
    assert.ok(out.score < 100);
  });
});

describe('bandFor', () => {
  test('band edges', () => {
    assert.strictEqual(bandFor(90), 'excellent');
    assert.strictEqual(bandFor(89.9), 'pass');
    assert.strictEqual(bandFor(80), 'pass');
    assert.strictEqual(bandFor(79.9), 'needs_improvement');
    assert.strictEqual(bandFor(70), 'needs_improvement');
    assert.strictEqual(bandFor(69), 'fail');
  });
});
