// run.test.mjs — pure digest-grouping helpers from run.mjs (2026-09-23 flood fix).
// The I/O-heavy parts of run.mjs (Paycor/DB/blob calls) aren't unit-tested here — these
// three functions are the pure logic that decides how many sends go out per run, which is
// exactly what caused the shadow-mode inbox flood, so they're the part worth locking down.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recipientKey, buildDigestText, buildDigestCompact } from './run.mjs';

describe('recipientKey', () => {
  test('two different messages for the same account id collapse to the same key', () => {
    const a = { id: 7, name: 'Ann', email: 'ann@x.com', phone: '2155551111' };
    const b = { id: 7, name: 'Ann', email: 'ann@x.com', phone: '2155551111' };
    assert.equal(recipientKey(a), recipientKey(b));
  });

  test('synthetic no-account contacts (id: null) key by email+phone instead', () => {
    const storeA = { id: null, name: 'Store A (store email)', email: 'a@rgi.life', phone: null };
    const storeB = { id: null, name: 'Store B (store email)', email: 'b@rgi.life', phone: null };
    assert.notEqual(recipientKey(storeA), recipientKey(storeB));
  });

  test('an id always wins over a coincidentally-matching email', () => {
    const withId = { id: 3, email: 'shared@x.com', phone: null };
    const withoutId = { id: null, email: 'shared@x.com', phone: null };
    assert.notEqual(recipientKey(withId), recipientKey(withoutId));
  });
});

describe('buildDigestText', () => {
  test('a single item passes through as-is, no count header', () => {
    const items = [{ subject: 'No clock-in — Allegheny', text: 'Allegheny: no clock-in yet — Hardina M.', storeName: 'Allegheny' }];
    assert.equal(buildDigestText(items), 'Allegheny: no clock-in yet — Hardina M.');
  });

  test('multiple items get a count header and are joined, in order', () => {
    const items = [
      { text: 'Allegheny: no clock-in yet — Hardina M.', storeName: 'Allegheny' },
      { text: 'Drexel Hill: marked ABSENT — Manjot G.', storeName: 'Drexel Hill' },
    ];
    const out = buildDigestText(items);
    assert.match(out, /^2 alerts:\n\n/);
    assert.ok(out.indexOf('Allegheny') < out.indexOf('Drexel Hill'));
  });

  test('shadow mode appends "Would go to" per item', () => {
    const items = [{ text: 'Allegheny: no clock-in yet — Hardina M.', who: 'Torres Katiuska' }];
    assert.equal(buildDigestText(items, { shadow: true }), 'Allegheny: no clock-in yet — Hardina M. Would go to: Torres Katiuska.');
  });
});

describe('buildDigestCompact', () => {
  test('1-3 items are itemized in full, pipe-separated', () => {
    const items = [
      { text: 'Store A: no clock-in.', storeName: 'A' },
      { text: 'Store B: absent.', storeName: 'B' },
    ];
    assert.equal(buildDigestCompact(items), 'Store A: no clock-in. | Store B: absent.');
  });

  test('exactly 3 items is still itemized (the boundary, not yet summarized)', () => {
    const items = [
      { text: '1', storeName: 'A' }, { text: '2', storeName: 'B' }, { text: '3', storeName: 'C' },
    ];
    assert.equal(buildDigestCompact(items), '1 | 2 | 3');
  });

  test('4+ items collapse to a count + store-count summary, not the raw text', () => {
    const items = [
      { text: '1', storeName: 'A' }, { text: '2', storeName: 'B' },
      { text: '3', storeName: 'C' }, { text: '4', storeName: 'A' }, // A repeats — a real duplicate-store case
    ];
    const out = buildDigestCompact(items);
    assert.equal(out, '4 no-clock-in alerts across 3 stores. Check email or the Portal for full details.');
  });

  test('singular "store" (not "stores") when everything is at one store', () => {
    const items = [
      { text: '1', storeName: 'A' }, { text: '2', storeName: 'A' },
      { text: '3', storeName: 'A' }, { text: '4', storeName: 'A' },
    ];
    assert.match(buildDigestCompact(items), /across 1 store\. /);
  });

  test('shadow mode folds "Would go to" into the itemized (<=3) case too', () => {
    const items = [{ text: 'Store A: no clock-in.', who: 'Jane Doe', storeName: 'A' }];
    assert.equal(buildDigestCompact(items, { shadow: true }), 'Store A: no clock-in. Would go to: Jane Doe.');
  });
});
