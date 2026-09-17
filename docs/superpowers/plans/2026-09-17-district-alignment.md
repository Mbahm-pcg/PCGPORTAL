# District Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a "District Alignment" tool inside the universal Tools hub — an editable sandbox copy of district/DM assignments, enriched with per-store net sales, an hourly busy/slow bar, and nearest-sibling distance, that never writes to the real `stores`/`users` data.

**Architecture:** A new Netlify function (`district-alignment.mjs`) owns a single new Blob (`pcg_district_alignment_v1`) holding the draft — seeded once from live data, then edited independently. Pure logic (seeding, edit reducers, metrics computation) lives in small testable lib files the function imports; the function itself is thin routing + auth. The frontend adds one new tile/tab reachable from every role's Tools hub, reusing the existing Directory table's district-grouping/coloring approach and the existing live `storeMgrName` lookup for the Manager column (the only genuinely live-from-Users piece of this view).

**Tech Stack:** Netlify Functions (`.mjs`, Node `--test` for unit tests), Netlify Blobs (`pcg-portal` store), React (`app.jsx`), existing `STORE_COORDS`/`DISTRICT_COLORS`/`storeMgrName`.

**Spec:** `docs/superpowers/specs/2026-09-17-district-alignment-design.md`

## Global Constraints

- Never write to the `stores` or `users` data from any action this feature adds — all edits target only `pcg_district_alignment_v1`.
- Edit actions (`reassignStore`, `addDm`, `removeDm`, `reset`) require server-side verification that the caller is `executive` or `it` via `requireActiveUser` — never trust a client-sent role flag.
- Reuse `DISTRICT_COLORS`, `storeMgrName`, and `pcg_hourly_history_{pc}` / `STORE_COORDS` as they already exist — do not re-implement or duplicate them.
- Permanently closed stores (`status === 'Permanently Closed'`) are excluded from this tool entirely.
- Every store shown must have `STORE_COORDS` coverage before the distance feature ships (Task 1 closes the one known gap: Hatboro).

---

### Task 1: Geocode Hatboro and close the STORE_COORDS gap

**Files:**
- Modify: `app.jsx` (the `STORE_COORDS` object, ~line 3190)

**Interfaces:**
- Produces: `STORE_COORDS["365953"]` — a `{ lat, lng }` entry usable by every later task's distance calculation.

- [ ] **Step 1: Fetch Hatboro's real coordinates from the existing geocoder**

Run (against production — this is a read-only lookup, no data changes):
```bash
curl -s -X POST https://pcg-ops.netlify.app/.netlify/functions/geocode -H "Content-Type: application/json" -d '{"address":"256 South York Road, Hatboro, PA 19040"}'
```
Expected: `{"matched":true,"lat":<number>,"lng":<number>,"matchedAddress":"..."}`. Record the returned `lat`/`lng`.

- [ ] **Step 2: Add the entry to STORE_COORDS**

Open `app.jsx`, find the `STORE_COORDS` object (search for `const STORE_COORDS = {`). Add one line using the exact values returned in Step 1 (do not guess/round beyond what the API returned):
```js
  "365953":{ lat:<value_from_step_1>,  lng:<value_from_step_1> },
```
Note: Allentown GS (345222) is deliberately NOT added — it's `status: "Permanently Closed"` and this whole feature excludes closed stores (Global Constraints), so it never needs coordinates here.

- [ ] **Step 3: Verify no duplicate/typo**

Run: `grep -c '"365953":{ lat' app.jsx`
Expected: `1` (exactly one entry, not two).

- [ ] **Step 4: Rebuild to confirm no syntax error**

Run: `npm run build`
Expected: builds cleanly, no esbuild errors.

- [ ] **Step 5: Commit**

```bash
git add app.jsx
git commit -m "Add Hatboro to STORE_COORDS (closes the one gap for District Alignment's distance calc)"
```

---

### Task 2: Seeding + get/reset — district-alignment.mjs backend, part 1

**Files:**
- Create: `netlify/functions/district-alignment-lib/seed.mjs`
- Create: `netlify/functions/district-alignment-lib/seed.test.mjs`
- Create: `netlify/functions/district-alignment.mjs`
- Modify: `package.json` (test script glob)

**Interfaces:**
- Produces: `buildSeedFromLive(stores)` — pure function, `stores` is the same shape as the app's `STORES_SEED`/live `stores` array (each item has at least `pc`, `district`, `dmName`, `dmEmail`, `status`). Returns:
  ```js
  {
    stores: { [pc]: { district: number|null } },
    dms: [{ id: string, name: string, email: string, district: number }],
    seededFromLiveAt: string, // ISO timestamp
  }
  ```
  Permanently-closed stores are excluded from `stores`. `dms` has one entry per distinct district number found among the included stores, using that district's first store's `dmName`/`dmEmail` (they're the same across a district in the live data).
- Produces (in `district-alignment.mjs`): `action: 'get'` and `action: 'reset'` POST actions. `get` returns the draft (seeding it first if absent). `reset` (exec/IT only) overwrites the draft with a fresh seed.
- Consumes (later tasks add actions to this same file): the blob key `pcg_district_alignment_v1`, and the exported `buildSeedFromLive`.

- [ ] **Step 1: Write the failing test for buildSeedFromLive**

Create `netlify/functions/district-alignment-lib/seed.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'netlify/functions/district-alignment-lib/seed.test.mjs'`
Expected: FAIL — `Cannot find module './seed.mjs'` (file doesn't exist yet).

- [ ] **Step 3: Write seed.mjs**

Create `netlify/functions/district-alignment-lib/seed.mjs`:
```js
// district-alignment-lib/seed.mjs — pure seeding logic for the District
// Alignment sandbox draft. Never touches live stores/users data itself;
// it only reads a plain array shaped like it and returns a fresh draft
// object for the caller to persist.

export function buildSeedFromLive(stores) {
  const active = (stores || []).filter(s => s.status !== 'Permanently Closed');

  const draftStores = {};
  active.forEach(s => {
    draftStores[s.pc] = { district: s.district ?? null };
  });

  const byDistrict = new Map();
  active.forEach(s => {
    if (s.district == null) return;
    if (!byDistrict.has(s.district)) {
      byDistrict.set(s.district, { name: s.dmName || '', email: s.dmEmail || '' });
    }
  });
  const dms = Array.from(byDistrict.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([district, info]) => ({
      id: `dm_${district}`,
      name: info.name,
      email: info.email,
      district,
    }));

  return {
    stores: draftStores,
    dms,
    seededFromLiveAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'netlify/functions/district-alignment-lib/seed.test.mjs'`
Expected: all 6 tests PASS.

- [ ] **Step 5: Add the new lib's test glob to package.json**

In `package.json`, find the `"test"` script and add `'netlify/functions/district-alignment-lib/*.test.mjs'` to the list of globs (append it after the existing `'netlify/functions/project-photos-lib/*.test.mjs'` entry, following the same quoting style).

- [ ] **Step 6: Run the full test suite to confirm the new glob works and nothing else broke**

Run: `npm test`
Expected: existing suites still pass, plus the 6 new seed.mjs tests appear and pass.

- [ ] **Step 7: Write district-alignment.mjs with get + reset actions**

Create `netlify/functions/district-alignment.mjs`:
```js
// PCG Portal — District Alignment sandbox. Holds a draft copy of district/DM
// assignments, completely separate from the real `stores`/`users` data — see
// docs/superpowers/specs/2026-09-17-district-alignment-design.md. Editing
// actions (added in a later task) are exec/IT only; `get` is open to any
// signed-in user (the whole point is everyone can view it).
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { buildSeedFromLive } from './district-alignment-lib/seed.mjs';

const BLOB_KEY = 'pcg_district_alignment_v1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

function blobStore() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

async function loadDraft() {
  const wrapped = await blobStore().get(BLOB_KEY, { type: 'json' });
  return wrapped?.data || null;
}
async function saveDraft(draft) {
  await blobStore().setJSON(BLOB_KEY, { savedAt: new Date().toISOString(), data: draft });
}

function isFullAdminClaims(claims) {
  return !!claims && (claims.userType === 'executive' || claims.userType === 'it');
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (!action) return json(400, { error: 'Missing action' });

  const eventShim = {
    headers: {
      authorization: request.headers.get('authorization') || '',
      cookie: request.headers.get('cookie') || '',
    },
  };

  try {
    const sql = db();
    const claims = await requireActiveUser(eventShim, sql);
    if (!claims) return json(401, { error: 'Sign in required' });

    if (action === 'get') {
      let draft = await loadDraft();
      if (!draft) {
        if (!Array.isArray(payload.liveStores)) {
          return json(400, { error: 'No draft exists yet — first call must include liveStores to seed from' });
        }
        draft = buildSeedFromLive(payload.liveStores);
        await saveDraft(draft);
      }
      return json(200, { ok: true, draft });
    }

    if (action === 'reset') {
      if (!isFullAdminClaims(claims)) return json(403, { error: 'Exec/IT only' });
      if (!Array.isArray(payload.liveStores)) return json(400, { error: 'Missing liveStores' });
      const draft = buildSeedFromLive(payload.liveStores);
      await saveDraft(draft);
      return json(200, { ok: true, draft });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('district-alignment.mjs error:', err);
    return json(500, { error: err.message });
  }
};
```

- [ ] **Step 8: Manually verify get seeds correctly on a preview deploy**

After deploying to a Netlify preview (not production yet — later tasks still need to land first), run:
```bash
curl -s -X POST https://<preview-url>/.netlify/functions/district-alignment -H "Content-Type: application/json" -d '{"action":"get","liveStores":[{"pc":"339616","district":1,"dmName":"Taylor Cormier","dmEmail":"taylor@peoplecapitalgroup.com","status":"Open"}]}'
```
Expected: `{"ok":true,"draft":{"stores":{"339616":{"district":1}},"dms":[{"id":"dm_1","name":"Taylor Cormier","email":"taylor@peoplecapitalgroup.com","district":1}],"seededFromLiveAt":"..."}}`. This step requires a real deploy; if none is available yet at review time, note it as deferred to the final whole-branch verification instead of blocking this task.

- [ ] **Step 9: Commit**

```bash
git add netlify/functions/district-alignment-lib/seed.mjs netlify/functions/district-alignment-lib/seed.test.mjs netlify/functions/district-alignment.mjs package.json
git commit -m "Add District Alignment backend: seed-from-live + get/reset actions"
```

---

### Task 3: Edit reducers — reassignStore/addDm/removeDm

**Files:**
- Create: `netlify/functions/district-alignment-lib/reducers.mjs`
- Create: `netlify/functions/district-alignment-lib/reducers.test.mjs`
- Modify: `netlify/functions/district-alignment.mjs` (add three actions)

**Interfaces:**
- Consumes: the draft shape produced by `buildSeedFromLive` (Task 2) — `{ stores: {[pc]: {district}}, dms: [{id,name,email,district}], seededFromLiveAt }`.
- Produces: `applyReassignStore(draft, pc, district)`, `applyAddDm(draft, { name, email, district })`, `applyRemoveDm(draft, dmId)` — each a pure function returning a **new** draft object (no mutation of the input), for `district-alignment.mjs` to call and then persist via `saveDraft`.

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/district-alignment-lib/reducers.test.mjs`:
```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'netlify/functions/district-alignment-lib/reducers.test.mjs'`
Expected: FAIL — `Cannot find module './reducers.mjs'`.

- [ ] **Step 3: Write reducers.mjs**

Create `netlify/functions/district-alignment-lib/reducers.mjs`:
```js
// district-alignment-lib/reducers.mjs — pure edit operations on a District
// Alignment draft. Each function returns a NEW draft; none mutate their
// input, so the caller (district-alignment.mjs) can safely pass the
// in-memory draft it just loaded without worrying about aliasing.

export function applyReassignStore(draft, pc, district) {
  return {
    ...draft,
    stores: {
      ...draft.stores,
      [pc]: { ...(draft.stores[pc] || {}), district },
    },
  };
}

export function applyAddDm(draft, { name, email, district }) {
  if (draft.dms.some(d => d.district === district)) {
    throw new Error(`District ${district} already has a DM in this draft`);
  }
  const id = `dm_${district}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    ...draft,
    dms: [...draft.dms, { id, name, email, district }],
  };
}

export function applyRemoveDm(draft, dmId) {
  return {
    ...draft,
    dms: draft.dms.filter(d => d.id !== dmId),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'netlify/functions/district-alignment-lib/reducers.test.mjs'`
Expected: all 8 tests PASS.

- [ ] **Step 5: Wire the three actions into district-alignment.mjs**

In `netlify/functions/district-alignment.mjs`, add the import:
```js
import { applyReassignStore, applyAddDm, applyRemoveDm } from './district-alignment-lib/reducers.mjs';
```
Then add these three blocks right after the existing `reset` action block (before the final `return json(400, ...)`):
```js
    if (action === 'reassignStore') {
      if (!isFullAdminClaims(claims)) return json(403, { error: 'Exec/IT only' });
      const { pc, district } = payload;
      if (!pc || !Number.isFinite(Number(district))) return json(400, { error: 'Missing pc or district' });
      const draft = await loadDraft();
      if (!draft) return json(404, { error: 'No draft exists yet — call action:get first' });
      const next = applyReassignStore(draft, String(pc), Number(district));
      await saveDraft(next);
      return json(200, { ok: true, draft: next });
    }

    if (action === 'addDm') {
      if (!isFullAdminClaims(claims)) return json(403, { error: 'Exec/IT only' });
      const { name, email, district } = payload;
      if (!name || !Number.isFinite(Number(district))) return json(400, { error: 'Missing name or district' });
      const draft = await loadDraft();
      if (!draft) return json(404, { error: 'No draft exists yet — call action:get first' });
      let next;
      try {
        next = applyAddDm(draft, { name, email: email || '', district: Number(district) });
      } catch (e) {
        return json(409, { error: e.message });
      }
      await saveDraft(next);
      return json(200, { ok: true, draft: next });
    }

    if (action === 'removeDm') {
      if (!isFullAdminClaims(claims)) return json(403, { error: 'Exec/IT only' });
      const { dmId } = payload;
      if (!dmId) return json(400, { error: 'Missing dmId' });
      const draft = await loadDraft();
      if (!draft) return json(404, { error: 'No draft exists yet — call action:get first' });
      const next = applyRemoveDm(draft, dmId);
      await saveDraft(next);
      return json(200, { ok: true, draft: next });
    }

```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all suites pass, including the 8 new reducer tests.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/district-alignment-lib/reducers.mjs netlify/functions/district-alignment-lib/reducers.test.mjs netlify/functions/district-alignment.mjs
git commit -m "Add District Alignment edit actions: reassignStore, addDm, removeDm (exec/IT only)"
```

---

### Task 4: Metrics — net sales snapshot + 7-day hourly average

**Files:**
- Create: `netlify/functions/district-alignment-lib/metrics.mjs`
- Create: `netlify/functions/district-alignment-lib/metrics.test.mjs`
- Modify: `netlify/functions/district-alignment.mjs` (add `metrics` action)

**Interfaces:**
- Produces: `computeStoreMetrics(historyEntries)` — pure function. `historyEntries` is the array already stored at `pcg_hourly_history_{pc}` (newest-first, each `{ date, hours: [{h, sales, count, ...}], ... }`, per `pulse-hourly-snapshot.mjs`'s existing `appendSnapshot`). Returns:
  ```js
  {
    netSales: number | null,      // sum of hours[].sales for entries[0], or null if no entries
    netSalesDate: string | null,  // entries[0].date, or null
    hourlyAvg: [{ h: number, avgSales: number }], // averaged over up to 7 newest entries actually present
  }
  ```
- Produces (in `district-alignment.mjs`): `action: 'metrics'` — `{ pcs: string[] }` in, `{ ok: true, metrics: { [pc]: <computeStoreMetrics result> } }` out. Open to any signed-in user (matches "everyone can view").

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/district-alignment-lib/metrics.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStoreMetrics } from './metrics.mjs';

function makeDay(date, hourSales) {
  return { date, hours: hourSales.map(([h, sales]) => ({ h, sales, count: 1 })) };
}

test('computeStoreMetrics: no history returns nulls and an empty hourly average', () => {
  const result = computeStoreMetrics([]);
  assert.equal(result.netSales, null);
  assert.equal(result.netSalesDate, null);
  assert.deepEqual(result.hourlyAvg, []);
});

test('computeStoreMetrics: netSales is the sum of the newest entry\'s hourly sales', () => {
  const history = [
    makeDay('2026-09-16', [[9, 100], [10, 150]]),
    makeDay('2026-09-15', [[9, 50], [10, 50]]),
  ];
  const result = computeStoreMetrics(history);
  assert.equal(result.netSales, 250);
  assert.equal(result.netSalesDate, '2026-09-16');
});

test('computeStoreMetrics: hourlyAvg averages the same hour across days present', () => {
  const history = [
    makeDay('2026-09-16', [[9, 100]]),
    makeDay('2026-09-15', [[9, 50]]),
  ];
  const result = computeStoreMetrics(history);
  const hour9 = result.hourlyAvg.find(h => h.h === 9);
  assert.equal(hour9.avgSales, 75);
});

test('computeStoreMetrics: only averages over the newest 7 entries, ignoring older history', () => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push(makeDay(`2026-09-${String(16 - i).padStart(2, '0')}`, [[9, i === 9 ? 10000 : 10]]));
  }
  // The 10th-newest entry (index 9) has an outlier value that must NOT be included.
  const result = computeStoreMetrics(history);
  const hour9 = result.hourlyAvg.find(h => h.h === 9);
  assert.equal(hour9.avgSales, 10); // all 7 newest entries have sales=10, outlier excluded
});

test('computeStoreMetrics: fewer than 7 days available still averages correctly over what exists', () => {
  const history = [makeDay('2026-09-16', [[9, 30]]), makeDay('2026-09-15', [[9, 60]])];
  const result = computeStoreMetrics(history);
  const hour9 = result.hourlyAvg.find(h => h.h === 9);
  assert.equal(hour9.avgSales, 45);
});

test('computeStoreMetrics: hours only present on some days still appear, averaged only over days that had them', () => {
  const history = [
    makeDay('2026-09-16', [[9, 100], [20, 40]]),
    makeDay('2026-09-15', [[9, 100]]), // no hour 20 this day
  ];
  const result = computeStoreMetrics(history);
  const hour20 = result.hourlyAvg.find(h => h.h === 20);
  assert.equal(hour20.avgSales, 40); // averaged only over the 1 day it appeared
});

test('computeStoreMetrics: hourlyAvg is sorted by hour ascending', () => {
  const history = [makeDay('2026-09-16', [[14, 1], [9, 1], [20, 1]])];
  const result = computeStoreMetrics(history);
  assert.deepEqual(result.hourlyAvg.map(h => h.h), [9, 14, 20]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test 'netlify/functions/district-alignment-lib/metrics.test.mjs'`
Expected: FAIL — `Cannot find module './metrics.mjs'`.

- [ ] **Step 3: Write metrics.mjs**

Create `netlify/functions/district-alignment-lib/metrics.mjs`:
```js
// district-alignment-lib/metrics.mjs — turns a store's existing
// pcg_hourly_history_{pc} array (written nightly by pulse-hourly-snapshot.mjs)
// into the two figures District Alignment shows: a net-sales snapshot (most
// recent day) and a 7-day-averaged hourly busy/slow profile. Reads only —
// never writes back to the history blob.

const MAX_DAYS = 7;

export function computeStoreMetrics(historyEntries) {
  const entries = Array.isArray(historyEntries) ? historyEntries : [];
  if (entries.length === 0) {
    return { netSales: null, netSalesDate: null, hourlyAvg: [] };
  }

  const newest = entries[0];
  const netSales = (newest.hours || []).reduce((sum, h) => sum + (h.sales || 0), 0);
  const netSalesDate = newest.date;

  const window = entries.slice(0, MAX_DAYS);
  const sumByHour = new Map(); // h -> { total, count }
  window.forEach(day => {
    (day.hours || []).forEach(h => {
      const bucket = sumByHour.get(h.h) || { total: 0, count: 0 };
      bucket.total += h.sales || 0;
      bucket.count += 1;
      sumByHour.set(h.h, bucket);
    });
  });

  const hourlyAvg = Array.from(sumByHour.entries())
    .map(([h, { total, count }]) => ({ h, avgSales: Math.round((total / count) * 100) / 100 }))
    .sort((a, b) => a.h - b.h);

  return { netSales: Math.round(netSales * 100) / 100, netSalesDate, hourlyAvg };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test 'netlify/functions/district-alignment-lib/metrics.test.mjs'`
Expected: all 7 tests PASS.

- [ ] **Step 5: Wire the metrics action into district-alignment.mjs**

Add the import:
```js
import { cacheLoad } from './analyst-lib/analyst-cache.mjs';
import { computeStoreMetrics } from './district-alignment-lib/metrics.mjs';
```
Add this action block (any signed-in user — no `isFullAdminClaims` check — right after the `get` action block):
```js
    if (action === 'metrics') {
      const pcs = Array.isArray(payload.pcs) ? payload.pcs.map(String) : [];
      if (pcs.length === 0) return json(400, { error: 'Missing pcs array' });
      const results = await Promise.all(pcs.map(async pc => {
        const history = await cacheLoad(`pcg_hourly_history_${pc}`);
        return [pc, computeStoreMetrics(history)];
      }));
      return json(200, { ok: true, metrics: Object.fromEntries(results) });
    }

```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all suites pass, including the 7 new metrics tests.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/district-alignment-lib/metrics.mjs netlify/functions/district-alignment-lib/metrics.test.mjs netlify/functions/district-alignment.mjs
git commit -m "Add District Alignment metrics action: net sales snapshot + 7-day hourly average"
```

---

### Task 5: Wire the Tools hub tile and per-role tab access

**Files:**
- Modify: `app.jsx` (`computeRoleTabs`, `HUB_SUBITEMS`, the `tab === "tools-hub"` render block, the tab description list)

**Interfaces:**
- Consumes: the `tools-hub` tab and `toolsTiles` array already scaffolded (v20.87–20.90 work).
- Produces: a valid `tab === "district-alignment"` route id recognized by `tabsForUser` for every role, and a real tile inside the Tools hub page linking to it. `DistrictAlignmentTool` (Task 6) is the component this route renders.

- [ ] **Step 1: Add "district-alignment" to every role's computeRoleTabs branch**

In `app.jsx`, find `computeRoleTabs` (search `const computeRoleTabs = (user) => {`). In each of these branches, add a `district-alignment` entry immediately after the `tools-hub` entry already added there (executive/it, office_staff, auditor, dm, manager, construction, vendor, maintenance):
```js
    { id: "district-alignment", label: "District Alignment", icon: (c) => ICONS.tools(c) },
```
(Reusing the `tools` icon is fine — this tab is only ever reached via the Tools hub tile, never as its own separate sidebar/launcher button, so it needs a valid icon reference but nothing distinct will render it standalone.)

- [ ] **Step 2: Register it as a Tools-hub sub-item so the Access Matrix can list it and the launcher dedup (Task from 2026-09-16) correctly hides it as a standalone duplicate**

In `HUB_SUBITEMS` (search `const HUB_SUBITEMS = {`), add a new top-level entry:
```js
  'tools-hub': [
    { id: 'district-alignment', label: 'District Alignment' },
  ],
```

- [ ] **Step 3: Extend the mobile launcher's dedup hub list to include tools-hub**

In `MobileAppLauncher` (search `['ops-hub', 'team-hub', 'system-hub'].forEach(hubId => {`), add `'tools-hub'` to that array:
```js
  ['ops-hub', 'team-hub', 'system-hub', 'tools-hub'].forEach(hubId => {
```

- [ ] **Step 4: Add the tile inside the tools-hub render block**

Find `{tab === "tools-hub" && (() => {` (search for `const toolsTiles = [`). Replace the empty array with:
```js
            const toolsTiles = [
              { id: 'district-alignment', name: 'District Alignment', sub: 'Draft district/DM groupings, sales snapshots, and store spacing — a sandbox that never touches real Locations data.', show: true, icon: <><path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></> },
            ].filter(t => t.show);
```
Then update the empty-state check right below it from `toolsTiles.length === 0` to stay as-is (it already correctly hides the placeholder once `toolsTiles` is non-empty).

- [ ] **Step 5: Add the routing line and description**

Find the routing switch section (search `{tab === "tools-hub" && (() => {` again, look at what comes after its closing `})()}`) and add, alongside the other `{tab === "..." && ...}` lines:
```jsx
          {tab === "district-alignment" && <DistrictAlignmentTool user={user} th={th} stores={stores} users={users} />}
```
And in the tab-description list (search `{tab === "tools-hub" && "Handy tools, available to everyone."}`), add directly after it:
```jsx
                {tab === "district-alignment" && "A sandbox for planning district groupings — separate from the real Locations data."}
```

- [ ] **Step 6: Rebuild to confirm no syntax error (DistrictAlignmentTool doesn't exist yet — expect a ReferenceError at runtime, not a build error)**

Run: `npm run build`
Expected: esbuild succeeds (it doesn't type-check JSX component existence; this only fails if `DistrictAlignmentTool` were referenced with invalid syntax, which it isn't — it's just an undefined identifier until Task 6 adds it, which would only surface when actually navigating to that tab at runtime).

- [ ] **Step 7: Commit**

```bash
git add app.jsx
git commit -m "Wire District Alignment tile and tab routing into the Tools hub (component lands next task)"
```

---

### Task 6: DistrictAlignmentTool — view mode

**Files:**
- Modify: `app.jsx` (add the `DistrictAlignmentTool` component, near `ProjectGalleryTab`/`AdminLocations` for locality with related code)

**Interfaces:**
- Consumes: `computeStoreMetrics`'s shape via the backend `metrics` action response; `buildSeedFromLive`'s draft shape via the backend `get` action response; `STORE_COORDS`, `DISTRICT_COLORS`, `storeMgrName`, `districtTint` (all already defined in `app.jsx`).
- Produces: the `DistrictAlignmentTool` component referenced by Task 5's routing line. Signature: `function DistrictAlignmentTool({ user, th, stores, users })`.

- [ ] **Step 1: Add a Haversine distance helper near STORE_COORDS**

In `app.jsx`, right after the `STORE_COORDS` object's closing `};`, add:
```js
// Great-circle distance in miles between two STORE_COORDS points.
function haversineMiles(a, b) {
  if (!a || !b) return null;
  const toRad = d => d * Math.PI / 180;
  const R = 3958.8; // Earth radius, miles
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}
```

- [ ] **Step 2: Add the DistrictAlignmentTool component**

Add this component in `app.jsx` (a good spot is right after `AdminLocations` and before `AdminDistricts`, since it's conceptually adjacent):
```jsx
function DistrictAlignmentTool({ user, th, stores, users }) {
  const [draft, setDraft] = React.useState(null);
  const [metrics, setMetrics] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const isAdmin = isFullAdmin(user);

  const activeStores = React.useMemo(
    () => (stores || []).filter(s => s.status !== 'Permanently Closed'),
    [stores]
  );

  const loadDraft = React.useCallback(() => {
    setLoading(true);
    setError('');
    fetch('/.netlify/functions/district-alignment', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'get', liveStores: activeStores }),
    })
      .then(r => r.json())
      .then(j => {
        if (!j?.ok) { setError(j?.error || 'Could not load District Alignment.'); return; }
        setDraft(j.draft);
      })
      .catch(() => setError('Network error — please try again.'))
      .finally(() => setLoading(false));
  }, [activeStores]);

  React.useEffect(() => { loadDraft(); }, [loadDraft]);

  React.useEffect(() => {
    if (activeStores.length === 0) return;
    fetch('/.netlify/functions/district-alignment', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'metrics', pcs: activeStores.map(s => s.pc) }),
    })
      .then(r => r.json())
      .then(j => { if (j?.ok) setMetrics(j.metrics); })
      .catch(() => {});
  }, [activeStores]);

  if (loading) return <div style={{ padding: '2rem', color: th.muted }}>Loading District Alignment…</div>;
  if (error) return <div style={{ padding: '2rem', color: '#ef4444' }}>{error}</div>;
  if (!draft) return null;

  const storeByPc = Object.fromEntries(activeStores.map(s => [s.pc, s]));
  const byDistrict = {};
  Object.entries(draft.stores).forEach(([pc, { district }]) => {
    const d = district ?? 0;
    (byDistrict[d] ||= []).push(pc);
  });
  const districtNums = Object.keys(byDistrict).map(Number).sort((a, b) => a - b);

  const nearestSiblingMiles = (pc, districtPcs) => {
    const coord = STORE_COORDS[pc];
    if (!coord) return null;
    let min = null;
    districtPcs.forEach(otherPc => {
      if (otherPc === pc) return;
      const d = haversineMiles(coord, STORE_COORDS[otherPc]);
      if (d != null && (min == null || d < min)) min = d;
    });
    return min;
  };

  const districtSpread = (districtPcs) => {
    const coords = districtPcs.map(pc => STORE_COORDS[pc]).filter(Boolean);
    if (coords.length < 2) return { avg: null, max: null };
    let total = 0, count = 0, max = 0;
    for (let i = 0; i < coords.length; i++) {
      for (let j = i + 1; j < coords.length; j++) {
        const d = haversineMiles(coords[i], coords[j]);
        total += d; count++; if (d > max) max = d;
      }
    }
    return { avg: Math.round((total / count) * 10) / 10, max: Math.round(max * 10) / 10 };
  };

  const fmtMoney = n => n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtHour = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toLocaleTimeString(undefined, { hour: 'numeric' }); };
  const assetCombined = s => `${s.isNextGen ? 'NXT-' : ''}${s.baseAsset || '—'}`;

  const thStyle = { textAlign: 'left', padding: '0.4rem 0.6rem', fontSize: '0.62rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap', color: th.muted };
  const tdStyle = { padding: '0.4rem 0.6rem', fontSize: '0.76rem', color: th.text, borderBottom: `1px solid ${th.cardBorder}`, verticalAlign: 'top' };

  // 11 columns total: 8 identity/contact columns (matching the Directory
  // view's own layout exactly, per spec) + 3 new metrics columns. The
  // district header row spans 8 + 3 to stay aligned under both blocks.
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ fontSize: '0.78rem', color: th.muted }}>
          Draft seeded {draft.seededFromLiveAt ? new Date(draft.seededFromLiveAt).toLocaleString() : '—'}. Editing here never changes the real Locations data.
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1400 }}>
          <thead>
            <tr style={{ background: th.card2 }}>
              {['PC#', 'Paycor Client ID', 'Legal Name', 'Property Name', 'Address', 'Asset Type', 'Manager', 'Store Email', 'Net Sales', 'Busiest Hours', 'Nearest Sibling'].map(h => (
                <th key={h} style={thStyle}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {districtNums.map(dNum => {
              const pcs = byDistrict[dNum];
              const dm = draft.dms.find(d => d.district === dNum);
              const dc = DISTRICT_COLORS[dNum] || { bg: th.card3, text: th.text };
              const spread = districtSpread(pcs);
              return (
                <React.Fragment key={dNum}>
                  <tr style={{ background: dc.bg }}>
                    <td colSpan={8} style={{ padding: '0.4rem 0.6rem', fontSize: '0.78rem', fontWeight: 800, color: dc.text }}>
                      {dNum ? `District #${dNum}${dm ? ' ' + dm.name : ' — Unassigned'}` : 'Unassigned'}
                    </td>
                    <td colSpan={3} style={{ padding: '0.4rem 0.6rem', fontSize: '0.7rem', fontWeight: 700, color: dc.text, textAlign: 'right' }}>
                      {spread.avg != null ? `spread: ${spread.avg} mi avg, ${spread.max} mi max` : ''}
                    </td>
                  </tr>
                  {pcs.map(pc => {
                    const s = storeByPc[pc];
                    if (!s) return null;
                    const m = metrics[pc] || {};
                    const nearest = nearestSiblingMiles(pc, pcs);
                    const maxAvg = Math.max(1, ...((m.hourlyAvg || []).map(h => h.avgSales)));
                    return (
                      <tr key={pc} style={{ background: districtTint(dc.bg) }}>
                        <td style={{ ...tdStyle, color: O, fontWeight: 700 }}>{pc}</td>
                        <td style={tdStyle}>{s.paycor || '—'}</td>
                        <td style={tdStyle}>{s.legal || '—'}</td>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>{s.name || '—'}</td>
                        <td style={tdStyle}>{[s.address, s.city, s.state].filter(Boolean).join(', ')}</td>
                        <td style={tdStyle}>{assetCombined(s)}</td>
                        <td style={tdStyle}>{storeMgrName(s, users) || 'Unassigned'}</td>
                        <td style={tdStyle}>{s.email || '—'}</td>
                        <td style={tdStyle}>
                          {fmtMoney(m.netSales)}
                          {m.netSalesDate && <div style={{ fontSize: '0.62rem', color: th.muted }}>{m.netSalesDate}</div>}
                        </td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 28 }}>
                            {(m.hourlyAvg || []).map(h => (
                              <div key={h.h} title={`${fmtHour(h.h)}: ${fmtMoney(h.avgSales)}`}
                                style={{ width: 5, height: Math.max(2, (h.avgSales / maxAvg) * 28), background: O, borderRadius: 1 }} />
                            ))}
                          </div>
                        </td>
                        <td style={tdStyle}>{nearest != null ? `${Math.round(nearest * 10) / 10} mi` : '—'}</td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Rebuild**

Run: `npm run build`
Expected: builds cleanly.

- [ ] **Step 4: Manual smoke test on a preview deploy**

Deploy to a Netlify preview, sign in, navigate to Tools → District Alignment. Expected: the district-grouped table renders with net sales, a busy-hours bar per store (hover shows a tooltip via the native `title` attribute), and nearest-sibling distances. No console errors.

- [ ] **Step 5: Commit**

```bash
git add app.jsx
git commit -m "Add DistrictAlignmentTool view: draft table with net sales, busy-hours bar, and store distance"
```

---

### Task 7: Edit controls for exec/IT — reassign, add/remove DM, reset

**Files:**
- Modify: `app.jsx` (`DistrictAlignmentTool`)

**Interfaces:**
- Consumes: `reassignStore`, `addDm`, `removeDm`, `reset` actions from Task 3/2.
- Produces: a fully interactive tool for exec/IT; unchanged read-only view for everyone else.

- [ ] **Step 1: Add edit state and action-calling helpers**

Inside `DistrictAlignmentTool`, right after the `loadDraft` callback, add:
```jsx
  const [saving, setSaving] = React.useState(false);
  const [showAddDm, setShowAddDm] = React.useState(null); // district number the "add DM" form is open for, or null
  const [newDmName, setNewDmName] = React.useState('');
  const [newDmEmail, setNewDmEmail] = React.useState('');

  const callAction = (body) => {
    setSaving(true);
    return fetch('/.netlify/functions/district-alignment', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(j => {
        if (!j?.ok) { setError(j?.error || 'That action failed — please try again.'); return; }
        setDraft(j.draft);
        setError('');
      })
      .catch(() => setError('Network error — please try again.'))
      .finally(() => setSaving(false));
  };

  const reassignStore = (pc, district) => callAction({ action: 'reassignStore', pc, district });
  const addDm = (district) => {
    if (!newDmName.trim()) return;
    callAction({ action: 'addDm', name: newDmName.trim(), email: newDmEmail.trim(), district }).then(() => {
      setShowAddDm(null); setNewDmName(''); setNewDmEmail('');
    });
  };
  const removeDm = (dmId) => { if (window.confirm('Remove this DM from the draft? Their stores will show as Unassigned until reassigned.')) callAction({ action: 'removeDm', dmId }); };
  const resetToLive = () => {
    if (!window.confirm('Reset the draft to match the real Locations data? Any unsaved sandbox changes will be lost.')) return;
    callAction({ action: 'reset', liveStores: activeStores });
  };
```

- [ ] **Step 2: Add the Reset button, admin-only, near the top of the render**

Replace the header `<div>` from Task 6 Step 2 with:
```jsx
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ fontSize: '0.78rem', color: th.muted }}>
          Draft seeded {draft.seededFromLiveAt ? new Date(draft.seededFromLiveAt).toLocaleString() : '—'}. Editing here never changes the real Locations data.
        </div>
        {isAdmin && (
          <button onClick={resetToLive} disabled={saving} style={{ ...btn(th, { background: th.card2, color: th.text, border: `1px solid ${th.cardBorder}`, fontSize: '0.72rem', opacity: saving ? 0.6 : 1 }) }}>
            ↺ Reset to live data
          </button>
        )}
      </div>
```

- [ ] **Step 3: Make district reassignment editable for admins — replace the district header row and add a district `<select>` per store row**

Replace the district header `<tr>` from Task 6 with (adds a Remove-DM / Add-DM control for admins; note `colSpan={8}` and `colSpan={3}` matching the 11-column layout from Task 6):
```jsx
                  <tr style={{ background: dc.bg }}>
                    <td colSpan={8} style={{ padding: '0.4rem 0.6rem', fontSize: '0.78rem', fontWeight: 800, color: dc.text }}>
                      {dNum ? `District #${dNum}${dm ? ' ' + dm.name : ' — Unassigned'}` : 'Unassigned'}
                      {isAdmin && dm && (
                        <button onClick={() => removeDm(dm.id)} disabled={saving} title="Remove this DM from the draft"
                          style={{ marginLeft: '0.5rem', fontSize: '0.65rem', background: 'none', border: 'none', color: dc.text, opacity: 0.7, cursor: 'pointer', textDecoration: 'underline' }}>
                          remove DM
                        </button>
                      )}
                      {isAdmin && !dm && dNum > 0 && (
                        showAddDm === dNum ? (
                          <span style={{ marginLeft: '0.5rem', display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
                            <input placeholder="Name" value={newDmName} onChange={e => setNewDmName(e.target.value)} style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: 4, border: 'none' }} />
                            <input placeholder="Email" value={newDmEmail} onChange={e => setNewDmEmail(e.target.value)} style={{ fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: 4, border: 'none' }} />
                            <button onClick={() => addDm(dNum)} disabled={saving} style={{ fontSize: '0.65rem', cursor: 'pointer' }}>Save</button>
                            <button onClick={() => setShowAddDm(null)} style={{ fontSize: '0.65rem', cursor: 'pointer' }}>Cancel</button>
                          </span>
                        ) : (
                          <button onClick={() => setShowAddDm(dNum)} style={{ marginLeft: '0.5rem', fontSize: '0.65rem', background: 'none', border: 'none', color: dc.text, opacity: 0.7, cursor: 'pointer', textDecoration: 'underline' }}>
                            + add DM
                          </button>
                        )
                      )}
                    </td>
                    <td colSpan={3} style={{ padding: '0.4rem 0.6rem', fontSize: '0.7rem', fontWeight: 700, color: dc.text, textAlign: 'right' }}>
                      {spread.avg != null ? `spread: ${spread.avg} mi avg, ${spread.max} mi max` : ''}
                    </td>
                  </tr>
```
Then replace the Property Name cell inside the per-store `<tr>` (Task 6's `<td style={{ ...tdStyle, fontWeight: 700 }}>{s.name || '—'}</td>` line) with a version that adds a district reassignment dropdown for admins, right below the name:
```jsx
                        <td style={{ ...tdStyle, fontWeight: 700 }}>
                          {s.name || '—'}
                          {isAdmin && (
                            <select value={dNum} disabled={saving} onChange={e => reassignStore(pc, Number(e.target.value))}
                              style={{ display: 'block', marginTop: '0.25rem', fontSize: '0.68rem', padding: '0.1rem 0.3rem' }}>
                              {districtNums.map(n => <option key={n} value={n}>{n ? `District ${n}` : 'Unassigned'}</option>)}
                            </select>
                          )}
                        </td>
```

- [ ] **Step 4: Rebuild**

Run: `npm run build`
Expected: builds cleanly.

- [ ] **Step 5: Manual verification on a preview deploy**

As an exec/IT test account: reassign a store to a different district via the dropdown and confirm the table updates and the district's spread stat recalculates; add a DM to an unassigned district; remove a DM and confirm its stores show "— Unassigned"; click Reset to live data and confirm it reverts. As a non-admin test account (e.g., manager): confirm the table is fully visible but none of the edit controls (dropdown, remove/add DM, reset button) render.

Separately, confirm via direct API call that editing never touched real data:
```bash
curl -s -X POST https://<preview-url>/.netlify/functions/storage -H "Content-Type: application/json" -d '{"action":"load","key":"pcg_stores_v1"}'
```
Expected: the real `stores` blob's `district` values for whatever store you reassigned in the draft are **unchanged** from before the test.

- [ ] **Step 6: Commit**

```bash
git add app.jsx
git commit -m "Add District Alignment edit controls: reassign store, add/remove DM, reset to live (exec/IT only)"
```
