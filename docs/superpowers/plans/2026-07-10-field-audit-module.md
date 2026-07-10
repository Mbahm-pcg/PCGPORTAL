# Field Operations Audit Module (v1 Core Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scored store-audit module to the PCG portal: a new `auditor` role conducts four-pillar audits in the field, failed items auto-spawn corrective actions (CAPs) that only the auditor/executive can verify-close, and leadership gets a heatmap/trend/repeat-finding dashboard.

**Architecture:** Pure logic (scoring, CAP state machine, template) lives in `netlify/functions/audit-lib/` as tested CommonJS modules. One modern `.mjs` function (`audits.mjs`, patterned on `tickets.mjs`) owns the Postgres tables and an action-based POST API with server-side role enforcement via `auth-lib/require-user`. A daily cron flips overdue CAPs and escalates. Frontend is a new `AuditsTab` component tree in `app.jsx` registered through `getTabs()`.

**Tech Stack:** Netlify Functions (Node), Neon Postgres (`@neondatabase/serverless`), Netlify Blobs (photos), React 18 via esbuild bundle (`app.jsx` → `app.js`), `node:test` for unit tests, jspdf/html2pdf (CDN globals) for PDF export.

**Spec:** `docs/superpowers/specs/2026-07-10-field-audit-module-design.md`

## Global Constraints

- Section weights: Food Safety **40%**, Brand Standards & Guest Experience **25%**, Facility Appearance & Maintenance **20%**, Safety & Liability **15%**.
- Any failed `critical` item caps the total score at **69**; set `cappedByCritical: true`.
- Score bands: 90+ Excellent · 80–89 Pass · 70–79 Needs Improvement · ≤69 Fail (colors: green `#22c55e` / yellow / red per existing labor-threshold convention in `src/theme.js`).
- CAP statuses: `open` → `owner_resolved` → `verified_closed`; `overdue` set by cron when `deadline` passes unverified. Verify-close allowed for `auditor`, `executive`, `it` only.
- New userType string: `auditor` (label "Field Operations Auditor").
- DM sees only their district, read-only. Manager sees only their store. Enforced **server-side** in `audits.mjs`, not just UI.
- Audits lock at submit; unlock is `executive`/`it` only and recorded (`unlocked_by`, `unlocked_at`).
- Bump `APP_VERSION` in `app.jsx` on every frontend change (current: `v18.32`; use the next unused number at execution time — check `grep -m1 'const APP_VERSION' app.jsx`).
- Always `npm run build` and commit **both** `app.jsx` and `app.js` (plus `src/*` if touched).
- All work on branch `feature/audits-module`. Do NOT deploy to production (`npx netlify deploy --prod`) until Mike approves the final task.
- Functions style: new function files are modern `.mjs` (default export + `Response`, like `tickets.mjs`); shared libs are CommonJS (like `deal-lib`), tested with `node:test`.

---

### Task 1: Audit template data (`audit-lib/template.js`)

**Files:**
- Create: `netlify/functions/audit-lib/template.js`
- Test: `netlify/functions/audit-lib/template.test.js`
- Modify: `package.json` (add `'netlify/functions/audit-lib/*.test.js'` to the `test` script globs)

**Interfaces:**
- Produces: `TEMPLATE_V1` (object), `validateTemplate(tpl)` (returns `[]` or array of error strings).
- `TEMPLATE_V1` shape (consumed by Tasks 2, 4, 6–8):

```js
{
  version: 1,
  name: 'PCG Standard Store Audit',
  type: 'standard',
  sections: [
    { id: 'food_safety', name: 'Food Safety & Sanitation', weight: 0.40, items: [
      { id: 'fs_temp_logs',   text: 'Temperature logs current and complete (all units, all dayparts)', points: 4, critical: false, guidance: 'Check cooler/freezer logs for today and prior 7 days.' },
      { id: 'fs_cold_chain',  text: 'Cold-holding units at ≤41°F; no cold-chain break', points: 5, critical: true,  guidance: 'Spot-check 2 units with probe thermometer.' },
      { id: 'fs_hot_hold',    text: 'Hot-holding/hold times followed; expired product discarded', points: 4, critical: true,  guidance: '' },
      { id: 'fs_date_label',  text: 'Date labeling & FIFO rotation correct in all storage areas', points: 4, critical: false, guidance: '' },
      { id: 'fs_allergen',    text: 'Allergen controls: separation, utensils, labeling', points: 4, critical: false, guidance: '' },
      { id: 'fs_handwash',    text: 'Handwashing observed; sinks stocked and accessible', points: 5, critical: true,  guidance: 'Blocked hand sink = critical.' },
      { id: 'fs_hygiene',     text: 'Personal hygiene: gloves, hair restraints, no bare-hand contact', points: 4, critical: false, guidance: '' },
      { id: 'fs_chemicals',   text: 'Chemical storage separated from food; SDS accessible', points: 3, critical: false, guidance: '' },
      { id: 'fs_pest',        text: 'No pest activity; traps/logs current; doors sealed', points: 4, critical: true,  guidance: 'Active infestation = critical + imminent hazard.' },
      { id: 'fs_servsafe',    text: 'Certified food protection manager coverage for shift', points: 3, critical: false, guidance: '' },
    ]},
    { id: 'brand_guest', name: 'Brand Standards & Guest Experience', weight: 0.25, items: [
      { id: 'bg_coffee',      text: 'Coffee freshness timers honored; brew per standard', points: 4, critical: false, guidance: '' },
      { id: 'bg_espresso',    text: 'Espresso calibration current (shot time/yield in range)', points: 3, critical: false, guidance: '' },
      { id: 'bg_build',       text: 'Product build accuracy & portioning to spec (sample 3 products)', points: 4, critical: false, guidance: '' },
      { id: 'bg_sos',         text: 'Speed of service: drive-thru and front counter within target', points: 4, critical: false, guidance: 'Observe 10 minutes at peak if possible.' },
      { id: 'bg_accuracy',    text: 'Order accuracy spot-check', points: 3, critical: false, guidance: '' },
      { id: 'bg_uniform',     text: 'Crew appearance/uniform standards met', points: 3, critical: false, guidance: '' },
      { id: 'bg_merch',       text: 'Merchandising, POP, and menu boards current and accurate', points: 3, critical: false, guidance: '' },
      { id: 'bg_foh_clean',   text: 'Front-of-house cleanliness: lobby, counters, beverage station', points: 4, critical: false, guidance: '' },
    ]},
    { id: 'facility', name: 'Facility Appearance & Maintenance', weight: 0.20, items: [
      { id: 'fa_signage',     text: 'Exterior signage lit, clean, intact', points: 3, critical: false, guidance: '' },
      { id: 'fa_curb',        text: 'Curb appeal: landscaping, parking lot, trash enclosure', points: 3, critical: false, guidance: '' },
      { id: 'fa_drive_thru',  text: 'Drive-thru lane, menu board, and speaker condition', points: 3, critical: false, guidance: '' },
      { id: 'fa_interior',    text: 'Interior condition: walls, floors, ceiling, lighting', points: 3, critical: false, guidance: '' },
      { id: 'fa_equipment',   text: 'Equipment operational; no unreported failures', points: 4, critical: false, guidance: 'Cross-check against open maintenance tickets.' },
      { id: 'fa_restrooms',   text: 'Restrooms clean, stocked, functional', points: 4, critical: false, guidance: '' },
      { id: 'fa_deferred',    text: 'No unrouted deferred-maintenance or capital needs observed', points: 2, critical: false, guidance: 'Route findings to facilities/construction.' },
    ]},
    { id: 'safety', name: 'Safety & Liability', weight: 0.15, items: [
      { id: 'sl_floors',      text: 'Wet-floor protocol followed; floors clean/dry; mats placed', points: 4, critical: false, guidance: 'Slip/trip/fall exposure.' },
      { id: 'sl_ppe',         text: 'PPE available and used (cut gloves, oven mitts)', points: 3, critical: false, guidance: '' },
      { id: 'sl_ladder',      text: 'Ladder/step-stool condition and safe use', points: 2, critical: false, guidance: '' },
      { id: 'sl_fire',        text: 'Fire safety: extinguishers tagged, hood/duct cleaning current', points: 4, critical: true,  guidance: 'Expired extinguisher or overdue hood cleaning = critical.' },
      { id: 'sl_egress',      text: 'Egress paths clear and exit signs lit', points: 4, critical: true,  guidance: 'Blocked egress = critical + imminent hazard.' },
      { id: 'sl_electrical',  text: 'No electrical hazards (exposed wiring, overloaded outlets)', points: 3, critical: true,  guidance: '' },
      { id: 'sl_signage_doc', text: 'Required safety signage posted; training docs & incident kit on site', points: 3, critical: false, guidance: '' },
    ]},
  ],
}
```

- [ ] **Step 1: Write the failing test** — `netlify/functions/audit-lib/template.test.js`:

```js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { TEMPLATE_V1, validateTemplate } = require('./template');

describe('TEMPLATE_V1', () => {
  test('weights sum to 1.0', () => {
    const sum = TEMPLATE_V1.sections.reduce((a, s) => a + s.weight, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });
  test('has the four spec sections in order', () => {
    assert.deepStrictEqual(TEMPLATE_V1.sections.map(s => s.id),
      ['food_safety', 'brand_guest', 'facility', 'safety']);
    assert.deepStrictEqual(TEMPLATE_V1.sections.map(s => s.weight), [0.40, 0.25, 0.20, 0.15]);
  });
  test('item ids are globally unique and every item has positive points', () => {
    const ids = TEMPLATE_V1.sections.flatMap(s => s.items.map(i => i.id));
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const s of TEMPLATE_V1.sections) for (const i of s.items) assert.ok(i.points > 0);
  });
  test('critical items exist in food_safety and safety', () => {
    const crit = (sid) => TEMPLATE_V1.sections.find(s => s.id === sid).items.some(i => i.critical);
    assert.ok(crit('food_safety') && crit('safety'));
  });
});

describe('validateTemplate', () => {
  test('accepts TEMPLATE_V1', () => assert.deepStrictEqual(validateTemplate(TEMPLATE_V1), []));
  test('rejects bad weights and duplicate ids', () => {
    const bad = JSON.parse(JSON.stringify(TEMPLATE_V1));
    bad.sections[0].weight = 0.5;
    assert.ok(validateTemplate(bad).some(e => /weight/i.test(e)));
    const dup = JSON.parse(JSON.stringify(TEMPLATE_V1));
    dup.sections[0].items[1].id = dup.sections[0].items[0].id;
    assert.ok(validateTemplate(dup).some(e => /duplicate/i.test(e)));
  });
});
```

- [ ] **Step 2: Run to verify failure** — `node --test 'netlify/functions/audit-lib/*.test.js'` → FAIL (`Cannot find module './template'`).
- [ ] **Step 3: Implement `template.js`** — export the `TEMPLATE_V1` object exactly as in the Interfaces block above, plus:

```js
function validateTemplate(tpl) {
  const errors = [];
  if (!tpl || !Array.isArray(tpl.sections) || !tpl.sections.length) return ['no sections'];
  const sum = tpl.sections.reduce((a, s) => a + (s.weight || 0), 0);
  if (Math.abs(sum - 1.0) > 1e-9) errors.push(`section weights sum to ${sum}, expected 1.0`);
  const seen = new Set();
  for (const s of tpl.sections) {
    if (!s.id || !s.name || !Array.isArray(s.items) || !s.items.length) errors.push(`section ${s.id || '?'} malformed`);
    for (const i of (s.items || [])) {
      if (seen.has(i.id)) errors.push(`duplicate item id: ${i.id}`);
      seen.add(i.id);
      if (!(i.points > 0)) errors.push(`item ${i.id} has non-positive points`);
      if (typeof i.critical !== 'boolean') errors.push(`item ${i.id} missing critical flag`);
    }
  }
  return errors;
}
module.exports = { TEMPLATE_V1, validateTemplate };
```

- [ ] **Step 4: Run tests** — `node --test 'netlify/functions/audit-lib/*.test.js'` → all PASS.
- [ ] **Step 5: Add glob to `package.json` test script** (append `'netlify/functions/audit-lib/*.test.js'` inside the existing `test` value), run `npm test` → full suite passes.
- [ ] **Step 6: Commit** — `git add netlify/functions/audit-lib package.json && git commit -m "feat(audits): seeded v1 audit template + validation"`

---

### Task 2: Scoring engine (`audit-lib/scoring.js`)

**Files:**
- Create: `netlify/functions/audit-lib/scoring.js`
- Test: `netlify/functions/audit-lib/scoring.test.js`

**Interfaces:**
- Consumes: `TEMPLATE_V1` shape from Task 1.
- Produces: `computeScore(template, results)` where `results = { [itemId]: 'pass'|'fail'|'na' }` → `{ score: number(0–100, 1dp), sectionScores: { [sectionId]: number|null }, cappedByCritical: boolean, band: 'excellent'|'pass'|'needs_improvement'|'fail' }`; and `bandFor(score)`.
- Rules: N/A items excluded from both numerator and denominator. A section with all items N/A gets `sectionScores[id] = null` and its weight is **redistributed proportionally** across scored sections. Missing result = `fail` (unanswered items can't pass silently). Critical fail → `score = Math.min(score, 69)`.

- [ ] **Step 1: Write the failing test** — `scoring.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure** — `node --test 'netlify/functions/audit-lib/scoring.test.js'` → FAIL.
- [ ] **Step 3: Implement `scoring.js`:**

```js
// scoring.js — pure audit scoring math. See spec §5.
function bandFor(score) {
  if (score >= 90) return 'excellent';
  if (score >= 80) return 'pass';
  if (score >= 70) return 'needs_improvement';
  return 'fail';
}

function computeScore(template, results) {
  const sectionScores = {};
  let cappedByCritical = false;
  const scored = []; // { id, weight, pct }
  for (const s of template.sections) {
    let earned = 0, possible = 0;
    for (const i of s.items) {
      const r = results[i.id] || 'fail'; // unanswered = fail
      if (r === 'na') continue;
      possible += i.points;
      if (r === 'pass') earned += i.points;
      else if (i.critical) cappedByCritical = true;
    }
    if (possible === 0) { sectionScores[s.id] = null; continue; }
    const pct = (earned / possible) * 100;
    sectionScores[s.id] = Math.round(pct * 10) / 10;
    scored.push({ id: s.id, weight: s.weight, pct });
  }
  const weightSum = scored.reduce((a, x) => a + x.weight, 0) || 1;
  let score = scored.reduce((a, x) => a + x.pct * (x.weight / weightSum), 0);
  score = Math.round(score * 10) / 10;
  if (cappedByCritical) score = Math.min(score, 69);
  return { score, sectionScores, cappedByCritical, band: bandFor(score) };
}
module.exports = { computeScore, bandFor };
```

- [ ] **Step 4: Run tests** — `node --test 'netlify/functions/audit-lib/*.test.js'` → all PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(audits): weighted scoring engine with critical auto-fail"`

---

### Task 3: CAP state machine (`audit-lib/caps.js`)

**Files:**
- Create: `netlify/functions/audit-lib/caps.js`
- Test: `netlify/functions/audit-lib/caps.test.js`

**Interfaces:**
- Produces:
  - `CAP_STATUSES = ['open', 'owner_resolved', 'verified_closed', 'overdue']`
  - `canTransition(userType, isOwner, from, to)` → boolean. Allowed: owner (or auditor/executive/it) `open|overdue → owner_resolved`; only `auditor|executive|it` `owner_resolved → verified_closed`; `auditor|executive|it` may also reopen `owner_resolved → open` (rejected fix).
  - `defaultDeadline(severity, nowMs)` → ISO string. `critical` = +48h, `high` = +72h, else +7 days.
  - `isOverdue(cap, nowMs)` → true only for status `open` (or already `overdue`) with `deadline < now`; `owner_resolved` and `verified_closed` are never overdue.

- [ ] **Step 1: Write the failing test** — `caps.test.js`:

```js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { canTransition, defaultDeadline, isOverdue } = require('./caps');

describe('canTransition', () => {
  test('owner can resolve their open or overdue CAP', () => {
    assert.ok(canTransition('manager', true, 'open', 'owner_resolved'));
    assert.ok(canTransition('manager', true, 'overdue', 'owner_resolved'));
  });
  test('non-owner manager cannot resolve someone else\'s CAP', () => {
    assert.ok(!canTransition('manager', false, 'open', 'owner_resolved'));
  });
  test('only auditor/executive/it can verify-close, and only from owner_resolved', () => {
    for (const ut of ['auditor', 'executive', 'it'])
      assert.ok(canTransition(ut, false, 'owner_resolved', 'verified_closed'));
    assert.ok(!canTransition('manager', true, 'owner_resolved', 'verified_closed'));
    assert.ok(!canTransition('dm', false, 'owner_resolved', 'verified_closed'));
    assert.ok(!canTransition('auditor', false, 'open', 'verified_closed'));
  });
  test('auditor can reject a resolution back to open', () => {
    assert.ok(canTransition('auditor', false, 'owner_resolved', 'open'));
    assert.ok(!canTransition('manager', true, 'owner_resolved', 'open'));
  });
  test('closed is terminal', () => {
    assert.ok(!canTransition('executive', false, 'verified_closed', 'open'));
  });
});

describe('defaultDeadline', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  test('critical 48h, high 72h, default 7d', () => {
    assert.strictEqual(defaultDeadline('critical', now), '2026-07-12T12:00:00.000Z');
    assert.strictEqual(defaultDeadline('high', now), '2026-07-13T12:00:00.000Z');
    assert.strictEqual(defaultDeadline('medium', now), '2026-07-17T12:00:00.000Z');
  });
});

describe('isOverdue', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  test('open past deadline is overdue; resolved/closed never are', () => {
    assert.ok(isOverdue({ status: 'open', deadline: '2026-07-09T12:00:00Z' }, now));
    assert.ok(!isOverdue({ status: 'open', deadline: '2026-07-11T12:00:00Z' }, now));
    assert.ok(!isOverdue({ status: 'owner_resolved', deadline: '2026-07-01T12:00:00Z' }, now));
    assert.ok(!isOverdue({ status: 'verified_closed', deadline: '2026-07-01T12:00:00Z' }, now));
  });
});
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement:**

```js
// caps.js — CAP lifecycle rules. See spec §6.
const CAP_STATUSES = ['open', 'owner_resolved', 'verified_closed', 'overdue'];
const VERIFIERS = new Set(['auditor', 'executive', 'it']);

function canTransition(userType, isOwner, from, to) {
  if (from === 'verified_closed') return false;
  if ((from === 'open' || from === 'overdue') && to === 'owner_resolved')
    return isOwner || VERIFIERS.has(userType);
  if (from === 'owner_resolved' && to === 'verified_closed') return VERIFIERS.has(userType);
  if (from === 'owner_resolved' && to === 'open') return VERIFIERS.has(userType); // reject fix
  return false;
}

const HOURS = { critical: 48, high: 72 };
function defaultDeadline(severity, nowMs) {
  const h = HOURS[severity] || 24 * 7;
  return new Date(nowMs + h * 3600 * 1000).toISOString();
}

function isOverdue(cap, nowMs) {
  if (cap.status !== 'open' && cap.status !== 'overdue') return false;
  return Date.parse(cap.deadline) < nowMs;
}
module.exports = { CAP_STATUSES, canTransition, defaultDeadline, isOverdue };
```

- [ ] **Step 4: Run** `node --test 'netlify/functions/audit-lib/*.test.js'` → PASS. `npm test` → full suite green.
- [ ] **Step 5: Commit** — `git commit -am "feat(audits): CAP state machine with auditor-only verify-close"`

---

### Task 4: `audits.mjs` API function + schema

**Files:**
- Create: `netlify/functions/audits.mjs`
- Modify: `db/schema.ts` (append drizzle documentation of the four tables, same doc-only style as the `maintTickets` block)

**Interfaces:**
- Consumes: `audit-lib/template.js`, `scoring.js`, `caps.js` (via `createRequire` since libs are CJS), `auth-lib/require-user.js` (`requireActiveUser`).
- Produces (all POST `{ action, ... }` to `/.netlify/functions/audits`, auth via `pcg_session` cookie / Bearer — send `credentials: 'include'` from the frontend):
  - `template` → `{ ok, template }` (active template).
  - `list { storePC? }` → `{ ok, audits: [...] }` — rows filtered by role: auditor/executive/it/office_staff = all; dm = their district's stores; manager = their store. Each row: `{ id, storePC, auditorName, status, submittedAt, score, band, cappedByCritical }`.
  - `get { id }` → `{ ok, audit, items, caps }` (same role filter).
  - `saveDraft { id?, storePC, results, notes, photos }` → `{ ok, id }` — auditor only. `results = { [itemId]: { result, severity?, note?, photoKeys? } }` stored as jsonb.
  - `submit { id, lat, lng }` → `{ ok, audit, capsCreated }` — auditor only. Computes score via `computeScore`, locks (`status='submitted'`), inserts one `audit_caps` row per failed item (owner = store manager user id if resolvable, else null → auditor assigns in UI; deadline via `defaultDeadline`).
  - `unlock { id }` → `{ ok }` — executive/it only; sets `unlocked_by/unlocked_at`, status back to `draft`.
  - `capUpdate { id, to, note?, photoKeys?, ownerUserId?, deadline? }` → `{ ok, cap }` — transition guarded by `canTransition`; owner/deadline edits auditor/executive/it only.
  - `dashboard` → `{ ok, latestByStore, trend, coverage, repeats, capBoard }` — auditor/executive/it/office_staff full; dm district-filtered. `repeats` = items failed in ≥2 of last 3 audits per store (chronic) and items failed at ≥5 stores in trailing 60 days (systemic).
- Tables (created via `ensureTables()` `CREATE TABLE IF NOT EXISTS`, pattern of `tickets.mjs`): `audit_templates(id serial PK, version int, name text, type text, sections jsonb, active bool, created_at)`, `audits(id bigint PK /* client Date.now() */, template_id int, store_pc text, auditor_user_id int, auditor_name text, status text default 'draft', started_at, submitted_at, submit_lat real, submit_lng real, score real, section_scores jsonb, capped_by_critical bool default false, results jsonb default '{}', notes text, unlocked_by text, unlocked_at, created_at, updated_at)`, `audit_caps(id text PK /* 'cap_<auditId>_<itemId>' */, audit_id bigint, template_item_id text, item_text text, section_id text, severity text, store_pc text, owner_user_id int, owner_name text, deadline timestamptz, status text default 'open', owner_note text, owner_photo_keys jsonb default '[]', resolved_at, verified_by text, verified_at, escalated_at, created_at, updated_at)`. Photos: blob keys in jsonb; upload itself reuses the existing `storage.js` chunked path (frontend Task 6).
- On first run, `ensureTables` seeds `audit_templates` with `TEMPLATE_V1` if the table is empty.

- [ ] **Step 1: Write `audits.mjs`.** Skeleton (complete the action handlers per the Interfaces block — each is a short `sql` query + role guard):

```js
// audits.mjs — Field Operations Audit module API. Pattern: tickets.mjs.
import { neon } from '@neondatabase/serverless';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requireActiveUser } = require('./auth-lib/require-user');
const { TEMPLATE_V1 } = require('./audit-lib/template');
const { computeScore } = require('./audit-lib/scoring');
const { canTransition, defaultDeadline } = require('./audit-lib/caps');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });
let _sql = null; const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

const FULL_VIEW = new Set(['auditor', 'executive', 'it', 'office_staff']);
const CAN_AUDIT = new Set(['auditor', 'executive', 'it']); // exec/it can audit in a pinch
const CAN_UNLOCK = new Set(['executive', 'it']);

let _ready = false;
async function ensureTables() { /* CREATE TABLE IF NOT EXISTS × 3 + seed template — per Interfaces block */ }

// Role-scoped WHERE fragment: returns { storePCs:[..] } | 'all' | 'none'
async function visibleStores(user, sql) {
  if (FULL_VIEW.has(user.userType)) return 'all';
  if (user.userType === 'dm') { /* SELECT store list for user.district from users/STORES source used elsewhere; store district mapping lives in the frontend STORES array — mirror the pc→district map into this function as AUDIT_STORES const */ }
  if (user.userType === 'manager') return { storePCs: [String(user.storePC || '')] };
  return 'none';
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });
  const sql = db(); await ensureTables();
  const event = { headers: Object.fromEntries(req.headers.entries()) };
  const user = await requireActiveUser(event, sql);
  if (!user) return json(401, { ok: false, error: 'auth required' });
  const body = await req.json().catch(() => ({}));
  switch (body.action) {
    case 'template':  { /* return active template row */ }
    case 'list':      { /* role-filtered SELECT on audits */ }
    case 'get':       { /* audit + its caps, role-checked */ }
    case 'saveDraft': { /* CAN_AUDIT only; upsert draft row */ }
    case 'submit':    { /* CAN_AUDIT only; computeScore; lock; insert caps */ }
    case 'unlock':    { /* CAN_UNLOCK only */ }
    case 'capUpdate': { /* canTransition guard; write transition fields */ }
    case 'dashboard': { /* aggregates incl. repeat-finding queries */ }
    default: return json(400, { ok: false, error: 'unknown action' });
  }
};
```

Key implementation notes the engineer must follow:
  - `submit` computes results map for scoring as `{ [itemId]: r.result }` from the stored jsonb, then `computeScore(template.sections ? template : TEMPLATE_V1, results)`.
  - CAP ids: `` `cap_${auditId}_${itemId}` `` — idempotent if submit retries.
  - Repeat findings (chronic) SQL: for each store, take the last 3 submitted audits, count per `template_item_id` failures ≥2 — doable in one query with `ROW_NUMBER() OVER (PARTITION BY store_pc ORDER BY submitted_at DESC) <= 3` on a lateral join of jsonb results, but a simple approach is: `list` the last-3 audit rows per store in JS and count fails from their `results` jsonb. Given 45 stores this is fine — do it in JS inside the `dashboard` action, not SQL gymnastics.
  - The store→district map: copy the `pc`/`district` pairs from the `STORES` array in `app.jsx` (search `const STORES`) into an `AUDIT_STORES` const at the top of `audits.mjs` with a comment referencing CLAUDE.md gotcha #9 (duplicated store config — keep in sync).

- [ ] **Step 2: Smoke-test locally** — `npx netlify dev` in one terminal, then:

```bash
curl -s -X POST http://localhost:8888/.netlify/functions/audits -H 'Content-Type: application/json' -d '{"action":"template"}'
```

Expected: `{"ok":false,"error":"auth required"}` (401 — auth wall works). Full authed testing happens via the UI in Task 6.
- [ ] **Step 3: Append doc-block table definitions to `db/schema.ts`** (comment-documented like `maintTickets`, noting `audits.mjs` self-creates them).
- [ ] **Step 4: Commit** — `git add netlify/functions/audits.mjs db/schema.ts && git commit -m "feat(audits): audits API function with role-scoped access and CAP creation"`

---

### Task 5: `audit-cap-cron.mjs` (overdue flip + escalation)

**Files:**
- Create: `netlify/functions/audit-cap-cron.mjs`
- Modify: `netlify.toml` (add schedule block)

**Interfaces:**
- Consumes: `audit_caps` table (Task 4), `isOverdue` from `audit-lib/caps.js`, existing `notify.js` email pattern and `push.js` send pattern (read those two files and reuse their internal send helpers the way `deal-alerts-cron` does — copy its import/require approach exactly).
- Behavior (daily 11:00 UTC = 7am ET): (1) `UPDATE audit_caps SET status='overdue' WHERE status='open' AND deadline < now()` returning rows; (2) for newly-overdue rows with `escalated_at IS NULL`, send one digest email/push per owner ("Your CAPs due/overdue") and one escalation to VP (`executive` users) + the store's district DM, then set `escalated_at=now()`; (3) also include CAPs due in the next 48h in the owner digest (no escalation).

- [ ] **Step 1: Read `netlify/functions/deal-alerts-cron.js`** and mirror its structure (schedule export, email assembly, recipient lookup from `users` table).
- [ ] **Step 2: Implement `audit-cap-cron.mjs`** per the behavior above.
- [ ] **Step 3: Add to `netlify.toml`:**

```toml
# Audit CAP escalation — daily 7am ET: flip overdue, digest owners, escalate VP/DM
[functions.audit-cap-cron]
  schedule = "0 11 * * *"
```

- [ ] **Step 4: Local trigger test** — with `npx netlify dev` running: `curl -s -X POST http://localhost:8888/.netlify/functions/audit-cap-cron` → expect `{ ok: true, overdue: 0, ... }` on an empty table (and no emails sent when nothing is overdue — guard sends behind `rows.length`).
- [ ] **Step 5: Commit** — `git add netlify/functions/audit-cap-cron.mjs netlify.toml && git commit -m "feat(audits): daily CAP overdue cron with owner digest + VP/DM escalation"`

---

### Task 6: Frontend — `auditor` role, Audits tab, field audit flow

**Files:**
- Modify: `app.jsx` — (a) `getTabs()` (~line 19377): add `{ id: 'audits', label: 'Audits', icon: (c) => ICONS.audits(c) }` to executive/it and office_staff branches; add a new top-level branch for `ut === 'auditor'` returning BASE_TABS + audits/pulse/map/tickets (read scope enforced server-side); add audits (read-only) to the dm branch; (b) add `auditor` to every userType option list (locate with `grep -n "office_staff" app.jsx` — every place office_staff appears in a `<option>`/label map, add `auditor` → "Field Operations Auditor"); (c) new `AuditsTab` component + `{tab === 'audits' && <AuditsTab …/>}` routing (search `{tab ===` for the routing block); (d) bump `APP_VERSION`.
- Modify: `src/icons.jsx` — add `audits` icon (clipboard-check SVG, same stroke style as existing `ICONS.reports`).

**Interfaces:**
- Consumes: `/.netlify/functions/audits` actions from Task 4 (`template`, `list`, `get`, `saveDraft`, `submit`). All calls: `fetch('/.netlify/functions/audits', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ... }) })`.
- Produces: `AuditsTab({ user, th })` with three internal views (`view` state): `'list'` (default), `'conduct'`, `'report'` (Task 7 fills report/dashboard). This task delivers list + conduct.

Conduct-flow requirements (all concrete, no interpretation):
- Store picker: reuse the existing `STORES` array; auditor picks store → `saveDraft` creates the draft (id = `Date.now()`).
- Checklist renders one section at a time with a sticky section header showing `name` + running section score; progress bar = answered/total across all sections.
- Item row: item text + guidance line (muted), three buttons **Pass / Fail / N/A** (min touch target 44px, `btn(th)` helper, selected state uses band colors: pass=green, fail=red, na=gray). Fail expands: severity `<select>` (`low/medium/high/critical` — default `critical` if item.critical else `medium`), note `<textarea>`, photo `<input type="file" accept="image/*" capture="environment" multiple>` uploading via the existing chunked `storage.js` path (search `chunked` in app.jsx for the helper used by Projects doc upload; reuse it, keys like `audit_${auditId}_${itemId}_${n}`).
- Autosave: `useEffect` on results state → debounce 1.5s → write to `localStorage['pcg_audit_draft_' + id]` immediately and fire `saveDraft` (fire-and-forget; last-write-wins). On mount with a draft id, hydrate from server, fall back to localStorage if fetch fails (dead-zone tolerance).
- Submit: confirm dialog listing unanswered count (they score as fail), then `navigator.geolocation.getCurrentPosition` (10s timeout; on failure submit with `lat/lng = null` — GPS is evidence, not a blocker), call `submit`, clear localStorage draft, show the score screen with band color + CAP count, offer "View report".

- [ ] **Step 1: Add icon + `auditor` role option lists + getTabs branches** (locations found via the greps above).
- [ ] **Step 2: Build `AuditsTab` list view** — table of audits (`list` action): store, date, auditor, score chip (band color), status; "New Audit" button visible only when `user.userType` ∈ auditor/executive/it.
- [ ] **Step 3: Build conduct view** per requirements above.
- [ ] **Step 4: `npm run build`** → verify no esbuild errors; bump `APP_VERSION`; rebuild.
- [ ] **Step 5: Manual verification** — `npx netlify dev`, log in as an IT user, create an `auditor` test user in Admin, log in as auditor (separate browser profile), run a full audit against a test store: verify autosave survives a page reload mid-audit, fail item requires severity, submit produces score and CAPs (check `list`/`get` responses in devtools), audit is locked after submit.
- [ ] **Step 6: Commit** — `git add app.jsx app.js src/icons.jsx && git commit -m "feat(audits): auditor role, Audits tab, field audit conduct flow (vX.XX)"`

---

### Task 7: Frontend — audit report view, CAP board, manager surface

**Files:**
- Modify: `app.jsx` — extend `AuditsTab` with `'report'` view + `'caps'` view; add CAP card to the manager My Store mobile mode (search `StoreTabletView`/My Store section, follow how tickets surface there); bump `APP_VERSION`.

**Interfaces:**
- Consumes: `get`, `capUpdate` actions; `canTransition` semantics (UI mirrors server rules: resolve button for owner on open/overdue; verify-close + reject buttons for auditor/executive/it on owner_resolved).
- Produces: report view = header (store, date, auditor, GPS badge, score dial in band color, "CAPPED — critical failure: <item>" banner when `cappedByCritical`), per-section score bars, findings list (photo thumbnails → lightbox, note, severity chip), CAP list with status/owner/deadline. CAP board view = filterable table (status, district, owner) with overdue rows highlighted red; row expand → resolution note/photo + action buttons per role.
- PDF export button on the report view: render via the `html2pdf` CDN global against a print-styled container div (pattern: search `html2pdf` in app.jsx for existing export usage and mirror it), filename `audit_<storePC>_<yyyy-mm-dd>.pdf`.

- [ ] **Step 1: Build report view** per Interfaces.
- [ ] **Step 2: Build CAP board + transitions** — resolve (note + photo required), verify-close, reject-to-open. Errors from `capUpdate` (403 on bad transition) surface as a toast, matching existing error toast usage.
- [ ] **Step 3: Manager My Store surface** — "Open CAPs (n)" card listing their store's open/overdue CAPs with the resolve flow.
- [ ] **Step 4: PDF export button.**
- [ ] **Step 5: Build + bump `APP_VERSION` + manual verify** — as manager: resolve a CAP with photo; as auditor: reject it (goes back to open), owner re-resolves, auditor verifies-close; export a PDF and open it.
- [ ] **Step 6: Commit** — `git add app.jsx app.js && git commit -m "feat(audits): report view, CAP board with verified closure, manager CAP surface, PDF export (vX.XX)"`

---

### Task 8: Frontend — leadership dashboard

**Files:**
- Modify: `app.jsx` — add `'dashboard'` view to `AuditsTab` (default landing view for executive/it/auditor when audits exist); bump `APP_VERSION`.

**Interfaces:**
- Consumes: `dashboard` action (Task 4): `{ latestByStore: [{ storePC, name, district, score, band, submittedAt }], trend: [{ month, avgScore, byDistrict }], coverage: [{ storePC, name, daysSince | null }], repeats: { chronic: [{ storePC, itemId, itemText, failCount }], systemic: [{ itemId, itemText, storeCount }] }, capBoard: { open, overdue, byOwner: [...], avgDaysToClose } }`.
- Produces four stacked panels (each a `card(th)`):
  1. **Portfolio heatmap** — store tiles grouped by district, tile color = band (mirror the Labor store-grid layout; search `AdminLabor` grid for the tile pattern). Click tile → that store's latest report.
  2. **Trend** — line chart via `window.Chart` (CDN global, pattern: search `new Chart(` in app.jsx): portfolio avg + per-district lines by month.
  3. **Coverage + systemic flags** — "Never audited / oldest audits" list (feeds the 90-day baseline), chronic and systemic repeat-finding lists with store/district attribution. Manager-level ranking visible only to executive/it/auditor (hide for office_staff, dm).
  4. **CAP board summary** — open/overdue counts, top owners by open CAPs, avg time-to-close.
- DM users get the same dashboard filtered server-side to their district, minus cross-district comparison (trend shows their district + portfolio average only) and minus manager rankings.

- [ ] **Step 1: Implement the `dashboard` action aggregates in `audits.mjs`** (if not fully done in Task 4 — finish here; JS aggregation over the last-3-audits-per-store rows as noted in Task 4).
- [ ] **Step 2: Build the four panels.**
- [ ] **Step 3: Build + bump `APP_VERSION` + manual verify** — submit ≥3 audits across ≥2 stores with a repeated failed item; confirm the chronic flag appears, heatmap colors match bands, dm login sees only their district.
- [ ] **Step 4: Commit** — `git add app.jsx app.js netlify/functions/audits.mjs && git commit -m "feat(audits): leadership dashboard — heatmap, trends, repeat-finding detection, CAP board (vX.XX)"`

---

### Task 9: Final verification + deploy gate

- [ ] **Step 1: Full test suite** — `npm test` → green.
- [ ] **Step 2: Fresh build** — `npm run build`, confirm `git status` shows only intended files, final `APP_VERSION` bump if needed.
- [ ] **Step 3: End-to-end pass on `npx netlify dev`** — one complete loop: auditor audits store → critical fail caps score → CAP created → manager resolves → auditor verifies-close → dashboard reflects it → PDF exports.
- [ ] **Step 4: Push branch** — `git push -u origin feature/audits-module`. **STOP: ask Mike before merging to main or running `npx netlify deploy --prod`** (production deploy also creates the new Postgres tables on first request and activates the cron).

---

## Self-Review Notes

- Spec coverage: §2 roles → Tasks 4 (server) + 6 (UI); §3 schema → Task 4; §4 field flow → Task 6; §5 scoring → Task 2; §6 CAP → Tasks 3/4/5/7; §7 dashboard → Task 8; §8 report/PDF → Task 7; §10 conventions → Global Constraints; §11 testing → Tasks 1–3 unit + 6–9 manual.
- Deliberate deviations from spec, for consistency with the live codebase: audit ids are client `Date.now()` bigints (maint-tickets pattern) instead of serial; item results stored as jsonb on the audit row instead of a separate `audit_items` table (matches `tickets.mjs` denormalized style, halves the query surface); CAP table named `audit_caps` (avoids collision risk with any future generic `caps`). Spec's intent (immutable trail, per-item findings, verified closure) is preserved.
