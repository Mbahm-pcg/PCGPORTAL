# Employee Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Postgres-backed directory of employees (Name + Paycor ID + DOB + work email), synced daily from Paycor per store, searchable by name scoped to one store — wired into the Incident Report's Subject Employee section as a type-ahead.

**Architecture:** A pure-logic module (`src/employee-directory.mjs`) merges one store's `employees` + `identifyingData` Paycor pages into upsert-ready rows. A new dedicated cron (`employee-directory-cron.mjs`) reuses `tips-report-cron-background.mjs`'s existing `callPaycorProxy`/`fetchAllEmployees` helpers (adding one sibling helper, `fetchAllIdentifyingData`) to pull both pages per store and upsert into a new `employee_directory` table. A small search function (`employee-directory.mjs`) serves the frontend's type-ahead, scoped by `storePc`.

**Tech Stack:** Neon Postgres, Netlify Functions (ESM), React (inline in `app.jsx`), Node's `node --test`.

**Spec:** `docs/superpowers/specs/2026-09-28-employee-directory-design.md`

## Global Constraints

- SSN never leaves `paycor.mjs`'s `identifyingData` mapping — nothing in this plan touches or forwards it; every consumer only ever sees `{employeeId, birthDate}`.
- Terminated employees are kept in the directory, not deleted — never filter them out of the sync, only de-prioritize in search ordering.
- Search is scoped to one store (`storePc` required) — never a network-wide query.
- No home address or phone auto-fill — confirmed absent from Paycor's `/employees` response; don't invent a field for them.
- Edit `app.jsx` only via the Edit tool (never PowerShell — corrupts UTF-8), rebuild with `npm run build` before anything is committed, bump `APP_VERSION`.
- Single commit, single push at the end — ask before pushing to prod.

---

### Task 1: Pure logic module

**Files:**
- Create: `src/employee-directory.mjs`
- Test: `src/employee-directory.test.mjs`

**Interfaces:**
- Produces: `buildDirectoryRows(employeesPage, identifyingDataPage, storePc, legalEntityId)` — consumed by Task 3's cron.

- [ ] **Step 1: Write the failing tests**

Create `src/employee-directory.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectoryRows } from './employee-directory.mjs';

const EMP = (over = {}) => ({
  id: 'guid-1', employeeNumber: '67', firstName: 'Jagrutiben', lastName: 'Patel',
  email: { type: 'Work', emailAddress: 'j@example.com' }, statusData: { status: 'Active' },
  ...over,
});

test('buildDirectoryRows: merges DOB from the identifyingData page by employeeId', () => {
  const rows = buildDirectoryRows([EMP()], [{ employeeId: 'guid-1', birthDate: '1990-01-01' }], '337839', '193888');
  assert.deepEqual(rows, [{
    paycorEmployeeId: 'guid-1', employeeNumber: '67', firstName: 'Jagrutiben', lastName: 'Patel',
    email: 'j@example.com', birthDate: '1990-01-01', status: 'Active', storePc: '337839', legalEntityId: '193888',
  }]);
});

test('buildDirectoryRows: an employee with no matching identifyingData record gets birthDate:null, not dropped', () => {
  const rows = buildDirectoryRows([EMP({ id: 'guid-2' })], [], '337839', '193888');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].birthDate, null);
});

test('buildDirectoryRows: an employees-page record with no id is dropped (can\'t key it)', () => {
  const rows = buildDirectoryRows([EMP({ id: null }), EMP()], [], '337839', '193888');
  assert.equal(rows.length, 1);
});

test('buildDirectoryRows: missing email/statusData shape degrades to null, never throws', () => {
  const rows = buildDirectoryRows([EMP({ email: null, statusData: null })], [], '337839', '193888');
  assert.equal(rows[0].email, null);
  assert.equal(rows[0].status, null);
});

test('buildDirectoryRows: empty employees page returns empty array', () => {
  assert.deepEqual(buildDirectoryRows([], [{ employeeId: 'guid-1', birthDate: '1990-01-01' }], '337839', '193888'), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/employee-directory.test.mjs`
Expected: FAIL — `Cannot find module './employee-directory.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/employee-directory.mjs`:

```js
// src/employee-directory.mjs
// Pure logic for the Employee Directory sync — no I/O. Merges one store's
// Paycor `employees` page and `identifyingData` page (same legal entity,
// same sync run, so Paycor's GUID lines up directly between them — no
// name-based fallback matching needed here) into upsert-ready rows.

export function buildDirectoryRows(employeesPage, identifyingDataPage, storePc, legalEntityId) {
  const dobById = new Map();
  for (const r of (identifyingDataPage || [])) {
    if (r && r.employeeId) dobById.set(r.employeeId, r.birthDate || null);
  }
  return (employeesPage || [])
    .filter(e => e && e.id)
    .map(e => ({
      paycorEmployeeId: e.id,
      employeeNumber: e.employeeNumber || null,
      firstName: e.firstName || '',
      lastName: e.lastName || '',
      email: e.email?.emailAddress || null,
      birthDate: dobById.has(e.id) ? dobById.get(e.id) : null,
      status: e.statusData?.status || null,
      storePc,
      legalEntityId,
    }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/employee-directory.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Do not commit yet** (single commit at the end of this plan)

---

### Task 2: `identifyingData` auth fix + `fetchAllIdentifyingData` helper

**Files:**
- Modify: `netlify/functions/paycor.mjs`
- Modify: `netlify/functions/tips-report-cron-background.mjs`

**Interfaces:**
- Produces: `fetchAllIdentifyingData(legalEntityId)` (exported from `tips-report-cron-background.mjs`, mirroring the existing `fetchAllEmployees`) — consumed by Task 3's cron.

**Why the auth fix:** every sibling proxy action in `paycor.mjs` that a cron calls (`employees`, `punches`) has no auth check at all — cron-to-proxy calls are plain server-to-server HTTP with no session credential to present, matching this file's existing security model (obscurity, not per-request auth, for pure data-fetch passthroughs). `identifyingData`'s exec/IT gate as built would 403 every cron call outright, since there's no browser session to check. The fix: only enforce the exec/IT check when a credential is actually present (a real browser call), so a credential-less server-to-server call passes through exactly like `employees` already does — this doesn't weaken anything a logged-in non-admin could already do (they couldn't reach this via the UI before either), it just stops requiring a credential that cron calls structurally can't provide.

- [ ] **Step 1: Loosen the identifyingData auth check**

In `netlify/functions/paycor.mjs`:

```
old_string:
    if (action === 'identifyingData') {
      const sqlClient = db();
      const authEvent = { headers: Object.fromEntries(request.headers.entries()) };
      const authedUser = await requireActiveUser(authEvent, sqlClient);
      if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
        return new Response(JSON.stringify({ error: 'Exec/IT session required.' }), { status: 403, headers });
      }
      const { legalEntityId, continuationToken } = payload;
new_string:
    if (action === 'identifyingData') {
      // Only enforce exec/IT when a session credential is actually present —
      // a cron's server-to-server call carries no Authorization/cookie at
      // all (same as this file's employees/punches actions, which have no
      // auth check whatsoever), so requiring one here would 403 every
      // legitimate cron call. A browser call, which always carries SOME
      // session state when logged in, still gets the exec/IT gate.
      const rawCred = request.headers.get('authorization') || request.headers.get('cookie') || '';
      if (rawCred) {
        const sqlClient = db();
        const authEvent = { headers: Object.fromEntries(request.headers.entries()) };
        const authedUser = await requireActiveUser(authEvent, sqlClient);
        if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
          return new Response(JSON.stringify({ error: 'Exec/IT session required.' }), { status: 403, headers });
        }
      }
      const { legalEntityId, continuationToken } = payload;
```

- [ ] **Step 2: Add `fetchAllIdentifyingData` next to `fetchAllEmployees`**

In `netlify/functions/tips-report-cron-background.mjs`, find `export async function fetchAllEmployees(legalEntityId) {` and add this new function immediately after its closing brace:

```js
// Same pagination shape as fetchAllEmployees, but for the identifyingData
// endpoint — paycor.mjs's own action mapping already discards
// socialSecurityNumber before this ever sees a response, so every record
// here is just {employeeId, birthDate}. Feeds the Employee Directory sync.
export async function fetchAllIdentifyingData(legalEntityId) {
  let records = [];
  let continuationToken;
  do {
    const raw = await callPaycorProxy('identifyingData', continuationToken ? { legalEntityId, continuationToken } : { legalEntityId });
    const body = JSON.parse(raw || '{}');
    if (!Array.isArray(body.records) && (body.Title || body.CorrelationId)) {
      throw new Error(`Paycor error response fetching identifyingData: ${body.Title || 'unknown'} — ${body.Detail || ''}`);
    }
    const page = Array.isArray(body.records) ? body.records : [];
    records = records.concat(page);
    continuationToken = body.continuationToken || null;
    if (!page.length) continuationToken = null;
  } while (continuationToken);
  return records;
}
```

- [ ] **Step 3: Syntax-check both files**

Run: `node --check netlify/functions/paycor.mjs && node --check netlify/functions/tips-report-cron-background.mjs`
Expected: no output (success).

- [ ] **Step 4: Do not commit yet**

---

### Task 3: The sync cron

**Files:**
- Create: `netlify/functions/employee-directory-cron.mjs`
- Modify: `netlify.toml`

**Interfaces:**
- Consumes: `STORES` (from `./labor-cron.mjs`), `fetchAllEmployees`/`fetchAllIdentifyingData` (from `./tips-report-cron-background.mjs`), `buildDirectoryRows` (from `../../src/employee-directory.mjs`).

- [ ] **Step 1: Write the cron**

Create `netlify/functions/employee-directory-cron.mjs`:

```js
// employee-directory-cron.mjs — daily sync of Name + Paycor ID + DOB + work
// email into the employee_directory table, per store. Feeds the Incident
// Report's Subject Employee type-ahead (employee-directory.mjs's search
// action). Read-only from Paycor's side — this never writes back.
import { neon } from '@neondatabase/serverless';
import { STORES } from './labor-cron.mjs';
import { fetchAllEmployees, fetchAllIdentifyingData } from './tips-report-cron-background.mjs';
import { buildDirectoryRows } from '../../src/employee-directory.mjs';

export const config = { schedule: '0 8 * * *' }; // 4am ET

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

let _ready = false;
async function ensureTable() {
  if (_ready) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS employee_directory (
    paycor_employee_id text PRIMARY KEY,
    employee_number   text,
    first_name        text,
    last_name         text,
    email             text,
    birth_date        text,
    status            text,
    store_pc          text,
    legal_entity_id   text,
    synced_at         timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_employee_directory_store ON employee_directory(store_pc)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_employee_directory_name ON employee_directory(store_pc, last_name, first_name)`;
  _ready = true;
}

async function upsertRows(rows) {
  if (!rows.length) return;
  const sql = db();
  const stmts = rows.map(r => sql`
    INSERT INTO employee_directory (
      paycor_employee_id, employee_number, first_name, last_name, email, birth_date, status, store_pc, legal_entity_id, synced_at
    ) VALUES (
      ${r.paycorEmployeeId}, ${r.employeeNumber}, ${r.firstName}, ${r.lastName}, ${r.email}, ${r.birthDate}, ${r.status}, ${r.storePc}, ${r.legalEntityId}, now()
    )
    ON CONFLICT (paycor_employee_id) DO UPDATE SET
      employee_number = EXCLUDED.employee_number, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
      email = EXCLUDED.email, birth_date = EXCLUDED.birth_date, status = EXCLUDED.status,
      store_pc = EXCLUDED.store_pc, legal_entity_id = EXCLUDED.legal_entity_id, synced_at = EXCLUDED.synced_at`);
  await sql.transaction(stmts);
}

export default async () => {
  await ensureTable();
  const results = [];
  for (const store of STORES) {
    try {
      const [employees, identifying] = await Promise.all([
        fetchAllEmployees(store.paycor),
        fetchAllIdentifyingData(store.paycor),
      ]);
      const rows = buildDirectoryRows(employees, identifying, store.pc, store.paycor);
      await upsertRows(rows);
      results.push({ store: store.pc, count: rows.length, ok: true });
    } catch (e) {
      console.warn('[employee-directory-cron] store failed:', store.pc, e.message);
      results.push({ store: store.pc, ok: false, error: e.message });
    }
  }
  const ok = results.filter(r => r.ok).length;
  console.log(`[employee-directory-cron] synced ${ok}/${STORES.length} stores`);
  return new Response(JSON.stringify({ ok: true, results }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
```

- [ ] **Step 2: Register the schedule**

In `netlify.toml`, add near the other daily crons (e.g. after `weather-forecast-cron`):

```toml
# Employee Directory sync — daily 4am ET (08:00 UTC), ahead of Tips/Labor.
# Pulls Name + Paycor ID + DOB + work email per store into employee_directory
# — feeds the Incident Report's Subject Employee type-ahead.
[functions.employee-directory-cron]
  schedule = "0 8 * * *"
```

- [ ] **Step 3: Syntax-check**

Run: `node --check netlify/functions/employee-directory-cron.mjs`
Expected: no output (success).

- [ ] **Step 4: Do not commit yet**

---

### Task 4: Search endpoint

**Files:**
- Create: `netlify/functions/employee-directory.mjs`

**Interfaces:**
- Produces: POST `/.netlify/functions/employee-directory` `{action:'search', storePc, query}` → `{ok, matches:[{paycorEmployeeId, firstName, lastName, email, birthDate, status}]}`. Consumed by Task 5's frontend type-ahead.

- [ ] **Step 1: Write the function**

Create `netlify/functions/employee-directory.mjs`:

```js
// employee-directory.mjs — read-only search over the employee_directory
// table (synced by employee-directory-cron.mjs), scoped to one store.
// Any logged-in user may search (matches "everyone can file an incident
// report") — this only ever reveals name/DOB/email for people at a store
// the caller is already filing a report for, not new information.
import { neon } from '@neondatabase/serverless';
import { requireActiveUser } from './auth-lib/require-user.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};

  try {
    const sql = db();
    const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql);
    if (!caller) return json(401, { error: 'Sign in required.' });

    if (action === 'search') {
      const storePc = String(payload.storePc || '').trim();
      const query = String(payload.query || '').trim();
      if (!storePc || query.length < 2) return json(200, { ok: true, matches: [] });
      const rows = await sql`
        SELECT paycor_employee_id, first_name, last_name, email, birth_date, status
        FROM employee_directory
        WHERE store_pc = ${storePc} AND (first_name || ' ' || last_name) ILIKE ${'%' + query + '%'}
        ORDER BY (status = 'Active') DESC, last_name, first_name
        LIMIT 10`;
      const matches = rows.map(r => ({
        paycorEmployeeId: r.paycor_employee_id, firstName: r.first_name, lastName: r.last_name,
        email: r.email, birthDate: r.birth_date, status: r.status,
      }));
      return json(200, { ok: true, matches });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('employee-directory.mjs error:', err);
    return json(500, { error: err.message });
  }
};
```

- [ ] **Step 2: Syntax-check**

Run: `node --check netlify/functions/employee-directory.mjs`
Expected: no output (success).

- [ ] **Step 3: Do not commit yet**

---

### Task 5: Frontend type-ahead

**Files:**
- Modify: `app.jsx`

**Interfaces:**
- Consumes: `authHeader()`, the `IncidentReportsTab` component and its `form`/`setForm` state (built earlier this session).

- [ ] **Step 1: Add search state and a debounced lookup**

In `IncidentReportsTab` (`app.jsx`), near the other `useState` declarations, add:

```jsx
  const [employeeMatches, setEmployeeMatches] = React.useState([]);
  const [employeeSearchOpen, setEmployeeSearchOpen] = React.useState(false);
  const employeeSearchTimer = React.useRef(null);

  const searchEmployees = (storePC, query) => {
    if (employeeSearchTimer.current) clearTimeout(employeeSearchTimer.current);
    if (!storePC || query.trim().length < 2) { setEmployeeMatches([]); return; }
    employeeSearchTimer.current = setTimeout(() => {
      fetch('/.netlify/functions/employee-directory', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ action: 'search', storePc: storePC, query }),
      })
        .then(r => r.json())
        .then(j => { if (j?.ok) { setEmployeeMatches(j.matches || []); setEmployeeSearchOpen(true); } })
        .catch(() => {});
    }, 300);
  };

  const pickEmployeeMatch = (m) => {
    setForm(f => ({ ...f, employeeName: `${m.firstName} ${m.lastName}`.trim(), employeeDob: m.birthDate || f.employeeDob, employeeEmail: m.email || f.employeeEmail }));
    setEmployeeSearchOpen(false);
    setEmployeeMatches([]);
  };
```

- [ ] **Step 2: Wire the Employee Name input to it**

Replace the plain Employee Name input added earlier in the Subject Employee section:

```
old_string:
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>Employee Name</label>
              <input style={inp(th)} value={form.employeeName} onChange={e => setForm(f => ({ ...f, employeeName: e.target.value }))} />
            </div>
new_string:
            <div style={{ position: 'relative' }}>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>Employee Name</label>
              <input
                style={inp(th)}
                value={form.employeeName}
                onChange={e => { const v = e.target.value; setForm(f => ({ ...f, employeeName: v })); searchEmployees(form.storePC, v); }}
                onFocus={() => { if (employeeMatches.length) setEmployeeSearchOpen(true); }}
                onBlur={() => setTimeout(() => setEmployeeSearchOpen(false), 150)}
                placeholder={form.storePC ? 'Start typing to search this store’s roster…' : 'Select a store first to search'}
              />
              {employeeSearchOpen && employeeMatches.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 8, marginTop: '0.2rem', maxHeight: '10rem', overflowY: 'auto' }}>
                  {employeeMatches.map(m => (
                    <div key={m.paycorEmployeeId} onMouseDown={() => pickEmployeeMatch(m)}
                      style={{ padding: '0.5rem 0.7rem', cursor: 'pointer', fontSize: '0.82rem', color: th.text, borderBottom: `1px solid ${th.cardBorder}` }}>
                      {m.firstName} {m.lastName} {m.status && m.status !== 'Active' ? <span style={{ color: th.muted }}>({m.status})</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
```

- [ ] **Step 3: Bump `APP_VERSION`**

Search `const APP_VERSION =` in `app.jsx`, increment the last digit from whatever it currently is.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 5: Do not commit yet**

---

### Task 6: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all passing, including the 5 new `employee-directory.test.mjs` tests.

- [ ] **Step 2: Preview deploy**

Run: `netlify deploy` (no `--prod`).

- [ ] **Step 3: Manually trigger the cron once**

The cron can't be hit directly over HTTP once scheduled (Netlify blocks direct POST to scheduled functions, per this codebase's established pattern) — for this first run, temporarily comment out `export const config = { schedule: ... }` in a local test, or (simpler) trigger it via the Netlify dashboard's "Trigger function" UI for `employee-directory-cron` after deploying to production, OR add a short-lived manual companion endpoint if the dashboard trigger isn't available, following the `labor-refresh.mjs`-style manual-trigger pattern already used elsewhere in this codebase. Confirm the `employee_directory` table gets populated (spot-check row count against a known store's headcount).

- [ ] **Step 4: Test search end-to-end**

On the preview URL, open the Incident Report form, pick a store that the cron has synced, type a couple of letters of a known employee's first name into Employee Name, and confirm the dropdown shows a match; select it and confirm Name/DOB/Email fill in.

- [ ] **Step 5: Single commit**

```bash
git add src/employee-directory.mjs src/employee-directory.test.mjs netlify/functions/paycor.mjs netlify/functions/tips-report-cron-background.mjs netlify/functions/employee-directory-cron.mjs netlify/functions/employee-directory.mjs netlify.toml app.jsx app.js docs/superpowers/specs/2026-09-28-employee-directory-design.md docs/superpowers/plans/2026-09-28-employee-directory.md
git commit -m "feat(employee-directory): Paycor-synced Name+DOB+email autofill for Incident Reports"
```

Do NOT push — ask the user first, per the standing "never deploy without asking" rule.
