import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStoreDayReconciliation } from './tips-reconcile.mjs';

const noExclusions = () => false;

test('a genuine addition is applied even when an unrelated employee looks dropped (2026-09-29 bug fix)', () => {
  const saved = [
    { name: 'Alice', guid: 'g-alice', hours: 6 },
    { name: 'Bob', guid: 'g-bob', hours: 5 }, // will look dropped from live
  ];
  const live = [
    { name: 'Alice', guid: 'g-alice', hours: 6 }, // unchanged
    { name: 'Carol', guid: 'g-carol', hours: 4 }, // genuinely new — must be added
    // Bob absent from live fetch entirely
  ];

  const result = planStoreDayReconciliation(saved, live, noExclusions);

  assert.ok(result, 'expected something to report');
  assert.equal(result.shouldSave, true, 'a real addition must trigger a save');

  const names = result.nextCrew.map(c => c.name);
  assert.ok(names.includes('Carol'), 'Carol must be added despite Bob looking dropped in the same fetch — this is exactly the bug being fixed');
  assert.ok(names.includes('Bob'), "Bob's old hours must be preserved, never silently deleted");
  assert.ok(names.includes('Alice'));

  const bob = result.nextCrew.find(c => c.name === 'Bob');
  assert.equal(bob.hours, 5, "Bob's preserved entry must keep his original saved hours");

  const carolCorrection = result.corrections.find(c => c.employee === 'Carol');
  assert.equal(carolCorrection.applied, true);
  const bobCorrection = result.corrections.find(c => c.employee === 'Bob');
  assert.equal(bobCorrection.applied, false);
  assert.match(bobCorrection.change, /POSSIBLE DROP/);
});

test('an hour correction (late-punch settling) still applies with no drops present', () => {
  const saved = [{ name: 'Alice', guid: 'g-alice', hours: 5 }];
  const live = [{ name: 'Alice', guid: 'g-alice', hours: 6 }]; // +1h, over the 0.5h tolerance

  const result = planStoreDayReconciliation(saved, live, noExclusions);

  assert.ok(result);
  assert.equal(result.shouldSave, true);
  assert.equal(result.nextCrew.length, 1);
  assert.equal(result.nextCrew[0].hours, 6);
  assert.equal(result.corrections[0].applied, true);
  assert.match(result.corrections[0].change, /5\.00h → 6\.00h/);
});

test('a manually-excluded employee dropping from live is never reported as a possible drop', () => {
  const saved = [
    { name: 'Alice', guid: 'g-alice', hours: 6 },
    { name: 'Excluded Person', guid: 'g-excluded', hours: 5 },
  ];
  const live = [{ name: 'Alice', guid: 'g-alice', hours: 6 }];
  const isKnownExcluded = (sc) => sc.guid === 'g-excluded';

  const result = planStoreDayReconciliation(saved, live, isKnownExcluded);

  assert.equal(result, null, 'no mismatch and the only missing entry is a known, intentional exclusion — nothing to report at all');
});

test('nothing to do returns null (matches the original "continue" path)', () => {
  const saved = [{ name: 'Alice', guid: 'g-alice', hours: 6 }];
  const live = [{ name: 'Alice', guid: 'g-alice', hours: 6.2 }]; // within the 0.5h tolerance

  const result = planStoreDayReconciliation(saved, live, noExclusions);

  assert.equal(result, null);
});

test('a lone possible drop with no other real changes is reported but does not trigger a save', () => {
  const saved = [
    { name: 'Alice', guid: 'g-alice', hours: 6 },
    { name: 'Bob', guid: 'g-bob', hours: 5 },
  ];
  const live = [
    { name: 'Alice', guid: 'g-alice', hours: 6.1 }, // within tolerance, no real correction
    // Bob entirely absent — a possible drop, nothing else changed
  ];

  const result = planStoreDayReconciliation(saved, live, noExclusions);

  assert.ok(result, 'the drop itself must still be reported for the email/log');
  assert.equal(result.shouldSave, false, 'nothing real changed — must not overwrite storage just to flag an already-correctly-saved drop');
  assert.equal(result.corrections.length, 1);
  assert.equal(result.corrections[0].applied, false);
  assert.equal(result.corrections[0].employee, 'Bob');
});

test('matching falls back to name when a saved entry predates the guid field', () => {
  const saved = [{ name: 'Alice', hours: 6 }]; // no guid — pre-guid saved data
  const live = [{ name: 'Alice', guid: 'g-alice', hours: 6.2 }]; // now carries a guid, within tolerance

  const result = planStoreDayReconciliation(saved, live, noExclusions);

  assert.equal(result, null, 'name-based fallback must still match this as the same person, not a simultaneous add+drop');
});
