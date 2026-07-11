# Safe Audit + District-Label Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Safe Audit (cash/petty-cash reconciliation) audit type — count-based cash entry with auto-math, per-store locked expected cash, over/short with shortage alerts, signatures, PDF — accessible to managers/DMs/auditors/above; plus a site-wide district-label cleanup so districts read "District N - <DM first name>".

**Architecture:** A pure cash-math lib (`audit-lib/safe-cash.js`, tested) is the single source of truth for totals/variance, used by both the server and the client. A dedicated `safe-audits.mjs` function owns two Neon tables (`safe_audits`, `safe_settings`) and an action API with server-side role scoping and server-authoritative math + expected-cash lock. Frontend adds a Field Ops/Safe toggle inside the existing Audits tab. The district cleanup adds one module-level `districtLabel()` helper and sweeps ~31 render sites.

**Tech Stack:** Netlify Functions (.mjs, default export + Response), Neon Postgres (`@neondatabase/serverless`), Netlify Blobs (photos/signatures via `cloudSaveFile`), React 18 via esbuild (`app.jsx` → `app.js`), `node:test`, html2pdf (CDN global) for PDF, Resend + web-push (reuse `audit-cap-cron.mjs` send helpers).

**Spec:** `docs/superpowers/specs/2026-07-11-safe-audit-design.md` (binding — read first)

## Global Constraints

- Bill denominations: `hundreds 100, fifties 50, twenties 20, tens 10, fives 5, ones 1`. Coin denominations: `halfDollars 0.50, quarters 0.25, dimes 0.10, nickels 0.05, pennies 0.01`. Inputs are **counts** (non-negative integers; blank/`''`/`'N/A'`/null → 0).
- `variance = (countedTotal + receiptsTotal) − expected`. Status: `balanced` if `|variance| ≤ 0.50` (DISPLAY_TOLERANCE), `short` if `< −0.50`, `over` if `> +0.50`. Money math in integer cents to avoid float drift.
- Shortage alert threshold: **$5.00** (SHORTAGE_ALERT_THRESHOLD). On submit, notify the store's district DM + all executives when `variance ≤ −5.00` OR `hasCounterfeit`. Over never alerts.
- Reason options: `Random, Scheduled, Cash Discrepancy, Manager Change, Shift Change, Other`.
- Access (server-enforced every action): conduct (saveDraft/submit) = manager (own store) / dm (their district) / auditor / executive / it, OR `auditsAccess==='full'`. View (list/get) = those + office_staff (all read-only), OR `auditsAccess` truthy. Expected-cash edit = **executive/it only**.
- Expected petty cash is per-store (`safe_settings`), set on first submit, then read-only except for exec/it. Server computes variance against the stored value (`ON CONFLICT (store_pc) DO NOTHING` on first submit, then re-read).
- Conductor signature required to submit; manager/witness signature + name optional.
- District labels: `districtLabel(num,{short})` → long `District N - First`, short `DN - First`; no DM name → `District N`/`DN` with no dash. Separator is hyphen `-`.
- Every new `fetch` to a hardened function from app.jsx includes `credentials:'include'` AND `...authHeader()` (the v18.41 lesson).
- `APP_VERSION` (currently `v18.41`) bumped once per frontend-touching task to the next unused value; rebuild `app.js`; commit both.
- Branch `feature/safe-audit`; no push to main / no deploy without Mike's explicit approval. Existing test suite (211) must stay green; new lib tests join the `audit-lib/*.test.js` glob.

---

### Task 1: Cash-math library (`audit-lib/safe-cash.js`)

**Files:** Create `netlify/functions/audit-lib/safe-cash.js`, `netlify/functions/audit-lib/safe-cash.test.js`

**Interfaces (produces):**
- `BILL_VALUES = { hundreds:100, fifties:50, twenties:20, tens:10, fives:5, ones:1 }`, `COIN_VALUES = { halfDollars:0.50, quarters:0.25, dimes:0.10, nickels:0.05, pennies:0.01 }`
- `DISPLAY_TOLERANCE = 0.50`, `SHORTAGE_ALERT_THRESHOLD = 5.00`, `REASONS = ['Random','Scheduled','Cash Discrepancy','Manager Change','Shift Change','Other']`
- `toCount(v)` → non-negative integer (blank/`''`/`'N/A'`/null/negative/NaN → 0)
- `computeCashTotals(billCounts, coinCounts)` → `{ billsTotal, coinsTotal, countedTotal }` (numbers, 2dp, cent-accurate)
- `computeVariance({ countedTotal, receiptsTotal, expected })` → `{ accountedTotal, variance, status }` (status ∈ balanced/short/over)
- `shouldAlert({ variance, hasCounterfeit })` → boolean (`variance <= -SHORTAGE_ALERT_THRESHOLD || !!hasCounterfeit`)

- [ ] **Step 1: Write the failing test** — `safe-cash.test.js`:

```js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { BILL_VALUES, COIN_VALUES, DISPLAY_TOLERANCE, SHORTAGE_ALERT_THRESHOLD, REASONS,
        toCount, computeCashTotals, computeVariance, shouldAlert } = require('./safe-cash');

describe('toCount', () => {
  test('normalizes blanks/NA/negatives to 0, floors to int', () => {
    for (const v of ['', null, undefined, 'N/A', 'n/a', -3, NaN, 'abc']) assert.strictEqual(toCount(v), 0);
    assert.strictEqual(toCount('5'), 5);
    assert.strictEqual(toCount(4.9), 4);
    assert.strictEqual(toCount(10), 10);
  });
});

describe('computeCashTotals', () => {
  test('counts times denomination, cent-accurate (safe audit 3 case)', () => {
    // bills: 3x100 4x50 10x20 3x10 2x5 10x1 = 750 ; coins: 25q 10d 5n 100p = 6.25+1+0.25+1 = 8.50
    const out = computeCashTotals(
      { hundreds:3, fifties:4, twenties:10, tens:3, fives:2, ones:10 },
      { halfDollars:0, quarters:25, dimes:10, nickels:5, pennies:100 });
    assert.strictEqual(out.billsTotal, 750);
    assert.strictEqual(out.coinsTotal, 8.50);
    assert.strictEqual(out.countedTotal, 758.50);
  });
  test('missing/blank denominations treated as 0', () => {
    const out = computeCashTotals({ twenties:'', hundreds:'N/A' }, {});
    assert.strictEqual(out.countedTotal, 0);
  });
  test('no float drift on pennies', () => {
    const out = computeCashTotals({}, { pennies: 3 }); // 0.03 exactly
    assert.strictEqual(out.coinsTotal, 0.03);
  });
});

describe('computeVariance', () => {
  test('balanced within tolerance', () => {
    const r = computeVariance({ countedTotal: 500, receiptsTotal: 0, expected: 500 });
    assert.strictEqual(r.variance, 0); assert.strictEqual(r.status, 'balanced');
  });
  test('receipts count toward accounted', () => {
    const r = computeVariance({ countedTotal: 471.26, receiptsTotal: 28.74, expected: 500 });
    assert.strictEqual(r.accountedTotal, 500); assert.strictEqual(r.status, 'balanced');
  });
  test('short and over past tolerance', () => {
    assert.strictEqual(computeVariance({ countedTotal: 480, receiptsTotal: 0, expected: 500 }).status, 'short');
    assert.strictEqual(computeVariance({ countedTotal: 520, receiptsTotal: 0, expected: 500 }).status, 'over');
    assert.strictEqual(computeVariance({ countedTotal: 499.60, receiptsTotal: 0, expected: 500 }).status, 'balanced');
  });
});

describe('shouldAlert', () => {
  test('alerts on short beyond threshold or counterfeit', () => {
    assert.ok(shouldAlert({ variance: -5.00, hasCounterfeit: false }));
    assert.ok(shouldAlert({ variance: -5.01, hasCounterfeit: false }));
    assert.ok(!shouldAlert({ variance: -4.99, hasCounterfeit: false }));
    assert.ok(!shouldAlert({ variance: 50, hasCounterfeit: false })); // over never alerts
    assert.ok(shouldAlert({ variance: 0, hasCounterfeit: true }));
  });
});

describe('constants', () => {
  test('denominations and reasons match spec', () => {
    assert.strictEqual(BILL_VALUES.hundreds, 100);
    assert.strictEqual(COIN_VALUES.pennies, 0.01);
    assert.strictEqual(DISPLAY_TOLERANCE, 0.50);
    assert.strictEqual(SHORTAGE_ALERT_THRESHOLD, 5.00);
    assert.deepStrictEqual(REASONS, ['Random','Scheduled','Cash Discrepancy','Manager Change','Shift Change','Other']);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `node --test 'netlify/functions/audit-lib/safe-cash.test.js'` → FAIL (module not found).
- [ ] **Step 3: Implement `safe-cash.js`:**

```js
// safe-cash.js — pure cash-count math for Safe Audits. Money in integer cents. See spec §A3.
const BILL_VALUES = { hundreds:100, fifties:50, twenties:20, tens:10, fives:5, ones:1 };
const COIN_VALUES = { halfDollars:0.50, quarters:0.25, dimes:0.10, nickels:0.05, pennies:0.01 };
const DISPLAY_TOLERANCE = 0.50;
const SHORTAGE_ALERT_THRESHOLD = 5.00;
const REASONS = ['Random','Scheduled','Cash Discrepancy','Manager Change','Shift Change','Other'];

function toCount(v) {
  if (v === '' || v == null) return 0;
  const s = String(v).trim();
  if (!s || /^n\/?a$/i.test(s)) return 0;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
const cents = (n) => Math.round(n * 100);
const dollars = (c) => c / 100;

function sumCents(counts, values) {
  let c = 0;
  for (const k of Object.keys(values)) c += toCount(counts && counts[k]) * cents(values[k]);
  return c;
}

function computeCashTotals(billCounts, coinCounts) {
  const bC = sumCents(billCounts, BILL_VALUES);
  const cC = sumCents(coinCounts, COIN_VALUES);
  return { billsTotal: dollars(bC), coinsTotal: dollars(cC), countedTotal: dollars(bC + cC) };
}

function computeVariance({ countedTotal, receiptsTotal, expected }) {
  const acc = cents(countedTotal || 0) + cents(receiptsTotal || 0);
  const varc = acc - cents(expected || 0);
  const tol = cents(DISPLAY_TOLERANCE);
  const status = varc < -tol ? 'short' : varc > tol ? 'over' : 'balanced';
  return { accountedTotal: dollars(acc), variance: dollars(varc), status };
}

function shouldAlert({ variance, hasCounterfeit }) {
  return (Number(variance) <= -SHORTAGE_ALERT_THRESHOLD) || !!hasCounterfeit;
}

module.exports = { BILL_VALUES, COIN_VALUES, DISPLAY_TOLERANCE, SHORTAGE_ALERT_THRESHOLD, REASONS,
                   toCount, computeCashTotals, computeVariance, shouldAlert };
```

- [ ] **Step 4: Run** `node --test 'netlify/functions/audit-lib/*.test.js'` → all PASS; `npm test` → full suite green (the `audit-lib/*.test.js` glob already exists in package.json).
- [ ] **Step 5: Commit** — `git add netlify/functions/audit-lib/safe-cash.* && git commit -m "feat(safe-audit): cash-count math library"`

---

### Task 2: District-label helper + site-wide sweep (`app.jsx`)

**Files:** Modify `app.jsx` (add helper near `DISTRICTS_SEED` ~line 3157 / `dmFirstName` ~3799; add a sync effect in the root `PCGPortal` component; sweep ~31 render sites)

**Interfaces (produces):** `districtLabel(num, { short = false } = {})` → string; `setDistrictsRef(d)` updates the module-level districts source.

Why module-level: several render sites (e.g. `AuditDashboard` ~line 20514, `DashboardCoverage` ~20713) do not receive `districts` as a prop, so threading it everywhere is invasive. A module ref kept in sync by the root component lets every site call `districtLabel(n)` with no new props.

- [ ] **Step 1: Add the helper** near `dmFirstName` (app.jsx ~3799):

```js
// Module-level districts source for districtLabel(), kept in sync by the root
// PCGPortal component (see setDistrictsRef call). Lets any render site label a
// district as "District N - <DM first name>" without threading the districts prop.
let _districtsRef = DISTRICTS_SEED;
function setDistrictsRef(d) { if (d && typeof d === 'object') _districtsRef = d; }
// num → "District N - First" (short: "DN - First"); no DM name → "District N" / "DN".
function districtLabel(num, { short = false } = {}) {
  if (num === null || num === undefined || num === '') return '';
  const d = _districtsRef[num];
  const first = d && d.name ? String(d.name).trim().split(/\s+/)[0] : '';
  const base = short ? `D${num}` : `District ${num}`;
  return first ? `${base} - ${first}` : base;
}
```

- [ ] **Step 2: Sync the ref from the root component.** Find the `PCGPortal` root component's `districts` state (`grep -n "const \[districts, setDistricts\]" app.jsx` → ~39293). Immediately after it, add:

```jsx
  React.useEffect(() => { setDistrictsRef(districts); }, [districts]);
```

Also call `setDistrictsRef(districts)` once synchronously at the top of the component body (before first render) so the very first paint is labeled: add `setDistrictsRef(districts);` right after the `districts` state declaration line.

- [ ] **Step 3: Sweep the render sites.** Run `grep -noE "District \$\{[a-zA-Z0-9_.]+\}|D\$\{[a-zA-Z0-9_.]+\}" app.jsx` to get the current line list (the plan captured 31; verify at execution time). For EACH site, replace the inline template with `districtLabel(<expr>)` (long form) or `districtLabel(<expr>, { short:true })` (the `D${...}` short form). Rules:
  - `` `District ${s.district}` `` → `districtLabel(s.district)` (splice into the surrounding JSX/string).
  - `` `D${d}` `` → `districtLabel(d, { short:true })`.
  - **Verify the expression is a district NUMBER** before converting. Skip and note any site where the interpolated value is not a district number (e.g. an unrelated identifier). Specifically inspect `District ${m.identifier}` (~22516) and `District ${identifier}` (~22627): only convert if `identifier` is the district number; otherwise leave and record in the report.
  - The two admin district `<select>` dropdowns (`grep -n "d.name.split(' ')\\[0\\]\|d.num} — {d.name" app.jsx` → ~5086 shows first name w/ em-dash, ~5146 shows full name w/ em-dash): change both option labels to `{districtLabel(d.num)}` so they read "District N - First" with a hyphen.
  - String-concat site `'District '` (~9997): inspect and convert to `districtLabel(...)` if it's building a district label.
- [ ] **Step 4: Build + version.** `npm run build` (must succeed). Bump `APP_VERSION` "v18.41" → "v18.42". Rebuild.
- [ ] **Step 5: Verify.** `grep -c "districtLabel(" app.jsx` ≥ 31. Spot-read 5 converted sites to confirm valid JSX/strings. Re-read the 2 flagged ambiguous sites and confirm the decision. `npm test` green.
- [ ] **Step 6: Commit** — `git add app.jsx app.js && git commit -m "feat(district): districtLabel helper — show DM first name at every district site (v18.42)"`

---

### Task 3: `safe-audits.mjs` backend + schema

**Files:** Create `netlify/functions/safe-audits.mjs`; modify `db/schema.ts` (doc block for the two tables)

**Interfaces:**
- Consumes: `audit-lib/safe-cash.js` (via `createRequire`), `auth-lib/require-user.js` `requireActiveUser`, `audit-lib/access.js` `effectiveAudits` (for the `auditsAccess` grant composition).
- Produces (POST `{action,...}` to `/.netlify/functions/safe-audits`, auth via Bearer/cookie):
  - `list {storePC?}` → `{ ok, audits:[{ id, storePC, storeName, auditorName, submittedAt, expected, countedTotal, variance, varianceStatus, hasCounterfeit, status }] }` (role-scoped).
  - `get {id}` → `{ ok, audit }` (full row, role-checked).
  - `safeSetting {storePC}` → `{ ok, expected, locked, canEdit, setByName, setAt }`.
  - `setSafeExpected {storePC, expected}` → exec/it only → `{ ok, expected }`.
  - `saveDraft {id?, storePC, ...fields}` → conduct roles only → `{ ok, id }`.
  - `submit {id}` → conduct roles only → `{ ok, audit, alerted }`.

Patterns to mirror (read before writing): `netlify/functions/audits.mjs` (ensureTables, visibleStores/role scoping, requireActiveUser usage, AUDIT_STORES pc→district map, createRequire for CJS libs, transaction, JSON responses); `netlify/functions/audit-cap-cron.mjs` (the `sendEmail`/`sendPush` helpers + recipient lookup from `users` — copy their approach for the shortage notification).

Key implementation notes:
- `ensureTables()` creates `safe_audits` and `safe_settings` (DDL per spec §A5) with `CREATE TABLE IF NOT EXISTS`.
- Role helpers: `safeCanConduct(userType, grant)` = `['manager','dm','auditor','executive','it'].includes(userType) || grant==='full'`; `safeCanView(userType, grant)` = `safeCanConduct(...) || userType==='office_staff' || !!grant`; `canEditExpected(userType)` = `['executive','it'].includes(userType)`.
- `visibleStoresSafe(user)`: manager → `[storePC]`; dm → district stores (from AUDIT_STORES, copied from audits.mjs — comment ref CLAUDE.md gotcha #9); auditor/exec/it/office_staff → 'all'; grant `'full'`/`'view'` → 'all'.
- `submit`: load draft; recompute `computeCashTotals` + `computeVariance` server-side; resolve authoritative expected — `INSERT INTO safe_settings (store_pc, expected_petty_cash, set_by_user_id, set_by_name, set_at) VALUES (...) ON CONFLICT (store_pc) DO NOTHING`, then `SELECT expected_petty_cash FROM safe_settings WHERE store_pc=...`; compute variance vs that; store all computed fields; `status='submitted'`; if `shouldAlert(...)` send email+push to the store's district DM (users where user_type='dm' and district=store district) + all `executive` users. Guard sends behind the condition.
- `saveDraft`: when a locked setting exists and `!canEditExpected(user.userType)`, ignore any client `expected` (use the locked value); a first-audit draft may carry the entered expected but it is NOT locked until submit.
- `setSafeExpected`: `canEditExpected` only; upsert with `updated_by_*`/`updated_at`.
- All SQL parameterized (neon tagged templates). CAP-style store→district via AUDIT_STORES const.

- [ ] **Step 1:** Read `audits.mjs` + `audit-cap-cron.mjs`. Write `safe-audits.mjs` implementing every action per the Interfaces + notes above (no stub handlers).
- [ ] **Step 2: Smoke test** — `npx netlify dev` (if the sandbox blocks Neon as in prior tasks, substitute `node --check netlify/functions/safe-audits.mjs` + a small node script exercising the pure role helpers, and note the substitution). Authed test: `curl -s -X POST http://localhost:8888/.netlify/functions/safe-audits -d '{"action":"list"}'` → `{"ok":false,"error":"auth required"}` (401 wall).
- [ ] **Step 3:** Append `safe_audits` + `safe_settings` doc block to `db/schema.ts` (comment style like `maintTickets`).
- [ ] **Step 4: Commit** — `git add netlify/functions/safe-audits.mjs db/schema.ts && git commit -m "feat(safe-audit): backend API — tables, role-scoped actions, per-store locked expected, shortage alerts"`

---

### Task 4: Frontend — mode toggle, Safe list, Safe conduct form

**Files:** Modify `app.jsx` (AuditsTab + new Safe components + getTabs manager visibility + manager sidebar section)

**Interfaces:**
- Consumes: `safe-audits.mjs` actions (Task 3), `safe-cash.js` denomination/reason constants (import a browser copy — see note), `districtLabel` (Task 2).
- Produces: `SafeAuditsPane({ user, th, stores })` with `list` / `conduct` views; a `safeAuditsApi(action, body)` wrapper; a `SignaturePad` component.

Notes:
- **safeAuditsApi** — mirror `auditsApi` exactly incl. `credentials:'include'` and `...authHeader()`:
  ```js
  async function safeAuditsApi(action, body = {}) {
    const res = await fetch("/.netlify/functions/safe-audits", { method:"POST", credentials:"include",
      headers:{ "Content-Type":"application/json", ...authHeader() }, body: JSON.stringify({ action, ...body }) });
    let json = null; try { json = await res.json(); } catch {}
    if (!res.ok || (json && json.ok === false)) throw new Error((json && json.error) || `safe ${action} failed (${res.status})`);
    return json || {};
  }
  ```
- **Denomination/reason constants for the client:** define a small `SAFE_BILLS`/`SAFE_COINS`/`SAFE_REASONS` const block in app.jsx (same values as `safe-cash.js` — the lib is CJS and not bundled into the browser; duplicate the values with a comment pointing at `audit-lib/safe-cash.js` as the source of truth, like the store-list duplication gotcha). Compute live totals client-side for display only; the server is authoritative on submit.
- **Mode toggle:** in `AuditsTab`, compute `canFieldOps = auditCanView(user)` (existing) and `canSafe = ['manager','dm','auditor','executive','it'].includes(user.userType) || user.auditsAccess`. Render a segmented "Field Ops / Safe" control only when both are true; if only Safe, render `SafeAuditsPane` directly; if only Field Ops, existing behavior. Manager → Safe only.
- **getTabs:** add the audits tab for `manager` (they currently lack it) — extend the manager branch in `computeRoleTabs`/`getTabs`. Confirm the manager sidebar section (`grep "Manager section"` ~line 41488) renders it (it renders all non-base tabs, so it will appear once getTabs returns it).
- **Expected-cash field:** on store select in conduct, call `safeSetting(storePC)`. Render expected as read-only (lock icon + "Set by X on date") when `locked && !canEdit`; editable input with "This becomes the locked expected for this store" when `!locked`; editable for `canEdit` (exec/it) with a save that calls `setSafeExpected`.
- **Conduct form:** the A2 sections — reason `<select>` (SAFE_REASONS), safe code + last-changed date, store manager name, district (auto from store, shown via `districtLabel`), expected (per above), receipts Yes/No → photo upload (`cloudSaveFile`, keys `safe_${id}_receipt_${n}`) + receipts total, denomination grid (count inputs; live billsTotal/coinsTotal/countedTotal; live variance badge), counterfeit Yes/No → photo + total, SignaturePad(s), notes. Draft autosave (debounced `saveDraft`, localStorage fallback) mirroring the Field Ops conduct pattern. Submit → `submit` → show variance result + "View report".
- **SignaturePad:** minimal canvas component:
  ```jsx
  function SignaturePad({ th, onCapture, label }) {
    const ref = React.useRef(null); const drawing = React.useRef(false);
    const pos = (e) => { const r = ref.current.getBoundingClientRect(); const t = e.touches ? e.touches[0] : e; return { x: t.clientX - r.left, y: t.clientY - r.top }; };
    const start = (e) => { drawing.current = true; const c = ref.current.getContext('2d'); const p = pos(e); c.beginPath(); c.moveTo(p.x, p.y); e.preventDefault(); };
    const move = (e) => { if (!drawing.current) return; const c = ref.current.getContext('2d'); const p = pos(e); c.lineTo(p.x, p.y); c.stroke(); e.preventDefault(); };
    const end = () => { drawing.current = false; };
    const clear = () => { const c = ref.current; c.getContext('2d').clearRect(0,0,c.width,c.height); onCapture(null); };
    const save = () => { onCapture(ref.current.toDataURL('image/png')); };
    return (<div>
      <div style={{ fontSize:'0.8rem', color: th.muted, marginBottom:4 }}>{label}</div>
      <canvas ref={ref} width={320} height={120} style={{ border:`1px solid ${th.border}`, borderRadius:8, touchAction:'none', background:'#fff' }}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end} onBlur={save} />
      <div style={{ display:'flex', gap:8, marginTop:4 }}>
        <button type="button" onClick={save} style={btn(th)}>Save signature</button>
        <button type="button" onClick={clear} style={btn(th,{ ghost:true })}>Clear</button>
      </div>
    </div>);
  }
  ```
  Convert the captured dataURL to a Blob and store via `cloudSaveFile(`safe_${id}_sig_conductor`, blob, user.name)`; store the returned key on the row. Conductor signature required before submit is enabled.
- Bump `APP_VERSION` to next value; `npm run build`.

- [ ] **Step 1:** Add `safeAuditsApi`, `SAFE_BILLS/COINS/REASONS`, `SignaturePad`, `SafeAuditsPane` (list + conduct).
- [ ] **Step 2:** Wire the mode toggle in `AuditsTab`; add audits tab to managers in `getTabs`.
- [ ] **Step 3:** Implement the expected-cash lock behavior + denomination grid live math + conditional photo blocks + signatures + autosave + submit.
- [ ] **Step 4:** `npm run build`, bump `APP_VERSION`, rebuild. Verification: build clean + traced re-read of the full flow (store select → safeSetting → fill → denomination totals → receipts/counterfeit conditionals → signature → submit) against the Task 3 contract; if `netlify dev` + DB available, do a live pass. Note substitution if DB blocked.
- [ ] **Step 5: Commit** — `git add app.jsx app.js && git commit -m "feat(safe-audit): Safe mode toggle, list, conduct form with locked expected + signatures (vX.XX)"`

---

### Task 5: Frontend — Safe report view + PDF export

**Files:** Modify `app.jsx` (add `report` view to `SafeAuditsPane`)

**Interfaces:** Consumes `get` (Task 3). Produces a report view matching the sample-PDF layout.

Notes:
- Report layout (mirror the sample PDFs): header (store, address if available, auditor + role, start/end/submitted, duration if tracked), General Info, Store Info (district via `districtLabel`), Petty Cash (expected, receipts total, denomination breakdown table with per-line values + bills/coins/counted totals), Accounted + **variance badge** (OVER/SHORT/BALANCED, colored green/red/amber), counterfeit block (if any) with total, receipt & counterfeit photo thumbnails → lightbox (reuse the Field Ops thumbnail/`cloudLoadFile` pattern), signature images (render the stored signature blobs), notes.
- PDF export button: `html2pdf` CDN global against a print-styled container (mirror the Field Ops `exportPdf`), filename `safe_audit_${storePC}_${yyyyMMdd}.pdf`; toast if the global is missing.
- Bump `APP_VERSION`; `npm run build`.

- [ ] **Step 1:** Build the report view + variance badge + photo/signature rendering.
- [ ] **Step 2:** PDF export.
- [ ] **Step 3:** `npm run build`, bump `APP_VERSION`, rebuild; verify (build + traced re-read; live pass if DB available).
- [ ] **Step 4: Commit** — `git add app.jsx app.js && git commit -m "feat(safe-audit): report view + PDF export (vX.XX)"`

---

### Task 6: Final verification + deploy gate

- [ ] **Step 1:** `npm test` → green. Fresh `npm run build` → `git status` shows only intended files.
- [ ] **Step 2:** Final whole-branch review (spec coverage, security: every safe-audits action role-scoped + expected-edit gated to exec/it; district sweep didn't convert non-district identifiers; server-authoritative math + lock; SQL parameterized; auth headers present).
- [ ] **Step 3:** If `netlify dev` + DB reachable: one live pass — first audit sets+locks expected; second audit shows it read-only; a short-by-$5 submit alerts DM+VP; manager scoped to own store; district labels read "District N - First" across dashboard/sidebar/form/report; PDF opens.
- [ ] **Step 4:** Push branch. **STOP: ask Mike before merge to main / `npx netlify deploy --prod`** (first prod request creates the two tables).

---

## Self-Review Notes

- Spec coverage: A1 access → Tasks 3 (server) + 4 (toggle/visibility); A2 form → Task 4; A3 math → Task 1; A4 alert → Task 3; A5 tables → Task 3; A6 API → Task 3; A7 frontend → Tasks 4-5; A8 locked expected → Task 3 (server authority) + 4 (UI); Part B district labels → Task 2. Testing → Task 1 unit + Tasks 4-6 manual.
- Deliberate deviations (consistent with the codebase, mirroring Field Ops): client re-declares denomination/reason constants (browser can't import the CJS lib — same pattern as duplicated store lists, CLAUDE.md gotcha #9); ids are client `Date.now()` bigints; the module-level `districtLabel` ref instead of prop-threading (justified: dashboard render sites lack a `districts` prop).
- Type consistency: `computeCashTotals`/`computeVariance`/`shouldAlert`/`toCount` signatures identical across Tasks 1, 3, 4. `districtLabel(num,{short})` identical across Tasks 2, 4, 5. `safeAuditsApi(action, body)` identical across Tasks 4, 5.
