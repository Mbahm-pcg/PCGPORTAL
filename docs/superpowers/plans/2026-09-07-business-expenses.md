# Business Expense Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new top-level "Expenses" tab, open to every role except vendor/kiosk/tablet, for logging a business receipt (gas/food/tools/supplies/repairs/office/other) by photo, with no approval workflow — a pure log, own-entries-only for regular roles, full network view + export for exec/IT/office staff.

**Architecture:** New Postgres table `business_expenses` (self-created via `CREATE TABLE IF NOT EXISTS`, same pattern as `maint_tickets`) + new Netlify function `netlify/functions/expenses.mjs` (create/list/delete, `requireActiveUser` auth) + new React component `ExpensesTab` in `app.jsx`, reusing existing primitives (`compressImageToBase64`, `ReceiptThumb`, the tips-report xlsx export pattern) rather than duplicating them.

**Tech Stack:** Neon Postgres (`@neondatabase/serverless`), Netlify Blobs (`@netlify/blobs`), the existing `auth-lib/require-user.js` session-token helper, React 18 (no new deps), SheetJS (`window.XLSX`, already loaded via CDN).

**Spec:** `docs/superpowers/specs/2026-09-07-business-expenses-design.md`

## Global Constraints

- Bump `APP_VERSION` in `app.jsx` (search `const APP_VERSION =`) after each task that touches `app.jsx`.
- Never edit `app.jsx` with PowerShell/regex tools — Edit tool only (encoding corruption risk).
- Run `npm run build` after every `app.jsx`/`src/*.jsx` change; commit `app.jsx` + `app.js` together.
- Every `expenses.mjs` action requires `requireActiveUser` — no unauthenticated fallback, no trusting a client-sent `userId` for identity/permissions.
- Server never trusts client-sent `store_name`/`district`/submitter identity — always resolved from the verified token / `STORE_BY_PC`.
- New tab icon must be a real `ICONS` SVG entry in `src/icons.jsx`, never emoji.
- This is a brand-new feature, separate from the existing per-ticket `ExpenseLogSection`/`maint_ticket_expenses` — do not modify those files/tables/components.
- No approval status, no reimbursement-status field, no edit-after-submit — delete + resubmit only.

---

### Task 1: Pure expense-scope helpers + tests

**Files:**
- Create: `netlify/functions/expenses-lib/scope.mjs`
- Create: `netlify/functions/expenses-lib/scope.test.mjs`
- Modify: `package.json:19` (test script glob)

**Interfaces:**
- Produces (consumed by Task 2): `CATEGORIES` (array of 7 strings), `isValidCategory(category): boolean`, `isFullExpenseAdmin(userType): boolean`, `resolveStoreFields(storePc, storeByPc): {storePc, storeName, district}`, `canDeleteExpense(row, claims): boolean` (row has `submitted_by_user_id`; claims has `sub`, `userType`), `buildListScope(claims, filters): {storePc, district, category, dateFrom, dateTo, forceUserId}`.

- [ ] **Step 1: Write the failing tests**

Create `netlify/functions/expenses-lib/scope.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES,
  isValidCategory,
  isFullExpenseAdmin,
  resolveStoreFields,
  canDeleteExpense,
  buildListScope,
} from './scope.mjs';

test('CATEGORIES: exact fixed list of 7', () => {
  assert.deepEqual(CATEGORIES, ['Gas', 'Food', 'Tools', 'Supplies', 'Repairs', 'Office', 'Other']);
});

test('isValidCategory: true for a listed category', () => {
  assert.equal(isValidCategory('Gas'), true);
});

test('isValidCategory: false for an unlisted value', () => {
  assert.equal(isValidCategory('Travel'), false);
});

test('isValidCategory: false for undefined/empty', () => {
  assert.equal(isValidCategory(undefined), false);
  assert.equal(isValidCategory(''), false);
});

test('isFullExpenseAdmin: true for executive, it, office_staff', () => {
  assert.equal(isFullExpenseAdmin('executive'), true);
  assert.equal(isFullExpenseAdmin('it'), true);
  assert.equal(isFullExpenseAdmin('office_staff'), true);
});

test('isFullExpenseAdmin: false for manager, dm, construction, maintenance, vendor', () => {
  assert.equal(isFullExpenseAdmin('manager'), false);
  assert.equal(isFullExpenseAdmin('dm'), false);
  assert.equal(isFullExpenseAdmin('construction'), false);
  assert.equal(isFullExpenseAdmin('maintenance'), false);
  assert.equal(isFullExpenseAdmin('vendor'), false);
});

test('resolveStoreFields: known pc resolves name + district from the map', () => {
  const map = { '340794': { pc: '340794', name: 'Front', district: 1 } };
  assert.deepEqual(resolveStoreFields('340794', map), { storePc: '340794', storeName: 'Front', district: 1 });
});

test('resolveStoreFields: no storePc given → all null (office/exec submission with no store)', () => {
  assert.deepEqual(resolveStoreFields(null, {}), { storePc: null, storeName: null, district: null });
  assert.deepEqual(resolveStoreFields(undefined, {}), { storePc: null, storeName: null, district: null });
});

test('resolveStoreFields: unknown pc keeps the pc but nulls name/district (never invents data)', () => {
  assert.deepEqual(resolveStoreFields('999999', {}), { storePc: '999999', storeName: null, district: null });
});

test('canDeleteExpense: the submitter can delete their own row', () => {
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 42, userType: 'manager' }), true);
});

test('canDeleteExpense: a different non-admin user cannot delete someone else\'s row', () => {
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 7, userType: 'manager' }), false);
});

test('canDeleteExpense: executive/it can delete any row regardless of submitter', () => {
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 7, userType: 'executive' }), true);
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 7, userType: 'it' }), true);
});

test('canDeleteExpense: office_staff (admin view, but NOT delete-any per spec) cannot delete someone else\'s row', () => {
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 7, userType: 'office_staff' }), false);
});

test('canDeleteExpense: false for missing row or claims', () => {
  assert.equal(canDeleteExpense(null, { sub: 1, userType: 'executive' }), false);
  assert.equal(canDeleteExpense({ submitted_by_user_id: 1 }, null), false);
});

test('buildListScope: admin (executive) gets no forced user filter, passes through given filters', () => {
  const scope = buildListScope({ sub: 1, userType: 'executive' }, { storePc: '340794', category: 'Gas' });
  assert.deepEqual(scope, { storePc: '340794', district: null, category: 'Gas', dateFrom: null, dateTo: null, forceUserId: null });
});

test('buildListScope: non-admin (manager) is force-scoped to their own user id', () => {
  const scope = buildListScope({ sub: 42, userType: 'manager' }, { storePc: '340794' });
  assert.deepEqual(scope, { storePc: '340794', district: null, category: null, dateFrom: null, dateTo: null, forceUserId: 42 });
});

test('buildListScope: district filter is coerced to a number when present', () => {
  const scope = buildListScope({ sub: 1, userType: 'it' }, { district: '3' });
  assert.equal(scope.district, 3);
});

test('buildListScope: no filters given defaults every optional field to null', () => {
  const scope = buildListScope({ sub: 1, userType: 'it' }, {});
  assert.deepEqual(scope, { storePc: null, district: null, category: null, dateFrom: null, dateTo: null, forceUserId: null });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test netlify/functions/expenses-lib/scope.test.mjs`
Expected: FAIL — `Cannot find module './scope.mjs'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `netlify/functions/expenses-lib/scope.mjs`:

```js
// scope.mjs — pure helpers for the business-expenses feature. No I/O, no
// Postgres/blob calls here — safe to unit test in isolation. Consumed by
// netlify/functions/expenses.mjs.

export const CATEGORIES = ['Gas', 'Food', 'Tools', 'Supplies', 'Repairs', 'Office', 'Other'];

// Exec/IT/office_staff see every submission network-wide and can delete any
// row (executive/it only — see canDeleteExpense); everyone else only ever
// sees/deletes their own.
export const ADMIN_USER_TYPES = ['executive', 'it', 'office_staff'];

export function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

export function isFullExpenseAdmin(userType) {
  return ADMIN_USER_TYPES.includes(userType);
}

// Resolves store_name/district from a store_pc using a pc→store map (shape:
// { [pc]: { pc, name, district } }, e.g. STORE_BY_PC from ndcp-lib/store-map.js).
// Never trusts a client-sent name/district — only the pc travels from the
// caller, name/district are always looked up server-side. An unknown pc
// keeps the pc (so it's still visible/debuggable) but never invents a name
// or district for it.
export function resolveStoreFields(storePc, storeByPc) {
  if (!storePc) return { storePc: null, storeName: null, district: null };
  const key = String(storePc);
  const store = storeByPc[key];
  if (!store) return { storePc: key, storeName: null, district: null };
  return { storePc: store.pc, storeName: store.name, district: store.district };
}

// True if `claims` (the verified portal session token) may delete `row` (a
// business_expenses row). A non-admin may only delete their own row — an
// office_staff admin can VIEW everyone's rows (see buildListScope) but is
// deliberately NOT in the delete-any set, only executive/it are (matches
// canDeleteExpense's narrower set vs isFullExpenseAdmin's viewing set).
export function canDeleteExpense(row, claims) {
  if (!row || !claims) return false;
  if (claims.userType === 'executive' || claims.userType === 'it') return true;
  return String(row.submitted_by_user_id) === String(claims.sub);
}

// Builds the effective filter set for a `list` query. A non-admin caller is
// force-scoped to their own rows (forceUserId) regardless of any filter they
// sent — the server enforces "everyone sees only their own" here, not the
// client.
export function buildListScope(claims, filters = {}) {
  return {
    storePc: filters.storePc || null,
    district: filters.district != null && filters.district !== '' ? Number(filters.district) : null,
    category: filters.category || null,
    dateFrom: filters.dateFrom || null,
    dateTo: filters.dateTo || null,
    forceUserId: isFullExpenseAdmin(claims?.userType) ? null : (claims?.sub ?? null),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test netlify/functions/expenses-lib/scope.test.mjs`
Expected: PASS, all 17 tests green.

- [ ] **Step 5: Wire the new test file into `npm test`**

In `package.json:19`, add `'netlify/functions/expenses-lib/*.test.mjs'` to the space-separated glob list (matches the existing style — each `-lib` directory is listed explicitly, there is no wildcard `*-lib` pattern):

```json
"test": "node --test 'netlify/functions/analyst-lib/*.test.mjs' 'src/*.test.mjs' 'netlify/functions/deal-lib/*.test.js' 'netlify/functions/ndcp-lib/*.test.js' 'netlify/functions/auth-lib/*.test.js' 'netlify/functions/audit-lib/*.test.js' 'netlify/functions/tips-lib/*.test.mjs' 'netlify/functions/expenses-lib/*.test.mjs'",
```

- [ ] **Step 6: Run the full suite to confirm nothing else broke**

Run: `npm test`
Expected: all prior tests still pass, plus the new 17, with only the pre-existing unrelated `ndcp-lib/store-map.test.js` failure (46 vs 45 stores) if it's still present — no other regressions. On Windows, if `npm test` reports 0 tests found (a known cmd.exe vs Git-Bash single-quote glob-expansion mismatch — no code issue), instead expand the globs yourself and pass real file paths to `node --test`, e.g. via PowerShell:
```powershell
$files = Get-ChildItem -Recurse -Include *.test.mjs,*.test.js -Path netlify\functions\analyst-lib,src,netlify\functions\deal-lib,netlify\functions\ndcp-lib,netlify\functions\auth-lib,netlify\functions\audit-lib,netlify\functions\tips-lib,netlify\functions\expenses-lib | ForEach-Object { $_.FullName }
node --test $files
```

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/expenses-lib/scope.mjs netlify/functions/expenses-lib/scope.test.mjs package.json
git commit -m "feat(expenses): pure scope/permission helpers for business expense receipts"
```

---

### Task 2: Backend handler — `netlify/functions/expenses.mjs`

**Files:**
- Create: `netlify/functions/expenses.mjs`
- Modify: `db/schema.ts` (documentation-only `pgTable` block, appended near the `maintTicketExpenses` block)

**Interfaces:**
- Consumes: `CATEGORIES, isValidCategory, isFullExpenseAdmin, resolveStoreFields, canDeleteExpense, buildListScope` from `./expenses-lib/scope.mjs` (Task 1). `STORE_BY_PC` from `./ndcp-lib/store-map.js` (pre-existing, shape `{ [pc]: { pc, name, district, dmName } }`). `requireActiveUser(event, db)` from `./auth-lib/require-user.js` (pre-existing) — returns `null` or `{ kind:'portal', sub, username, userType, district, name, auditsAccess }`.
- Produces (consumed by Task 3/4 frontend): a single POST endpoint `/.netlify/functions/expenses` accepting `{ action: 'create'|'list'|'delete', ... }`, always requiring a valid session (Bearer `Authorization` header or `pcg_session` cookie — both handled by the `eventShim` adapter below). Responses: `create` → `{ ok: true, expense: {...} }`; `list` → `{ ok: true, expenses: [...] }`; `delete` → `{ ok: true }`. Every expense object has this exact shape: `{ id, submittedByUserId, submittedByName, userType, storePc, storeName, district, category, amount, note, receiptKey, createdAt }`.

- [ ] **Step 1: Write the handler**

Create `netlify/functions/expenses.mjs`:

```js
// PCG Portal — Business Expense Receipts (gas/food/tools/supplies/repairs/
// office/other), backed by Neon Postgres. Receipt photos are a separate small
// Netlify Blob per entry, referenced by receipt_key (same pattern as the
// existing maintenance-ticket expenses in tickets.mjs, but that feature is a
// per-ticket, VP-approved job-cost log — this is a flat, unapproved personal-
// receipt log open to every role). See
// docs/superpowers/specs/2026-09-07-business-expenses-design.md.
//
// Actions (POST { action, ... }), ALL requiring an active portal session:
//   create { storePc?, category, amount, note?, receiptBase64? } → { ok, expense }
//   list   { storePc?, district?, category?, dateFrom?, dateTo? } → { ok, expenses:[…] }
//     Non-admin callers (anything but executive/it/office_staff) are always
//     force-scoped server-side to their own submissions — see buildListScope.
//   delete { id } → { ok }
//     Allowed for the row's own submitter, or executive/it for any row.
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { STORE_BY_PC } from './ndcp-lib/store-map.js';
import { isValidCategory, resolveStoreFields, canDeleteExpense, buildListScope } from './expenses-lib/scope.mjs';

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

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS business_expenses (
    id                   text PRIMARY KEY,
    submitted_by_user_id integer NOT NULL,
    submitted_by_name    text NOT NULL,
    user_type            text NOT NULL,
    store_pc             text,
    store_name           text,
    district             integer,
    category             text NOT NULL,
    amount               numeric NOT NULL,
    note                 text,
    receipt_key          text,
    created_at           timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bexp_user ON business_expenses(submitted_by_user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bexp_store ON business_expenses(store_pc)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bexp_created ON business_expenses(created_at)`;
  _ready = true;
}

function rowToExpense(r) {
  return {
    id: r.id,
    submittedByUserId: r.submitted_by_user_id,
    submittedByName: r.submitted_by_name,
    userType: r.user_type,
    storePc: r.store_pc,
    storeName: r.store_name,
    district: r.district,
    category: r.category,
    amount: r.amount != null ? Number(r.amount) : 0,
    note: r.note,
    receiptKey: r.receipt_key,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function genId() {
  return `bexp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (!action) return json(400, { error: 'Missing action' });

  // require-user.js's bearer() reads event.headers.authorization/.cookie as
  // plain object properties, but this is a fetch-style function whose
  // request.headers is a Headers object (no bracket access) — this shim
  // adapts it, same as system-health.mjs does.
  const eventShim = {
    headers: {
      authorization: request.headers.get('authorization') || '',
      cookie: request.headers.get('cookie') || '',
    },
  };

  try {
    const sql = db();
    await ensureTables();

    const claims = await requireActiveUser(eventShim, sql);
    if (!claims) return json(401, { error: 'Sign in required' });

    if (action === 'create') {
      const category = payload.category;
      if (!isValidCategory(category)) return json(400, { error: 'Invalid category' });
      const amount = Number(payload.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: 'Amount must be a positive number' });

      const id = genId();
      const { storePc, storeName, district } = resolveStoreFields(payload.storePc, STORE_BY_PC);
      const submittedByName = claims.name || claims.username;

      let receiptKey = null;
      if (payload.receiptBase64) {
        receiptKey = `pcg_business_expense_receipt_${id}`;
        await blobStore().setJSON(receiptKey, {
          savedAt: new Date().toISOString(),
          data: { base64: payload.receiptBase64, addedBy: submittedByName, addedAt: new Date().toISOString() },
        });
      }

      const rows = await sql`
        INSERT INTO business_expenses (
          id, submitted_by_user_id, submitted_by_name, user_type,
          store_pc, store_name, district, category, amount, note, receipt_key
        ) VALUES (
          ${id}, ${claims.sub}, ${submittedByName}, ${claims.userType},
          ${storePc}, ${storeName}, ${district}, ${category}, ${amount}, ${payload.note || null}, ${receiptKey}
        ) RETURNING *`;
      return json(200, { ok: true, expense: rowToExpense(rows[0]) });
    }

    if (action === 'list') {
      const scope = buildListScope(claims, payload);
      const rows = scope.forceUserId != null
        ? await sql`
            SELECT * FROM business_expenses
            WHERE submitted_by_user_id = ${scope.forceUserId}
              AND (${scope.storePc}::text IS NULL OR store_pc = ${scope.storePc})
              AND (${scope.district}::int IS NULL OR district = ${scope.district})
              AND (${scope.category}::text IS NULL OR category = ${scope.category})
              AND (${scope.dateFrom}::timestamptz IS NULL OR created_at >= ${scope.dateFrom}::timestamptz)
              AND (${scope.dateTo}::timestamptz IS NULL OR created_at <= ${scope.dateTo}::timestamptz)
            ORDER BY created_at DESC LIMIT 2000`
        : await sql`
            SELECT * FROM business_expenses
            WHERE (${scope.storePc}::text IS NULL OR store_pc = ${scope.storePc})
              AND (${scope.district}::int IS NULL OR district = ${scope.district})
              AND (${scope.category}::text IS NULL OR category = ${scope.category})
              AND (${scope.dateFrom}::timestamptz IS NULL OR created_at >= ${scope.dateFrom}::timestamptz)
              AND (${scope.dateTo}::timestamptz IS NULL OR created_at <= ${scope.dateTo}::timestamptz)
            ORDER BY created_at DESC LIMIT 2000`;
      return json(200, { ok: true, expenses: rows.map(rowToExpense) });
    }

    if (action === 'delete') {
      const id = payload.id != null ? String(payload.id) : null;
      if (!id) return json(400, { error: 'Missing id' });
      const rows = await sql`SELECT * FROM business_expenses WHERE id = ${id}`;
      if (!rows.length) return json(404, { error: 'Not found' });
      if (!canDeleteExpense(rows[0], claims)) return json(403, { error: 'Not allowed to delete this entry' });
      if (rows[0].receipt_key) await blobStore().delete(rows[0].receipt_key).catch(() => {});
      await sql`DELETE FROM business_expenses WHERE id = ${id}`;
      return json(200, { ok: true });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('expenses.mjs error:', err);
    return json(500, { error: err.message });
  }
};
```

- [ ] **Step 2: Add the documentation-only schema block**

In `db/schema.ts`, immediately after the `maintTicketExpenses` block (ends around line 134 with `});`), add:

```ts
// ── Business Expense Receipts (LIVE) ──────────────────────────────────────────
// Backs the top-level "Expenses" tab (netlify/functions/expenses.mjs). A flat,
// unapproved personal-receipt log (gas/food/tools/etc.) open to every role —
// distinct from maintTicketExpenses above, which is a per-ticket, VP-approved
// job-cost log. expenses.mjs self-creates this table via CREATE TABLE IF NOT
// EXISTS; this block documents the schema for drizzle/tooling only.
export const businessExpenses = pgTable("business_expenses", {
  id: text("id").primaryKey(),
  submittedByUserId: integer("submitted_by_user_id").notNull(),
  submittedByName: text("submitted_by_name").notNull(),
  userType: text("user_type").notNull(),
  storePC: text("store_pc"),
  storeName: text("store_name"),
  district: integer("district"),
  category: text("category").notNull(),
  amount: numeric("amount").notNull(),
  note: text("note"),
  receiptKey: text("receipt_key"),
  createdAt: timestamp("created_at").defaultNow(),
});
```

- [ ] **Step 3: Syntax-check the new function (no local Netlify dev server in this repo's workflow)**

Run: `node --check netlify/functions/expenses.mjs`
Expected: no output (valid syntax). Also run `node --check netlify/functions/expenses-lib/scope.mjs` if not already done in Task 1.

- [ ] **Step 4: Confirm the auth gate rejects an unauthenticated request (no secrets needed for this check)**

This can only be fully verified against a deployed instance (there is no local function emulator in this repo's workflow — see CLAUDE.md). After the next preview deploy (this happens at the end of Task 4, once the frontend can also be exercised), run:

```bash
curl -s -X POST https://<preview-url>/.netlify/functions/expenses \
  -H 'Content-Type: application/json' \
  -d '{"action":"list"}'
```

Expected: `{"error":"Sign in required"}` with HTTP 401 — proving the auth gate is live even before any UI exists to test the happy path. Note this expectation in the task report; the full authenticated create/list/delete happy path is verified in Task 4's manual browser test (a session token can only reasonably be obtained by signing in through the actual portal UI).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/expenses.mjs db/schema.ts
git commit -m "feat(expenses): business_expenses backend — create/list/delete with role-scoped auth"
```

---

### Task 3: Icon + tab registration + submit form + own-receipts log

**Files:**
- Modify: `src/icons.jsx` (new `expenses` icon in the `ICONS` object)
- Modify: `app.jsx` (`BASE_TABS`, main tab-routing block, new `ExpensesTab` component)

**Interfaces:**
- Consumes: `ICONS.expenses(color)` (this task, from `src/icons.jsx`). `compressImageToBase64(file, maxPx=600, quality=0.72): Promise<string>` (pre-existing, `app.jsx:18576`). `ReceiptThumb({ receiptKey, size, expandable })` (pre-existing, `app.jsx:18548`). `authHeader()` (pre-existing, imported at `app.jsx:7` from `./src/portal-auth.mjs`). The `/.netlify/functions/expenses` endpoint (Task 2): `create`/`list` actions.
- Produces (consumed by Task 4): the `ExpensesTab` component, extended in Task 4 with an additional admin-only section. Task 4 must NOT redefine `ExpensesTab` — it edits this same component in place. State prefix `bizExpense*` is established here and must stay consistent in Task 4 (e.g. `bizExpenseCategory`, `bizExpensePhoto`, not `expenseCategory`/`photo` — those names collide with the existing per-ticket expense form's own state in the same file).

- [ ] **Step 1: Add the new icon**

In `src/icons.jsx`, inside the `ICONS` object (near the `dollar` entry, `src/icons.jsx:50`), add a receipt-shaped icon:

```js
expenses: (c) => <Icon color={c} d={<>
  {React.createElement("path", { d: "M6 2h12a1 1 0 0 1 1 1v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21V3a1 1 0 0 1 1-1z" })}
  {React.createElement("line", { x1: "8", y1: "7", x2: "16", y2: "7" })}
  {React.createElement("line", { x1: "8", y1: "11", x2: "16", y2: "11" })}
  {React.createElement("line", { x1: "8", y1: "15", x2: "13", y2: "15" })}
</>} />,
```

- [ ] **Step 2: Register the tab**

In `app.jsx`, find `BASE_TABS` (`app.jsx:24991`). Add one entry to the array (after the existing `tickets` entry, or wherever reads cleanly — order in this array is the sidebar order):

```js
{ id: "expenses", label: "Expenses", icon: (c) => ICONS.expenses(c) },
```

This is spread into every role's tab array except `vendor` (hand-rolled separately, intentionally excluded — see spec). Kiosk/tablet roles never reach this array (structural exclusion, no change needed).

- [ ] **Step 3: Route the tab**

In `app.jsx`'s main `PCGPortal` return, inside the `<Guard key={tab} name="tab-content">` block (near `app.jsx:49492-49510`, alongside the other `{tab === "xxx" && <Component .../>}` lines), add:

```jsx
{tab === "expenses" && <ExpensesTab user={user} th={th} stores={stores} />}
```

- [ ] **Step 4: Write the `ExpensesTab` component**

Add this new top-level function in `app.jsx` (placed near other top-level tab components, e.g. right before or after `ExpenseLogSection` at `app.jsx:18600` — physically nearby is fine since they share `compressImageToBase64`/`ReceiptThumb`, but they are separate components, not shared state):

```jsx
const BIZ_EXPENSE_CATEGORIES = ['Gas', 'Food', 'Tools', 'Supplies', 'Repairs', 'Office', 'Other'];

function ExpensesTab({ user, th, stores }) {
  const isBizExpenseAdmin = user?.userType === 'executive' || user?.userType === 'it' || user?.userType === 'office_staff';
  const defaultStorePc = React.useMemo(() => {
    const s = (stores || []).find(s => String(s.pc) === String(user?.storePC));
    return s ? s.pc : '';
  }, [stores, user]);

  const [bizExpenseCategory, setBizExpenseCategory] = React.useState(BIZ_EXPENSE_CATEGORIES[0]);
  const [bizExpenseAmount, setBizExpenseAmount] = React.useState('');
  const [bizExpenseStorePc, setBizExpenseStorePc] = React.useState(defaultStorePc);
  const [bizExpenseNote, setBizExpenseNote] = React.useState('');
  const [bizExpensePhoto, setBizExpensePhoto] = React.useState(null); // base64 data URL
  const [bizExpensePhotoLoading, setBizExpensePhotoLoading] = React.useState(false);
  const [bizExpenseSubmitting, setBizExpenseSubmitting] = React.useState(false);
  const [bizExpenseError, setBizExpenseError] = React.useState('');

  React.useEffect(() => { setBizExpenseStorePc(defaultStorePc); }, [defaultStorePc]);

  const [bizExpenseMyRows, setBizExpenseMyRows] = React.useState([]);
  const [bizExpenseMyLoading, setBizExpenseMyLoading] = React.useState(true);

  const loadMyExpenses = React.useCallback(() => {
    setBizExpenseMyLoading(true);
    fetch('/.netlify/functions/expenses', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'list' }),
    })
      .then(r => r.json())
      .then(j => { if (j?.ok) setBizExpenseMyRows(j.expenses || []); })
      .catch(() => {})
      .finally(() => setBizExpenseMyLoading(false));
  }, []);

  React.useEffect(() => { loadMyExpenses(); }, [loadMyExpenses]);

  const handleBizExpensePhoto = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBizExpensePhotoLoading(true);
    try {
      const b64 = await compressImageToBase64(file);
      setBizExpensePhoto(b64);
    } catch { setBizExpenseError('Could not read that photo — please try again.'); }
    setBizExpensePhotoLoading(false);
  };

  const submitBizExpense = async () => {
    setBizExpenseError('');
    const amt = Number(bizExpenseAmount);
    if (!Number.isFinite(amt) || amt <= 0) { setBizExpenseError('Enter a valid amount.'); return; }
    setBizExpenseSubmitting(true);
    try {
      const res = await fetch('/.netlify/functions/expenses', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({
          action: 'create',
          category: bizExpenseCategory,
          amount: amt,
          storePc: bizExpenseStorePc || null,
          note: bizExpenseNote || null,
          receiptBase64: bizExpensePhoto || null,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setBizExpenseError(j?.error || 'Could not save this receipt — please try again.'); return; }
      setBizExpenseAmount(''); setBizExpenseNote(''); setBizExpensePhoto(null);
      loadMyExpenses();
    } catch { setBizExpenseError('Network error — please try again.'); }
    setBizExpenseSubmitting(false);
  };

  const deleteBizExpense = async (id) => {
    try {
      await fetch('/.netlify/functions/expenses', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ action: 'delete', id }),
      });
      loadMyExpenses();
    } catch {}
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div style={{ ...card(th), padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text, marginBottom: '0.8rem' }}>Log a receipt</div>
        {bizExpenseError && <div style={{ fontSize: '0.78rem', color: '#dc2626', marginBottom: '0.6rem' }}>{bizExpenseError}</div>}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.6rem', marginBottom: '0.6rem' }}>
          <select value={bizExpenseCategory} onChange={e => setBizExpenseCategory(e.target.value)} style={inp(th)}>
            {BIZ_EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input type="number" step="0.01" min="0" placeholder="Amount ($)" value={bizExpenseAmount}
            onChange={e => setBizExpenseAmount(e.target.value)} style={inp(th)} />
          <select value={bizExpenseStorePc} onChange={e => setBizExpenseStorePc(e.target.value)} style={inp(th)}>
            <option value="">No store</option>
            {(stores || []).map(s => <option key={s.pc} value={s.pc}>{s.name}</option>)}
          </select>
        </div>
        <input placeholder="Note (optional)" value={bizExpenseNote} onChange={e => setBizExpenseNote(e.target.value)}
          style={{ ...inp(th), width: '100%', marginBottom: '0.6rem' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
          <label style={{ ...btn(th, { background: th.card2, color: th.text }), cursor: 'pointer' }}>
            📷 {bizExpensePhoto ? 'Retake / choose photo' : 'Take or choose photo'}
            <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleBizExpensePhoto} />
          </label>
          {bizExpensePhotoLoading && <span style={{ fontSize: '0.78rem', color: th.muted }}>Processing photo…</span>}
          {bizExpensePhoto && !bizExpensePhotoLoading && (
            <img src={bizExpensePhoto} alt="Receipt preview" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: `1px solid ${th.cardBorder}` }} />
          )}
          <button onClick={submitBizExpense} disabled={bizExpenseSubmitting}
            style={{ ...btn(th, { background: '#1B8F5C' }), opacity: bizExpenseSubmitting ? 0.6 : 1, marginLeft: 'auto' }}>
            {bizExpenseSubmitting ? 'Saving…' : 'Save receipt'}
          </button>
        </div>
      </div>

      <div style={{ ...card(th), padding: '1.25rem', marginBottom: '1.25rem' }}>
        <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text, marginBottom: '0.6rem' }}>My receipts</div>
        {bizExpenseMyLoading ? (
          <div style={{ fontSize: '0.8rem', color: th.muted }}>Loading…</div>
        ) : bizExpenseMyRows.length === 0 ? (
          <div style={{ fontSize: '0.8rem', color: th.muted }}>No receipts logged yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {bizExpenseMyRows.map(r => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.5rem', border: `1px solid ${th.cardBorder}`, borderRadius: 8 }}>
                <ReceiptThumb receiptKey={r.receiptKey} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.82rem', fontWeight: 600, color: th.text }}>{r.category} — ${r.amount.toFixed(2)}</div>
                  <div style={{ fontSize: '0.72rem', color: th.muted }}>
                    {r.storeName || 'No store'} · {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}{r.note ? ` · ${r.note}` : ''}
                  </div>
                </div>
                <button onClick={() => deleteBizExpense(r.id)} style={{ ...btn(th, { background: 'transparent', color: '#dc2626' }), fontSize: '0.72rem', padding: '0.3rem 0.5rem' }}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

Note: `isBizExpenseAdmin`/`BIZ_EXPENSE_CATEGORIES` (top-level const, matching `CATEGORIES` in `expenses-lib/scope.mjs` — frontend and backend each keep their own copy since the frontend bundle doesn't import server files) are unused by the JSX above but are deliberately kept — Task 4 uses both directly inside this same function body without redeclaring them.

- [ ] **Step 5: Build and bump version**

Search `const APP_VERSION =` in `app.jsx` and increment it (e.g. `v20.54` → `v20.55`). Run:
```bash
npm run build
```
Expected: clean build, `app.js` regenerated, no esbuild errors.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js src/icons.jsx
git commit -m "feat(expenses): Expenses tab — icon, routing, submit form, own-receipts log"
```

---

### Task 4: Admin full-network log with filters + xlsx export

**Files:**
- Modify: `app.jsx` (extend `ExpensesTab` in place — no new component)

**Interfaces:**
- Consumes: `isBizExpenseAdmin`, `BIZ_EXPENSE_CATEGORIES` (Task 3, same function body). `window.XLSX` (CDN global, already loaded in `index.html` — see the tips-report `download` function at `app.jsx:39962-39976` for the exact call shape: `book_new()` → `utils.aoa_to_sheet()` → `book_append_sheet()` → `writeFile()`). The same `/.netlify/functions/expenses` `list` action (Task 2) — an admin caller gets network-wide rows back with no forced scope.
- Produces: nothing further consumes this — it's the last task before final review.

- [ ] **Step 1: Add admin-only state and the network-wide loader**

Inside `ExpensesTab` (Task 3's function body), add alongside the other `bizExpense*` state:

```jsx
  const [bizExpenseAllRows, setBizExpenseAllRows] = React.useState([]);
  const [bizExpenseAllLoading, setBizExpenseAllLoading] = React.useState(false);
  const [bizExpenseFilterStore, setBizExpenseFilterStore] = React.useState('');
  const [bizExpenseFilterCategory, setBizExpenseFilterCategory] = React.useState('');
  const [bizExpenseFilterFrom, setBizExpenseFilterFrom] = React.useState('');
  const [bizExpenseFilterTo, setBizExpenseFilterTo] = React.useState('');

  const loadAllExpenses = React.useCallback(() => {
    if (!isBizExpenseAdmin) return;
    setBizExpenseAllLoading(true);
    fetch('/.netlify/functions/expenses', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({
        action: 'list',
        storePc: bizExpenseFilterStore || undefined,
        category: bizExpenseFilterCategory || undefined,
        dateFrom: bizExpenseFilterFrom ? new Date(bizExpenseFilterFrom).toISOString() : undefined,
        dateTo: bizExpenseFilterTo ? new Date(bizExpenseFilterTo + 'T23:59:59').toISOString() : undefined,
      }),
    })
      .then(r => r.json())
      .then(j => { if (j?.ok) setBizExpenseAllRows(j.expenses || []); })
      .catch(() => {})
      .finally(() => setBizExpenseAllLoading(false));
  }, [isBizExpenseAdmin, bizExpenseFilterStore, bizExpenseFilterCategory, bizExpenseFilterFrom, bizExpenseFilterTo]);

  React.useEffect(() => { loadAllExpenses(); }, [loadAllExpenses]);

  const deleteAnyBizExpense = async (id) => {
    try {
      await fetch('/.netlify/functions/expenses', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ action: 'delete', id }),
      });
      loadAllExpenses();
    } catch {}
  };

  const downloadBizExpenses = () => {
    const XLSX = window.XLSX;
    if (!XLSX) return;
    const wb = XLSX.utils.book_new();
    const aoa = [['Date', 'Store', 'District', 'Category', 'Amount', 'Submitted By', 'Note']];
    bizExpenseAllRows.forEach(r => aoa.push([
      r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '',
      r.storeName || '',
      r.district ?? '',
      r.category,
      r.amount,
      r.submittedByName,
      r.note || '',
    ]));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Expenses');
    XLSX.writeFile(wb, `Business_Expenses_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };
```

- [ ] **Step 2: Render the admin section**

In `ExpensesTab`'s returned JSX (Task 3), add a new card after the "My receipts" card, gated by `isBizExpenseAdmin`:

```jsx
      {isBizExpenseAdmin && (
        <div style={{ ...card(th), padding: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text }}>All receipts (network-wide)</div>
            <button onClick={downloadBizExpenses} style={{ ...btn(th, { background: '#1B8F5C' }), fontSize: '0.78rem' }}>Download workbook</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem', marginBottom: '0.8rem' }}>
            <select value={bizExpenseFilterStore} onChange={e => setBizExpenseFilterStore(e.target.value)} style={inp(th)}>
              <option value="">All stores</option>
              {(stores || []).map(s => <option key={s.pc} value={s.pc}>{s.name}</option>)}
            </select>
            <select value={bizExpenseFilterCategory} onChange={e => setBizExpenseFilterCategory(e.target.value)} style={inp(th)}>
              <option value="">All categories</option>
              {BIZ_EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="date" value={bizExpenseFilterFrom} onChange={e => setBizExpenseFilterFrom(e.target.value)} style={inp(th)} />
            <input type="date" value={bizExpenseFilterTo} onChange={e => setBizExpenseFilterTo(e.target.value)} style={inp(th)} />
          </div>
          {bizExpenseAllLoading ? (
            <div style={{ fontSize: '0.8rem', color: th.muted }}>Loading…</div>
          ) : bizExpenseAllRows.length === 0 ? (
            <div style={{ fontSize: '0.8rem', color: th.muted }}>No receipts match these filters.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {bizExpenseAllRows.map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.5rem', border: `1px solid ${th.cardBorder}`, borderRadius: 8 }}>
                  <ReceiptThumb receiptKey={r.receiptKey} size={40} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 600, color: th.text }}>{r.category} — ${r.amount.toFixed(2)} — {r.submittedByName}</div>
                    <div style={{ fontSize: '0.72rem', color: th.muted }}>
                      {r.storeName || 'No store'}{r.district ? ` (District ${r.district})` : ''} · {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}{r.note ? ` · ${r.note}` : ''}
                    </div>
                  </div>
                  <button onClick={() => deleteAnyBizExpense(r.id)} style={{ ...btn(th, { background: 'transparent', color: '#dc2626' }), fontSize: '0.72rem', padding: '0.3rem 0.5rem' }}>Delete</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
```

- [ ] **Step 3: Build and bump version**

Search `const APP_VERSION =` in `app.jsx` and increment it again (e.g. `v20.55` → `v20.56`). Run:
```bash
npm run build
```
Expected: clean build, no esbuild errors.

- [ ] **Step 4: Manual authenticated smoke test (the one step in this plan that cannot be automated)**

Deploy a preview (`npx netlify deploy`, no `--prod`) and, in a real browser, signed in as (a) a `manager`/`dm`/`construction` user: confirm the Expenses tab shows only the submit form + "My receipts" (no admin card), submit a receipt with a real photo (from a phone if possible, to test `capture="environment"`), confirm it appears in "My receipts", delete it, confirm it disappears; (b) an `executive`/`it`/`office_staff` user: confirm the "All receipts" admin card appears, shows the manager's test submission (if not yet deleted), filters work, "Download workbook" produces a valid `.xlsx`. Report back explicitly which of these were actually exercised vs. assumed — camera capture specifically can only be confirmed on a real phone, not this session's own tooling.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(expenses): admin network-wide receipt log with filters and xlsx export"
```

---

## After all tasks

Per `superpowers:subagent-driven-development`: dispatch a final whole-branch code review, address any findings with one fix round + scoped re-review, then use `superpowers:finishing-a-development-branch`. The user has authorized commits/builds/preview-deploys but explicitly withheld permission to push to `main` (production deploy) — stop after the branch is clean and ask before any push/merge to `main`.
