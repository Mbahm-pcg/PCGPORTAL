import { test, describe } from 'node:test';
import assert from 'node:assert';
import { recipients } from './recipients.mjs';

// Minimal stand-in for the tagged-template `sql()` client used elsewhere in this app.
function fakeDb(rows) {
  return async () => rows;
}

describe('recipients', () => {
  test('never configured (readOverride resolves null) → every active exec/IT user', async () => {
    const db = fakeDb([{ id: 1, email: 'mike@x.com' }, { id: 2, email: 'ahmed@x.com' }]);
    const r = await recipients(db, async () => null);
    assert.deepStrictEqual(r, { pushIds: ['1', '2'], emails: ['mike@x.com', 'ahmed@x.com'] });
  });

  test('configured, non-empty override → only the saved list, not the DB query', async () => {
    const db = fakeDb([{ id: 1, email: 'mike@x.com' }, { id: 2, email: 'ahmed@x.com' }, { id: 3, email: 'chad@x.com' }]);
    const cfg = { updatedAt: '2026-09-21T17:47:03.302Z', emails: ['mike@x.com', 'ahmed@x.com'], emailOwners: [1, 96] };
    const r = await recipients(db, async () => cfg);
    assert.deepStrictEqual(r, { pushIds: ['1', '96'], emails: ['mike@x.com', 'ahmed@x.com'] });
  });

  test('configured and deliberately emptied → nobody, by design (silences the alert)', async () => {
    const db = fakeDb([{ id: 1, email: 'mike@x.com' }]);
    const cfg = { updatedAt: '2026-09-22T00:00:00.000Z', emails: [], emailOwners: [] };
    const r = await recipients(db, async () => cfg);
    assert.deepStrictEqual(r, { pushIds: [], emails: [] });
  });

  // The actual bug: an override blob read failure was previously swallowed and silently
  // treated the same as "never configured", falling back to every exec/IT user — bypassing
  // someone's deliberate narrowing of the list for that one alert.
  test('override read throws → propagates (does NOT fall back to every exec/IT user)', async () => {
    const db = fakeDb([{ id: 1, email: 'mike@x.com' }, { id: 2, email: 'ahmed@x.com' }]);
    await assert.rejects(
      () => recipients(db, async () => { throw new Error('blob store hiccup'); }),
      /blob store hiccup/
    );
  });

  test('the DB query itself throwing also propagates (no silent empty-recipient "success")', async () => {
    const db = async () => { throw new Error('db unreachable'); };
    await assert.rejects(() => recipients(db, async () => null), /db unreachable/);
  });

  test('a manually-typed email with no linked Portal account has no push id, only email', async () => {
    const db = fakeDb([]);
    const cfg = { updatedAt: '2026-09-22T00:00:00.000Z', emails: ['ops@store.com'], emailOwners: [null] };
    const r = await recipients(db, async () => cfg);
    assert.deepStrictEqual(r, { pushIds: [], emails: ['ops@store.com'] });
  });
});
