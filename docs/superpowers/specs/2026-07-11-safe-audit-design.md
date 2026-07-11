# Safe Audit + District-Label Cleanup — Design Spec

**Date:** 2026-07-11
**Status:** Approved by Mike (design review in Claude Code session; access table + form changes confirmed)
**Context:** Mike wants a second audit type — a **Safe Audit** (cash/petty-cash reconciliation) — modeled on three sample PDFs from the old tool. It is structurally unlike the Field Ops scored checklist: a typed form + denomination cash count, no pass/fail items, no CAPs. Managers, DMs, auditors, and above conduct and view it. Bundled with this: a **district-label cleanup** so every district shown in the app reads "District N - <DM first name>" / "DN - <DM first name>".

---

## PART A — Safe Audit

### A1. Placement & access

- The **Audits tab** gains a **Field Ops / Safe** segmented toggle at the top. Users who can see both segments get the toggle; users who can see only one get that segment with no toggle.
- The Audits tab becomes visible to **managers** (new) — they land directly in Safe mode; they have no Field Ops access.

Access (server-enforced in `safe-audits.mjs`; UI mirrors it):

| Role | Conduct Safe Audit | View Safe Audits |
|---|---|---|
| manager | ✅ own store only | ✅ own store |
| dm | ✅ their district | ✅ their district |
| auditor / executive / it | ✅ all stores | ✅ all stores |
| office_staff | ❌ | ✅ all (read-only) |

- The existing `audits_access` grant composes naturally: `'full'` also grants Safe conduct, `'view'` grants Safe view — via a `safeCanConduct(userType, grant)` / `safeCanView(userType, grant)` pair mirroring `effectiveAudits`.
- Store scoping (`visibleStoresSafe`) mirrors Field Ops: manager → own `storePC`; dm → their district's stores; auditor/exec/it/office_staff → all.

### A2. Form (mirrors the sample PDFs)

Sections and fields (all captured on the conduct form):

1. **General** — Reason for Audit (`Random | Scheduled | Cash Discrepancy | Manager Change | Shift Change | Other`); Current Safe Code (text); Approx. date code last changed (date).
2. **Store** — Store Manager Name (text); District (number; label rendered via the Part-B helper).
3. **Petty Cash** — Expected Petty Cash Amount (currency) — **per-store locked value, see A8** (entered on the store's first audit, then read-only for everyone except executive/it).
4. **Receipts** — Are there receipts in the safe? (Yes/No). If **Yes**: receipt photo(s) (chunked blob upload) + Total amount in receipts (currency).
5. **Cash count** — enter the **count** of each denomination; the app computes each line's value and all totals (see A3).
6. **Counterfeit** — Any fake bills? (Yes/No). If **Yes**: photo(s) + Total counterfeit amount (currency). Counterfeit cash is NOT counted toward the legitimate total.
7. **Signatures** — conductor signature (required to submit); optional store-manager/witness signature + printed name.
8. **Notes** — free text (optional).

**Deliberate change from the old form:** the hand-typed "Actual Petty Cash Amount" field is dropped and replaced by the auto-computed **Counted Total** (A3). The old totals were manually typed and did not add up in 2 of 3 sample PDFs.

### A3. Cash math (pure lib `audit-lib/safe-cash.js`, tested)

Denomination values:
- Bills: `hundreds 100, fifties 50, twenties 20, tens 10, fives 5, ones 1`
- Coins: `halfDollars 0.50, quarters 0.25, dimes 0.10, nickels 0.05, pennies 0.01`

Inputs are **counts** (non-negative integers; blank/`''`/`'N/A'` → 0).

- `computeCashTotals(billCounts, coinCounts)` → `{ billsTotal, coinsTotal, countedTotal }`, each rounded to cents.
- `computeVariance({ countedTotal, receiptsTotal, expected })` → `{ accountedTotal, variance, status }` where
  `accountedTotal = countedTotal + receiptsTotal`, `variance = accountedTotal − expected`,
  `status = 'balanced'` if `|variance| ≤ DISPLAY_TOLERANCE` (0.50), `'short'` if `variance < −tol`, `'over'` if `variance > +tol`.
- Money rounding uses cent-integer arithmetic to avoid float drift.

### A4. Discrepancy notification

On **submit**, send email + push to the store's **district DM** (by district) and **all executive users** when:
`variance ≤ −SHORTAGE_ALERT_THRESHOLD` (default **$5.00**) **OR** `hasCounterfeit === true`.
Over-variance alone does not alert. Reuse the exact send helpers from `audit-cap-cron.mjs` (Resend email + web-push). Sent inline in the submit handler (a few recipients, well under the 26s limit); guarded so nothing sends when the condition is false. Threshold and tolerance are named constants.

### A8. Per-store locked expected petty cash

The expected petty cash amount belongs to the **store**, not the audit:

- **First audit at a store:** the conductor enters the expected amount. On **submit**, it is written to `safe_settings[store_pc]` and becomes the locked value for that store.
- **Every later audit at that store:** the expected amount is auto-populated from `safe_settings` and shown **read-only** — the conductor cannot change it.
- **Editing later:** only **executive/it** may change a store's locked expected amount. They can edit it inline on the audit form (their field stays editable) and via a dedicated `setSafeExpected` action. Any change is recorded (`updated_by`, `updated_at`).
- **Server is authoritative:** at submit the server computes variance against the stored `safe_settings` expected (set-if-absent on first submit via `ON CONFLICT (store_pc) DO NOTHING`, then re-read). A non-exec/it client cannot override a locked value even by crafting the request.

### A5. Data model — `safe_audits` + `safe_settings` (Neon, self-created via `ensureTables()` like `tickets.mjs`)

**`safe_settings`** — per-store locked expected cash: `store_pc text PRIMARY KEY`, `expected_petty_cash numeric NOT NULL`, `set_by_user_id int`, `set_by_name text`, `set_at timestamptz`, `updated_by_user_id int`, `updated_by_name text`, `updated_at timestamptz`.

**`safe_audits`** —

`id bigint PK` (client Date.now()), `store_pc text`, `store_name text`, `auditor_user_id int`, `auditor_name text`, `auditor_role text`, `status text default 'draft'`, `started_at`, `submitted_at`, `reason text`, `safe_code text`, `code_last_changed text`, `store_manager_name text`, `district int`, `expected_petty_cash numeric`, `has_receipts bool`, `receipts_total numeric`, `receipt_photo_keys jsonb default '[]'`, `bill_counts jsonb default '{}'`, `coin_counts jsonb default '{}'`, `bills_total numeric`, `coins_total numeric`, `counted_total numeric`, `accounted_total numeric`, `variance numeric`, `variance_status text`, `has_counterfeit bool`, `counterfeit_total numeric`, `counterfeit_photo_keys jsonb default '[]'`, `conductor_sig_key text`, `manager_sig_key text`, `manager_ack_name text`, `notes text`, `created_at`, `updated_at`. Documented in `db/schema.ts`.

Photos & signatures use the existing chunked blob path (`cloudSaveFile`); the row stores keys only. Signature keys: `safe_<id>_sig_conductor` / `safe_<id>_sig_manager`.

### A6. API — `netlify/functions/safe-audits.mjs` (POST `{action,...}`, auth via `requireActiveUser`)

- `list {storePC?}` → role-scoped rows (id, store, auditor, submittedAt, expected, countedTotal, variance, varianceStatus, hasCounterfeit, status).
- `get {id}` → full row (role-checked).
- `safeSetting {storePC}` → `{ expected|null, locked: bool, canEdit: bool, setByName, setAt }` — `locked` = a setting exists; `canEdit` = caller is executive/it. Drives the form's read-only/editable state.
- `setSafeExpected {storePC, expected}` → **executive/it only**; upserts `safe_settings` and stamps `updated_by`/`updated_at`. The "edit later" path.
- `saveDraft {id?, ...fields}` → conduct roles only; upserts draft (id = client Date.now()). Ignores any client `expected` when a locked setting exists and caller isn't exec/it.
- `submit {id}` → conduct roles only; recomputes totals/variance server-side (never trust client math) against the **authoritative** expected (first submit sets `safe_settings` via `ON CONFLICT DO NOTHING` then re-reads; later submits read the locked value), locks (`status='submitted'`), fires A4 notification. Returns the finalized row.
- Server recomputes cash math with the same lib so the stored totals are authoritative.
- Reason/status validated; access enforced per A1 in every action; expected-cash edits gated to exec/it per A8.

### A7. Frontend

- `AuditsTab` gains segment state; renders the Field Ops views (existing) and a new Safe path. Managers see Safe only; the tab is added to `getTabs` for managers and to the manager sidebar section.
- Safe views: **list** (store, date, conductor, expected, counted, variance badge, counterfeit flag), **conduct** (the A2 form: denomination grid with live totals, conditional receipt/counterfeit photo blocks, signature pad, GPS-free), **report** (PDF-styled layout matching the sample PDFs, variance badge, photos, signatures) with html2pdf export → `safe_audit_<storePC>_<yyyy-mm-dd>.pdf`.
- **Expected-cash field behavior** (A8): on store select, the form calls `safeSetting`. If `locked` and not `canEdit` → the expected field is read-only, pre-filled, with a lock icon + "Set by X on <date>". If not locked (first audit) → editable input with a note "This becomes the locked expected amount for this store." If `canEdit` (exec/it) → always editable; changing it calls `setSafeExpected`.
- Signature pad: a small canvas component (pointer/touch draw, Clear, export PNG dataURL → `cloudSaveFile`).
- All calls go through a `safeAuditsApi(action, body)` wrapper that includes `credentials:'include'` **and** `...authHeader()` (the Bearer token — this was the v18.41 lesson).

---

## PART B — District-Label Cleanup

**Goal:** everywhere a district is displayed as "District N" or "DN", show the DM's first name: "District 1 - Taylor" / "D1 - Taylor".

- **Source:** the live `districts` state (falls back to `DISTRICTS_SEED`), which already maps `num → { name, email }`. First name = `name.split(' ')[0]`. Build on the existing `dmFirstName(districts, num)` helper.
- **New helper** `districtLabel(districts, num, { short } = {})`:
  - long → `District ${num} - ${first}` ; short → `D${num} - ${first}`.
  - No DM/name → falls back to `District ${num}` / `D${num}` (no trailing dash).
- **Sweep** every district-label render site (~39 `District ${...}` / `D${...}` template sites plus the audit dashboard and any dropdowns), replacing ad-hoc construction with `districtLabel(...)`. Preserve each site's existing short/long form — just append the DM first name. Dropdowns currently showing the full DM name switch to first name for a uniform look (flag on review if full names are wanted in the admin selector).
- Separator is a hyphen `-` per the request (existing dropdowns using em-dash `—` normalize to hyphen).
- The Safe Audit UI (Part A) uses `districtLabel` for its district field, so both parts stay consistent.

---

## Testing

- `safe-cash.test.js`: denomination math (counts→value, blanks/N-A→0), totals, variance status bands, cent-rounding (no float drift), threshold boundary.
- Existing suite stays green; `npm run build` clean.
- Manual: manager conducts a Safe Audit on their store (draft autosaves, denomination totals live, receipt+counterfeit conditionals, signature capture, submit → variance badge + PDF); a short count beyond $5 emails the DM+VP; DM/office_staff see the correct scope; district labels read "District N - First" across dashboard, sidebar, Safe form, and reports.

## Out of scope (phase 2)

Safe-audit trend analytics/dashboard, recurring-shortage detection per store/manager, a standalone "Safe Cash Settings" admin screen (exec/it edit the locked amount inline on the form for now), editable district→DM admin UI (the map is seeded/loaded as today).
