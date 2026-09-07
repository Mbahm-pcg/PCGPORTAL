# Business Expense Receipts — Design Spec

**Status:** Approved by user (verbal, in-chat) 2026-09-07. Writing plan next.

## Goal

A new top-level "Expenses" tab, open to every user role, where anyone can log a
business receipt (gas, food, tools, supplies, repairs, office, other) by
photographing or picking a photo of it, on mobile/tablet or desktop. There is
**no approval workflow and no reimbursement-status tracking** — this is a pure
submission log. Exec/IT/office staff get a network-wide filterable view with
export; everyone else sees only what they personally submitted.

## Explicit non-goals / what this is NOT

- **Not** the existing maintenance-ticket expense feature (`ExpenseLogSection`,
  `app.jsx:18600`, categories `Parts/Labor/Equipment/Supplies/Contractor/Other`,
  requires VP approval, lives inside a ticket). That feature is untouched.
  This is a separate, new, flat entity — a new Postgres table
  (`business_expenses`), a new Netlify function (`expenses.mjs`), a new React
  component (`ExpensesTab`) — reusing shared *patterns* (photo compression,
  `ReceiptThumb`, xlsx export) but not the same data or code paths.
- No approval/rejection status, no notifications on submit.
- No reimbursement tracking (paid/unpaid flag) — out of scope per explicit
  user answer; whether/when someone gets paid back is handled outside the app.
- No editing of a submitted entry after the fact — only delete + resubmit.

## Data model

New Postgres table, self-created via `CREATE TABLE IF NOT EXISTS` inside
`expenses.mjs` (same pattern as `maint_tickets`/`maint_ticket_expenses` in
`tickets.mjs:37-95` — no drizzle migration step required, though a
documentation-only block gets added to `db/schema.ts` for consistency with
the existing `maint_tickets` doc comment there).

```sql
CREATE TABLE IF NOT EXISTS business_expenses (
  id                   text PRIMARY KEY,        -- 'bexp_<ts>_<rand>', server-generated
  submitted_by_user_id integer NOT NULL,         -- claims.sub — never client-trusted
  submitted_by_name    text NOT NULL,            -- claims.name/username, for display
  user_type            text NOT NULL,            -- claims.userType at submit time
  store_pc             text,                     -- nullable — office/exec/DM submissions may have none
  store_name           text,                     -- resolved server-side from STORE_BY_PC, not client-sent
  district             integer,                  -- resolved server-side from STORE_BY_PC
  category             text NOT NULL,            -- 'Gas'|'Food'|'Tools'|'Supplies'|'Repairs'|'Office'|'Other'
  amount               numeric NOT NULL,
  note                 text,
  receipt_key          text,                     -- blob key, e.g. 'pcg_business_expense_receipt_bexp_...'
  created_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bexp_user ON business_expenses(submitted_by_user_id);
CREATE INDEX IF NOT EXISTS idx_bexp_store ON business_expenses(store_pc);
CREATE INDEX IF NOT EXISTS idx_bexp_created ON business_expenses(created_at);
```

Receipt photo itself stays a single small Netlify Blob (not chunked — receipts
are compressed client-side to ~600px/quality 0.72 JPEG via the existing
`compressImageToBase64`, `app.jsx:18576`, well under the 4MB chunked-upload
threshold), keyed `pcg_business_expense_receipt_{id}`, shape
`{ base64, addedBy, addedAt }` — same wrapper shape `cloudSave` already uses
everywhere else in the app.

## Backend: `netlify/functions/expenses.mjs`

New file. Imports `STORE_BY_PC` from `./ndcp-lib/store-map.js` (same
CJS→ESM interop already used by `tasks.mjs:35`) to resolve `store_name`/
`district` server-side from a client-sent `store_pc` — the client is trusted
for *which* store, never for the store's name/district, so a stale/altered
client can't misattribute district-level rollups.

**Auth:** every action requires an active session
(`requireActiveUser(eventShim, sql)` from `auth-lib/require-user.js` — the
same helper `system-health.mjs` uses). `require-user.js`'s `bearer()` reads
`event.headers.authorization`/`.cookie` as plain object properties, but this
is a modern fetch-style Netlify Function (`export default async (request) =>`),
whose `request.headers` is a `Headers` object with no bracket access — so
`expenses.mjs` must build the same adapter `system-health.mjs:33` does:
`const eventShim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };`
before calling `requireActiveUser(eventShim, sql)`. Skipping this shim makes
`bearer()` silently always return `''` and every request fail auth. No
fallback to a client-sent `userId` —
unlike the older `tasks.mjs`/`resolveCaller` pattern, this is a brand-new
endpoint with a brand-new client caller that always sends `authHeader()`
from day one, so there's no legacy no-token caller to accommodate (the risk
that broke the earlier general auth-hardening attempt doesn't apply here —
see `project_security_audit` memory). A missing/invalid/expired token is a
flat 401 on every action.

**Actions (POST `{ action, ... }`):**

- `create { storePc, category, amount, note, receiptBase64 }` → inserts one
  row using `claims.sub`/`claims.name`/`claims.userType` from the verified
  token (never client-sent fields) for the submitter identity; resolves
  `store_name`/`district` from `STORE_BY_PC[storePc]` if `storePc` given, else
  both null. If `receiptBase64` present, saves it to
  `pcg_business_expense_receipt_{id}` via `getStore({ name: 'pcg-portal',
  siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN })` +
  `.setJSON(key, { savedAt, data: { base64, addedBy, addedAt } })` — there is
  no shared blob-store export to import; every function that touches blobs
  (`storage.mjs:28`, `tips-report-cron-background.mjs`) makes this same
  inline `getStore(...)` call itself, so `expenses.mjs` does too. Returns the
  inserted row.
- `list { storePc?, district?, category?, dateFrom?, dateTo? }` → role-scoped:
  if `claims.userType` is `executive`/`it`/`office_staff`, returns all rows
  matching the optional filters (ordered `created_at DESC`, capped at 2000).
  Otherwise, forces `submitted_by_user_id = claims.sub` regardless of any
  filter the client sent — a non-admin role can never see anyone else's rows
  no matter what it asks for.
- `delete { id }` → deletes one row + its receipt blob. Allowed if the row's
  `submitted_by_user_id === claims.sub`, OR `claims.userType` is
  `executive`/`it`. Anyone else gets a 403.

## Frontend

**Icon:** new `expenses` entry added to `ICONS` in `src/icons.jsx` (a receipt-
shaped SVG path, following the existing simple-icon shape at
`src/icons.jsx:50`) — every tab needs a unique icon, no emoji
(`feedback_unique_tab_icons` memory).

**Tab registration:** add
`{ id: "expenses", label: "Expenses", icon: (c) => ICONS.expenses(c) }` to
`BASE_TABS` (`app.jsx:24991`) — every role that spreads `BASE_TABS`
(executive/it/office_staff/auditor/dm/manager/construction/maintenance) picks
it up automatically, on both the desktop sidebar and `MobileAppLauncher`
(same `TABS` array feeds both, per existing research). `vendor`'s tab array
is hand-rolled and does NOT get "expenses" — a vendor is an external party,
not PCG staff spending PCG money; **explicit ruling, not asked of the user**
(they're away — this is a low-risk, easily-reversed default that can be
changed with a one-line addition to the vendor array if wrong). Kiosk/tablet
roles (`kiosk_pulse`, `kiosk_upload`, `store_tablet`) never reach the tab
array at all (they return early / render a fixed view), so they're
automatically excluded — no special-casing needed.

Add routing: `{tab === "expenses" && <ExpensesTab user={user} th={th} stores={stores} />}`
alongside the other tab routes in the main `PCGPortal` return.

**Component: `ExpensesTab`** (new, top-level — distinct from the existing
`ExpenseLogSection`/`expenseForm`/`mobileExpenseForm` state, which are
per-ticket and untouched). Internal state prefixed `bizExpense*` throughout
to avoid any naming collision with the existing ticket-expense code in the
same file.

Structure:
1. **Submit form** (shown to everyone): category dropdown (7 fixed values),
   amount input, store dropdown (defaults to
   `stores.find(s => String(s.pc) === String(user.storePC))` when the user
   has one, same lookup `managerStore` already does at `app.jsx:20718`;
   required pick from `stores` when they don't), optional note, and a photo
   picker: `<input type="file" accept="image/*" capture="environment">`
   (same element shape as `app.jsx:21643`) feeding `compressImageToBase64`
   into local state before submit. On submit, POSTs to
   `/.netlify/functions/expenses` with `action:'create'`, `credentials:'include'`,
   `headers: { ...authHeader() }` (same shape as `system-health.mjs`'s caller,
   `app.jsx:23375`).
2. **"My receipts" log** (shown to everyone): the submitter's own rows,
   newest first — thumbnail via the existing generic `ReceiptThumb`
   component (`app.jsx:18548`, already receipt-key-driven and reusable
   as-is), category, amount, store, date, a delete button per row.
3. **Full network log** (exec/IT/office_staff only, additional section below
   the above): all rows network-wide, filters for store/district/category/
   date range, a delete button on every row (not just their own), and a
   "Download workbook" button following the exact xlsx pattern already used
   in the tips report (`app.jsx:39962-39976` — `window.XLSX`, `book_new()` →
   `aoa_to_sheet()` → `book_append_sheet()` → `writeFile()`), one sheet,
   columns: Date, Store, District, Category, Amount, Submitted By, Note.

## Global Constraints

- Bump `APP_VERSION` in `app.jsx` after each implementation task, not just
  once at the end (`feedback_version_bump` memory).
- No PowerShell edits to `app.jsx` — Edit tool only (`feedback_powershell_encoding`).
- Run `npm run build` before any preview deploy; commit `app.jsx` + `app.js`
  together.
- New tab icon must be a real `ICONS` SVG entry, never emoji.
- Every Netlify function action in `expenses.mjs` requires
  `requireActiveUser` — no unauthenticated fallback.
- Server never trusts client-sent `store_name`/`district`/submitter identity
  — always resolved from the verified token / `STORE_BY_PC`.

## Testing

No React UI test harness exists in this repo (the `npm test` suite only
covers pure `*-lib` helper functions, per `package.json`). Verification is:
unit tests for any new pure helper functions (e.g. a `resolveStoreForExpense`
style function if one gets extracted), a manual `curl`-based check of every
`expenses.mjs` action (auth required, role-scoping, create/list/delete), a
clean `npm run build`, and a preview deploy for in-browser testing. Actual
camera-capture behavior on a real phone can only be verified by the user on
their own device — this will be called out explicitly, not claimed as
verified.
