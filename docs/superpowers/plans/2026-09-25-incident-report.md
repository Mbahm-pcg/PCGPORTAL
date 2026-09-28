# Workplace Incident Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any logged-in non-kiosk Portal user file a Workplace Incident Report (matching PCG's existing paper template) from inside the Portal, store it in Postgres, and export it as a PDF with embedded photo evidence — with IT able to hide the whole feature per role via the existing Admin → Access matrix.

**Architecture:** A pure-logic module (`src/incident-report.mjs`, no I/O, unit-tested) holds evidence/people-list shaping and the view-permission rule. A thin Netlify function (`netlify/functions/incident-reports.mjs`) does the Postgres I/O and calls into that pure module for the permission check. The frontend is one new tab, wired into `app.jsx`'s existing tab system exactly like every other tab, using the existing chunked-blob file helpers (`cloudSaveFile`/`cloudLoadFile`) for photo/video attachments and `html2pdf` for the PDF export (same pattern as the Store Directory / Audit PDF exports already in the app).

**Tech Stack:** React 18 (inline in `app.jsx`), Neon Postgres via `@neondatabase/serverless`, Netlify Functions (ESM), `html2pdf.js` (already loaded via CDN in `index.html`), Node's built-in `node --test` for the pure module.

**Spec:** `docs/superpowers/specs/2026-09-25-incident-report-design.md`

## Global Constraints

- Edit `app.jsx` only via the Edit tool — never PowerShell (corrupts UTF-8 encoding) and never edit `app.js` directly (it's the build output).
- After editing `app.jsx`/`src/*`, run `npm run build` so `app.js` matches before anything is committed.
- Bump the `APP_VERSION` constant in `app.jsx` (search `const APP_VERSION =`) once, as part of this feature (minor/last-digit bump — this is one feature addition, not a batch of unrelated tweaks).
- Reports are insert-only: no update/delete action on `incident_reports`, and no UI to edit a filed report.
- `prepared_by_user_id`, `prepared_by_name`, and `report_date` are ALWAYS stamped server-side from the authenticated session — the function must ignore any client-supplied values for those three fields, even though the client sends a full object.
- The new tab is added to `computeRoleTabs` for: `executive`, `it`, `office_staff`, `auditor`, `dm`, `manager`, `construction`, `maintenance`, `vendor`. It is deliberately NOT added for `kiosk_pulse`, `kiosk_upload`, or `store_tablet`.
- New tab icon must be new (`ICONS.incident`) — never reuse an existing tab's icon.
- Single commit, single push at the end, covering the whole feature — do not push to production without asking first.

---

### Task 1: Pure logic module

**Files:**
- Create: `src/incident-report.mjs`
- Test: `src/incident-report.test.mjs`

**Interfaces:**
- Produces: `DEFAULT_EVIDENCE_ITEMS`, `buildEvidenceList(checkedIds, customLabels)`, `autofillFromStore(store)`, `splitPeopleForPdf(people)`, `canViewReport(report, caller)`, `filterVisibleReports(reports, caller)` — all consumed by Task 2 (server) and Task 5 (frontend form/PDF shaping).

- [ ] **Step 1: Write the failing tests**

Create `src/incident-report.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EVIDENCE_ITEMS, buildEvidenceList, autofillFromStore,
  splitPeopleForPdf, canViewReport, filterVisibleReports,
} from './incident-report.mjs';

test('buildEvidenceList: keeps default items with their checked state, appends custom labels as checked', () => {
  const checkedIds = DEFAULT_EVIDENCE_ITEMS.filter(i => i.defaultChecked).map(i => i.id);
  const result = buildEvidenceList(checkedIds, ['Broken equipment photo']);
  assert.equal(result.length, DEFAULT_EVIDENCE_ITEMS.length + 1);
  const custom = result.find(r => r.label === 'Broken equipment photo');
  assert.ok(custom && custom.checked === true);
});

test('buildEvidenceList: unchecking a default item is respected', () => {
  const result = buildEvidenceList([], []);
  assert.ok(result.every(r => r.checked === false));
});

test('buildEvidenceList: blank/whitespace-only custom labels are dropped', () => {
  const result = buildEvidenceList([], ['  ', '', 'Real note']);
  assert.equal(result.filter(r => !DEFAULT_EVIDENCE_ITEMS.some(d => d.label === r.label)).length, 1);
});

test('autofillFromStore: pulls PC#, address, and legal entity name from a store record', () => {
  const store = { pc: '337839', name: 'Warrington', address: '334 Easton Rd', city: 'Warrington', state: 'PA', zip: '18976', legal: '334 Warrington Hospitality LLC' };
  const result = autofillFromStore(store);
  assert.deepEqual(result, {
    storePC: '337839', storeName: 'Warrington',
    address: '334 Easton Rd, Warrington, PA 18976',
    operatingEntity: '334 Warrington Hospitality LLC',
  });
});

test('autofillFromStore: null store returns blank fields, never throws', () => {
  const result = autofillFromStore(null);
  assert.deepEqual(result, { storePC: '', storeName: '', address: '', operatingEntity: '' });
});

test('splitPeopleForPdf: one merged list becomes a parties list and a contact list', () => {
  const people = [
    { name: 'Priti Khetani', role: 'Tripped over her leg', phone: '(267) 632-3973', email: 'priteeuk510@gmail.com' },
    { name: 'Rasheena Bruce', role: 'Called 911', phone: '(267) 325-8270', email: 'rasheenabruce80@gmail.com' },
  ];
  const { parties, contacts } = splitPeopleForPdf(people);
  assert.deepEqual(parties, [
    { name: 'Priti Khetani', role: 'Tripped over her leg' },
    { name: 'Rasheena Bruce', role: 'Called 911' },
  ]);
  assert.deepEqual(contacts, [
    { name: 'Priti Khetani', phone: '(267) 632-3973', email: 'priteeuk510@gmail.com' },
    { name: 'Rasheena Bruce', phone: '(267) 325-8270', email: 'rasheenabruce80@gmail.com' },
  ]);
});

test('splitPeopleForPdf: rows with no name are skipped from both lists', () => {
  const { parties, contacts } = splitPeopleForPdf([{ name: '  ', role: 'x', phone: '1', email: 'a@b.com' }]);
  assert.equal(parties.length, 0);
  assert.equal(contacts.length, 0);
});

test('canViewReport: exec/IT can view any report', () => {
  const report = { preparedByUserId: '999' };
  assert.equal(canViewReport(report, { userType: 'executive', sub: '1' }), true);
  assert.equal(canViewReport(report, { userType: 'it', sub: '1' }), true);
});

test('canViewReport: the author can view their own report', () => {
  const report = { preparedByUserId: '42' };
  assert.equal(canViewReport(report, { userType: 'manager', sub: '42' }), true);
});

test('canViewReport: a different non-exec/IT user cannot view someone else\'s report', () => {
  const report = { preparedByUserId: '42' };
  assert.equal(canViewReport(report, { userType: 'manager', sub: '7' }), false);
});

test('filterVisibleReports: exec/IT gets every report, others get only their own', () => {
  const reports = [{ preparedByUserId: '1' }, { preparedByUserId: '2' }];
  assert.equal(filterVisibleReports(reports, { userType: 'it', sub: '9' }).length, 2);
  assert.equal(filterVisibleReports(reports, { userType: 'manager', sub: '2' }).length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/incident-report.test.mjs`
Expected: FAIL — `Cannot find module './incident-report.mjs'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/incident-report.mjs`:

```js
// src/incident-report.mjs
// Pure logic for Workplace Incident Reports — no I/O. Shared by the
// incident-reports.mjs Netlify function (permission check) and the frontend
// form/PDF export (evidence list, people-list shaping, store autofill).

export const DEFAULT_EVIDENCE_ITEMS = [
  { id: 'camera', label: 'Interior security camera footage', defaultChecked: true },
  { id: 'report', label: 'This Workplace Incident Report', defaultChecked: true },
  { id: 'witness', label: 'Witness statements', defaultChecked: false },
];

// Builds the final evidence list to store on the report: every default item
// (checked per checkedIds) plus any non-blank custom labels, always checked
// (a custom row only exists because the user typed it in).
export function buildEvidenceList(checkedIds = [], customLabels = []) {
  const checked = new Set(checkedIds || []);
  const defaults = DEFAULT_EVIDENCE_ITEMS.map(item => ({ label: item.label, checked: checked.has(item.id) }));
  const custom = (customLabels || [])
    .map(l => String(l || '').trim())
    .filter(Boolean)
    .map(label => ({ label, checked: true }));
  return [...defaults, ...custom];
}

// Given a STORES-shaped record (pc/name/address/city/state/zip/legal), returns
// the fields the incident-report form auto-fills. Never throws on a missing store.
export function autofillFromStore(store) {
  if (!store) return { storePC: '', storeName: '', address: '', operatingEntity: '' };
  const addressParts = [store.address, store.city, [store.state, store.zip].filter(Boolean).join(' ')].filter(Boolean);
  return {
    storePC: store.pc || '',
    storeName: store.name || '',
    address: addressParts.join(', '),
    operatingEntity: store.legal || '',
  };
}

// One merged people list (name/role/phone/email) becomes the two sections the
// PDF prints, matching the source document's layout — without making the user
// enter each person twice.
export function splitPeopleForPdf(people) {
  const named = (people || []).filter(p => String(p?.name || '').trim());
  return {
    parties: named.map(p => ({ name: p.name.trim(), role: p.role || '' })),
    contacts: named.map(p => ({ name: p.name.trim(), phone: p.phone || '', email: p.email || '' })),
  };
}

// Exec/IT can see any report. Everyone else can see only the report they filed.
export function canViewReport(report, caller) {
  if (!caller) return false;
  if (caller.userType === 'executive' || caller.userType === 'it') return true;
  return String(report?.preparedByUserId ?? '') === String(caller.sub ?? '');
}

export function filterVisibleReports(reports, caller) {
  return (reports || []).filter(r => canViewReport(r, caller));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/incident-report.test.mjs`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit locally is deferred**

Per the Global Constraints (single commit for the whole feature), do NOT commit yet — move to Task 2. (If using subagent-driven-development, each task still commits individually inside the workspace; the "single commit" rule applies to the final push to `main`, reconciled at the end via an interactive rebase/squash before the one push. If executing inline in the main working tree directly, skip per-task commits entirely and commit once at the very end.)

---

### Task 2: Netlify function

**Files:**
- Create: `netlify/functions/incident-reports.mjs`

**Interfaces:**
- Consumes: `canViewReport`, `filterVisibleReports` from `../../src/incident-report.mjs`; `requireActiveUser` from `./auth-lib/require-user.js` (signature: `async requireActiveUser(event, db, opts) -> claims|null`, where `event = { headers: Object.fromEntries(request.headers.entries()) }` and `claims = { sub, username, userType, district, name }`).
- Produces: POST endpoint at `/.netlify/functions/incident-reports` with actions `create`, `list`, `get`.

- [ ] **Step 1: Write the function**

Create `netlify/functions/incident-reports.mjs`:

```js
// incident-reports.mjs — Workplace Incident Reports, backed by Neon Postgres.
// Insert-only: no update/delete action. prepared_by_user_id/prepared_by_name/
// report_date are always stamped server-side from the session on create —
// client-supplied values for those three fields are ignored, so "Report
// Prepared By" can never be spoofed to someone else's name.
import { neon } from '@neondatabase/serverless';
import { requireActiveUser } from './auth-lib/require-user.js';
import { canViewReport, filterVisibleReports } from '../../src/incident-report.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS incident_reports (
    id                  bigint PRIMARY KEY,
    report_date         text,
    prepared_by_user_id text NOT NULL,
    prepared_by_name    text NOT NULL,
    incident_date       text,
    incident_time       text,
    store_pc            text,
    store_name          text,
    address             text,
    operating_entity    text,
    incident_type       text,
    wc_carrier          text,
    wc_claim_number     text,
    reported_injury     text,
    incident_summary    text,
    people              jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence            jsonb NOT NULL DEFAULT '[]'::jsonb,
    attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,
    meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_incident_reports_prepared_by ON incident_reports(prepared_by_user_id)`;
  _ready = true;
}

const toBigInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };

const KNOWN = new Set([
  'id', 'reportDate', 'preparedByUserId', 'preparedByName', 'incidentDate', 'incidentTime',
  'storePC', 'storeName', 'address', 'operatingEntity', 'incidentType', 'wcCarrier',
  'wcClaimNumber', 'reportedInjury', 'incidentSummary', 'people', 'evidence', 'attachments', 'createdAt',
]);

function rowToReport(r) {
  return {
    ...(r.meta || {}),
    id: Number(r.id),
    reportDate: r.report_date ?? undefined,
    preparedByUserId: r.prepared_by_user_id ?? undefined,
    preparedByName: r.prepared_by_name ?? undefined,
    incidentDate: r.incident_date ?? undefined,
    incidentTime: r.incident_time ?? undefined,
    storePC: r.store_pc ?? undefined,
    storeName: r.store_name ?? undefined,
    address: r.address ?? undefined,
    operatingEntity: r.operating_entity ?? undefined,
    incidentType: r.incident_type ?? undefined,
    wcCarrier: r.wc_carrier ?? undefined,
    wcClaimNumber: r.wc_claim_number ?? undefined,
    reportedInjury: r.reported_injury ?? undefined,
    incidentSummary: r.incident_summary ?? undefined,
    people: r.people || [],
    evidence: r.evidence || [],
    attachments: r.attachments || [],
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
  };
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (!action) return json(400, { error: 'Missing action' });

  try {
    await ensureTables();
    const sql = db();
    const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql);
    if (!caller) return json(401, { error: 'Sign in required.' });

    if (action === 'create') {
      const t = payload.report || {};
      const id = toBigInt(t.id) ?? Date.now();
      const meta = {};
      for (const k of Object.keys(t)) if (!KNOWN.has(k)) meta[k] = t[k];
      await sql`
        INSERT INTO incident_reports (
          id, report_date, prepared_by_user_id, prepared_by_name, incident_date, incident_time,
          store_pc, store_name, address, operating_entity, incident_type, wc_carrier,
          wc_claim_number, reported_injury, incident_summary, people, evidence, attachments, meta
        ) VALUES (
          ${id}, ${new Date().toISOString().slice(0, 10)}, ${String(caller.sub)}, ${caller.name || caller.username || 'Unknown'},
          ${t.incidentDate ?? null}, ${t.incidentTime ?? null},
          ${t.storePC ?? null}, ${t.storeName ?? null}, ${t.address ?? null}, ${t.operatingEntity ?? null},
          ${t.incidentType ?? null}, ${t.wcCarrier ?? null}, ${t.wcClaimNumber ?? null},
          ${t.reportedInjury ?? null}, ${t.incidentSummary ?? null},
          ${JSON.stringify(t.people || [])}::jsonb, ${JSON.stringify(t.evidence || [])}::jsonb,
          ${JSON.stringify(t.attachments || [])}::jsonb, ${JSON.stringify(meta)}::jsonb
        )`;
      return json(200, { ok: true, id });
    }

    if (action === 'list') {
      const rows = await sql`SELECT * FROM incident_reports ORDER BY created_at DESC`;
      const all = rows.map(rowToReport);
      return json(200, { ok: true, reports: filterVisibleReports(all, caller) });
    }

    if (action === 'get') {
      const id = toBigInt(payload.id);
      if (id == null) return json(400, { error: 'Missing id' });
      const rows = await sql`SELECT * FROM incident_reports WHERE id = ${id}`;
      if (!rows.length) return json(404, { error: 'Not found' });
      const report = rowToReport(rows[0]);
      if (!canViewReport(report, caller)) return json(404, { error: 'Not found' });
      return json(200, { ok: true, report });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('incident-reports.mjs error:', err);
    return json(500, { error: err.message });
  }
};
```

- [ ] **Step 2: Manually verify against a preview deploy**

There's no local Netlify dev server convention established in this repo's workflow — verification happens via `netlify deploy` (preview, no `--prod`) after Task 5's UI exists to drive it. Note this as deferred to Task 5's verification step rather than testing the bare endpoint with curl now (no UI yet to generate a realistic payload, and this function needs a real session cookie/bearer token to authenticate).

- [ ] **Step 3: Do not commit yet** (see Task 1, Step 5)

---

### Task 3: Icon

**Files:**
- Modify: `src/icons.jsx`

**Interfaces:**
- Produces: `ICONS.incident` — consumed by Task 4's tab definitions.

- [ ] **Step 1: Add the icon**

In `src/icons.jsx`, add a new entry to the `ICONS` object (a clipboard with an exclamation mark — distinct from `notes`, `reports`, `audits`, and `alert`, none of which are currently used as this tab's icon):

```jsx
incident: (c) => <Icon color={c} d={<>{React.createElement("path",{d:"M9 2h6a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"})}{React.createElement("path",{d:"M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"})}{React.createElement("line",{x1:"12",y1:"11",x2:"12",y2:"15"})}{React.createElement("line",{x1:"12",y1:"17.5",x2:"12.01",y2:"17.5"})}</>} />,
```

Place it near `audits` (same clipboard base shape family) for readability, e.g. immediately after the `audits` line.

- [ ] **Step 2: Sanity-check the file still parses**

Run: `npm run build`
Expected: build succeeds (no syntax error). This won't visually confirm the icon yet — that happens in Task 4/5's preview deploy.

---

### Task 4: Tab wiring

**Files:**
- Modify: `app.jsx`

**Interfaces:**
- Consumes: `ICONS.incident` (Task 3).
- Produces: tab id `"incident-reports"`, registered for 9 roles, routed to `<IncidentReportsTab>` (built in Task 5).

- [ ] **Step 1: Add the tab to each role branch in `computeRoleTabs`**

Add `{ id: "incident-reports", label: "Incident Reports", icon: (c) => ICONS.incident(c) }` to the returned array in each of these branches (search for the branch's existing `if (ut === "...")` line, then add the new tab entry anywhere in that branch's array — after `audits` is a natural fit since both are compliance-adjacent):

- `ut === "executive" || ut === "it"` branch (~app.jsx:26832) — add after the `audits` line (~26846).
- `ut === "office_staff"` branch (~26862) — add after its `audits` line (~26876).
- `ut === "auditor"` branch (~26887) — this branch has no `audits` line to anchor on (auditor's tab IS audits) — add after the `audits` line at ~26891.
- `ut === "dm"` branch (~26896) — add after its `audits` line (~26908).
- `ut === "manager"` branch (~26915) — this branch has no separate `audits` entry to anchor on cleanly; add after the `audits` line at ~26928.
- `ut === "construction"` branch (~26932) — add after `project-gallery` (~26938), its last entry.
- `ut === "vendor"` branch (~26941) — add after `chat` (~26946), its last entry.
- `ut === "maintenance"` branch (~26952) — add after `projects` (~26957), its last entry.

For example, the executive/it branch's edit (using the exact existing text as the anchor for the Edit tool):

```
old_string:
    { id: "audits",    label: "Audits",        icon: (c) => ICONS.audits(c) },
    { id: "projects",  label: "Projects",     icon: (c) => ICONS.projects(c) },
```
(this exact two-line sequence is unique to the executive/it branch)
```
new_string:
    { id: "audits",    label: "Audits",        icon: (c) => ICONS.audits(c) },
    { id: "incident-reports", label: "Incident Reports", icon: (c) => ICONS.incident(c) },
    { id: "projects",  label: "Projects",     icon: (c) => ICONS.projects(c) },
```

Do the equivalent for each of the other 7 branches, using enough surrounding context in each `old_string` (the branch's `if (ut === "...")` line plus the anchor tab line) to make the match unique — every branch in `computeRoleTabs` has slightly different surrounding text, so a 2-3 line anchor is enough in each case. Do NOT touch `kiosk_pulse`, `kiosk_upload`, or the final `return BASE_TABS;` fallback (store_tablet and any unhandled role fall through to that fallback and must not get this tab).

- [ ] **Step 2: Add the header subtitle line**

In the subtitle paragraph block (~app.jsx:51363), add:

```
old_string:
                {tab === "tickets"  && "Submit and track maintenance & service tickets."}
new_string:
                {tab === "tickets"  && "Submit and track maintenance & service tickets."}
                {tab === "incident-reports" && "File and review workplace incident reports."}
```

- [ ] **Step 3: Add the routing line**

Near the other tab routes (~app.jsx:51843):

```
old_string:
          {tab === "expenses" && <ExpensesTab user={user} th={th} stores={stores} />}
new_string:
          {tab === "expenses" && <ExpensesTab user={user} th={th} stores={stores} />}
          {tab === "incident-reports" && <IncidentReportsTab user={user} th={th} stores={stores} showAlert={showAlert} />}
```

- [ ] **Step 4: Bump `APP_VERSION`**

At `app.jsx:28272`:

```
old_string:
const APP_VERSION = "v21.12";
new_string:
const APP_VERSION = "v21.13";
```

(Adjust the exact old value if it has moved since this plan was written — search `const APP_VERSION =` to confirm the current value first.)

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: succeeds. `IncidentReportsTab` isn't defined yet (Task 5) — this WILL fail at this point since it's an undefined reference used in JSX. That's expected; Task 5 defines it. If treating Tasks 4 and 5 as strictly sequential single-developer work (not parallel subagents), it's fine to do Task 4's Step 5 build-check immediately after Task 5 exists instead of in isolation. If dispatching as separate subagent tasks, Task 5 must include a stub `function IncidentReportsTab(){ return null; }` placeholder that Task 5 itself immediately replaces — do not leave Task 4 in a broken-build state as a hand-off point between subagents.

---

### Task 5: Frontend — list + form

**Files:**
- Modify: `app.jsx` (add the `IncidentReportsTab` component, defined near `ExpensesTab` for proximity to a similarly-shaped existing tab)

**Interfaces:**
- Consumes: `authHeader()` (imported at the top of `app.jsx` from `./src/portal-auth.mjs`), `cloudSaveFile`/`cloudLoadFile` (defined earlier in `app.jsx`, ~line 8112/8136), `card`/`btn`/`inp`/`pill`/`sectionTitle` helpers, `DEFAULT_EVIDENCE_ITEMS`/`autofillFromStore` — these need importing into `app.jsx` from `./src/incident-report.mjs` alongside the existing imports at the top of the file.
- Produces: `IncidentReportsTab({ user, th, stores, showAlert })`, and stashes the last-created report's id in local state so Task 6 can wire a Download button onto it without re-fetching.

- [ ] **Step 1: Import the pure module into `app.jsx`**

Near the top of `app.jsx`, alongside the existing `import { ... } from './src/portal-auth.mjs';` line, add:

```js
import { DEFAULT_EVIDENCE_ITEMS, buildEvidenceList, autofillFromStore, splitPeopleForPdf } from './src/incident-report.mjs';
```

- [ ] **Step 2: Write the component**

Add this function near `ExpensesTab` (~app.jsx:19957):

```jsx
function IncidentReportsTab({ user, th, stores, showAlert }) {
  const isReviewer = user?.userType === 'executive' || user?.userType === 'it';
  const EMPTY_PEOPLE_ROW = { name: '', role: '', phone: '', email: '' };
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const nowTimeLabel = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const [reports, setReports] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showForm, setShowForm] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const [lastFiledId, setLastFiledId] = React.useState(null);

  const EMPTY_FORM = {
    incidentDate: todayISO(),
    incidentTime: nowTimeLabel(),
    storePC: '', storeName: '', address: '', operatingEntity: '',
    incidentType: '', wcCarrier: '', wcClaimNumber: '', reportedInjury: '',
    incidentSummary: '',
    people: [{ ...EMPTY_PEOPLE_ROW }],
    evidenceChecked: DEFAULT_EVIDENCE_ITEMS.filter(i => i.defaultChecked).map(i => i.id),
    evidenceCustom: [''],
    attachments: [], // [{ file, previewUrl, kind: 'image'|'video' }] before upload
  };
  const [form, setForm] = React.useState(EMPTY_FORM);

  const loadReports = React.useCallback(() => {
    setLoading(true);
    fetch('/.netlify/functions/incident-reports', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'list' }),
    })
      .then(r => r.json())
      .then(j => { if (j?.ok) setReports(j.reports || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  React.useEffect(() => { loadReports(); }, [loadReports]);

  const onPickStore = (pc) => {
    const store = (stores || []).find(s => String(s.pc) === String(pc));
    const auto = autofillFromStore(store);
    setForm(f => ({ ...f, ...auto }));
  };

  const setPersonField = (idx, field, value) => {
    setForm(f => {
      const people = f.people.slice();
      people[idx] = { ...people[idx], [field]: value };
      return { ...f, people };
    });
  };
  const addPersonRow = () => setForm(f => ({ ...f, people: [...f.people, { ...EMPTY_PEOPLE_ROW }] }));
  const removePersonRow = (idx) => setForm(f => ({ ...f, people: f.people.filter((_, i) => i !== idx) }));

  const toggleEvidence = (id) => setForm(f => ({
    ...f,
    evidenceChecked: f.evidenceChecked.includes(id) ? f.evidenceChecked.filter(x => x !== id) : [...f.evidenceChecked, id],
  }));
  const setCustomEvidence = (idx, value) => setForm(f => {
    const evidenceCustom = f.evidenceCustom.slice();
    evidenceCustom[idx] = value;
    return { ...f, evidenceCustom };
  });
  const addCustomEvidenceRow = () => setForm(f => ({ ...f, evidenceCustom: [...f.evidenceCustom, ''] }));

  const onAttachFiles = (fileList) => {
    const files = Array.from(fileList || []);
    const next = files.map(file => ({
      file, kind: file.type.startsWith('video') ? 'video' : 'image',
      previewUrl: URL.createObjectURL(file),
    }));
    setForm(f => ({ ...f, attachments: [...f.attachments, ...next] }));
  };
  const removeAttachment = (idx) => setForm(f => ({ ...f, attachments: f.attachments.filter((_, i) => i !== idx) }));

  const resetForm = () => setForm({ ...EMPTY_FORM, incidentDate: todayISO(), incidentTime: nowTimeLabel() });

  const submit = async () => {
    setError('');
    if (!form.storePC) { setError('Select the incident location.'); return; }
    if (!form.incidentSummary.trim()) { setError('Incident summary is required.'); return; }
    setSubmitting(true);
    try {
      const tempId = Date.now();
      // Upload attachments first (chunked blob helper — same one ticket photos/videos use),
      // storing only the reference on the report row, never the raw file.
      const attachmentRefs = [];
      for (let i = 0; i < form.attachments.length; i++) {
        const a = form.attachments[i];
        const fileKey = `incident_media_${tempId}_${i}`;
        await cloudSaveFile(fileKey, a.file, user?.name || '');
        attachmentRefs.push({ fileKey, name: a.file.name, type: a.kind, mimeType: a.file.type, size: a.file.size });
      }
      const evidence = buildEvidenceList(form.evidenceChecked, form.evidenceCustom);
      const report = {
        id: tempId,
        incidentDate: form.incidentDate, incidentTime: form.incidentTime,
        storePC: form.storePC, storeName: form.storeName, address: form.address, operatingEntity: form.operatingEntity,
        incidentType: form.incidentType, wcCarrier: form.wcCarrier, wcClaimNumber: form.wcClaimNumber,
        reportedInjury: form.reportedInjury, incidentSummary: form.incidentSummary,
        people: form.people.filter(p => p.name.trim()),
        evidence, attachments: attachmentRefs,
      };
      const res = await fetch('/.netlify/functions/incident-reports', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ action: 'create', report }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setError(j?.error || 'Could not save this report — please try again.'); setSubmitting(false); return; }
      setLastFiledId(j.id);
      resetForm();
      setShowForm(false);
      showAlert && showAlert('success', 'Incident report filed.');
      loadReports();
    } catch {
      setError('Network error — please try again.');
    }
    setSubmitting(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div style={sectionTitle(th)}>{isReviewer ? 'All Incident Reports' : 'My Incident Reports'}</div>
        <button style={btn(th)} onClick={() => setShowForm(s => !s)}>{showForm ? 'Cancel' : '+ New Report'}</button>
      </div>

      {showForm && (
        <div style={{ ...card(th), padding: '1.25rem', marginBottom: '1.25rem' }}>
          <div style={{ ...pill('#0ea5e9'), marginBottom: '0.75rem' }}>Report Prepared By: {user?.name || 'Unknown'} · {todayISO()}</div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>Incident Location (store)</label>
              <select style={inp(th)} value={form.storePC} onChange={e => onPickStore(e.target.value)}>
                <option value="">Select a store…</option>
                {(stores || []).map(s => <option key={s.pc} value={s.pc}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>Operating Entity</label>
              <input style={inp(th)} value={form.operatingEntity} onChange={e => setForm(f => ({ ...f, operatingEntity: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>Incident Date</label>
              <input type="date" style={inp(th)} value={form.incidentDate} onChange={e => setForm(f => ({ ...f, incidentDate: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>Incident Time (approx.)</label>
              <input style={inp(th)} value={form.incidentTime} onChange={e => setForm(f => ({ ...f, incidentTime: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>Incident Type</label>
              <input style={inp(th)} placeholder="e.g. Worker's Compensation / employee injury" value={form.incidentType} onChange={e => setForm(f => ({ ...f, incidentType: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>Reported Injury</label>
              <input style={inp(th)} value={form.reportedInjury} onChange={e => setForm(f => ({ ...f, reportedInjury: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>W/C Carrier</label>
              <input style={inp(th)} value={form.wcCarrier} onChange={e => setForm(f => ({ ...f, wcCarrier: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: '0.75rem', color: th.muted }}>W/C Claim #</label>
              <input style={inp(th)} value={form.wcClaimNumber} onChange={e => setForm(f => ({ ...f, wcClaimNumber: e.target.value }))} />
            </div>
          </div>

          <label style={{ fontSize: '0.75rem', color: th.muted }}>Incident Summary</label>
          <textarea style={{ ...inp(th), minHeight: '6rem', marginBottom: '0.9rem' }} value={form.incidentSummary} onChange={e => setForm(f => ({ ...f, incidentSummary: e.target.value }))} />

          <div style={{ marginBottom: '0.9rem' }}>
            <div style={{ fontSize: '0.75rem', color: th.muted, marginBottom: '0.4rem' }}>Evidence Preserved</div>
            {DEFAULT_EVIDENCE_ITEMS.map(item => (
              <label key={item.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.85rem', color: th.text, marginBottom: '0.3rem' }}>
                <input type="checkbox" checked={form.evidenceChecked.includes(item.id)} onChange={() => toggleEvidence(item.id)} />
                {item.label}
              </label>
            ))}
            {form.evidenceCustom.map((v, i) => (
              <input key={i} style={{ ...inp(th), marginTop: '0.3rem' }} placeholder="Add another item…" value={v} onChange={e => setCustomEvidence(i, e.target.value)} />
            ))}
            <button type="button" style={{ ...btn(th, { background: 'transparent', color: th.muted, border: `1px solid ${th.cardBorder}`, padding: '0.4rem 0.8rem', fontSize: '0.75rem', marginTop: '0.4rem' }) }} onClick={addCustomEvidenceRow}>+ Add item</button>
          </div>

          <div style={{ marginBottom: '0.9rem' }}>
            <div style={{ fontSize: '0.75rem', color: th.muted, marginBottom: '0.4rem' }}>Photo / Video Evidence</div>
            <input type="file" accept="image/*,video/*" multiple onChange={e => onAttachFiles(e.target.files)} />
            {form.attachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
                {form.attachments.map((a, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    {a.kind === 'image'
                      ? <img src={a.previewUrl} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${th.cardBorder}` }} />
                      : <video src={a.previewUrl} style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: `1px solid ${th.cardBorder}` }} />}
                    <button type="button" onClick={() => removeAttachment(i)} style={{ position: 'absolute', top: -6, right: -6, background: '#ef4444', color: '#fff', border: 'none', borderRadius: 999, width: 18, height: 18, fontSize: '0.65rem', cursor: 'pointer' }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginBottom: '0.9rem' }}>
            <div style={{ fontSize: '0.75rem', color: th.muted, marginBottom: '0.4rem' }}>Parties Involved / Witnesses / Contacts</div>
            {form.people.map((p, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: '0.4rem', marginBottom: '0.4rem' }}>
                <input style={inp(th)} placeholder="Name" value={p.name} onChange={e => setPersonField(i, 'name', e.target.value)} />
                <input style={inp(th)} placeholder="Role / relationship" value={p.role} onChange={e => setPersonField(i, 'role', e.target.value)} />
                <input style={inp(th)} placeholder="Phone" value={p.phone} onChange={e => setPersonField(i, 'phone', e.target.value)} />
                <input style={inp(th)} placeholder="Email" value={p.email} onChange={e => setPersonField(i, 'email', e.target.value)} />
                <button type="button" onClick={() => removePersonRow(i)} style={{ ...btn(th, { background: 'transparent', color: '#ef4444', border: `1px solid ${th.cardBorder}`, padding: '0.4rem 0.6rem' }) }}>Remove</button>
              </div>
            ))}
            <button type="button" style={{ ...btn(th, { background: 'transparent', color: th.muted, border: `1px solid ${th.cardBorder}`, padding: '0.4rem 0.8rem', fontSize: '0.75rem' }) }} onClick={addPersonRow}>+ Add person</button>
          </div>

          {error && <div style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: '0.6rem' }}>{error}</div>}
          <button style={btn(th, submitting ? { opacity: 0.6 } : {})} disabled={submitting} onClick={submit}>{submitting ? 'Filing…' : 'File Report'}</button>
        </div>
      )}

      {loading ? (
        <div style={{ color: th.muted, fontSize: '0.85rem' }}>Loading…</div>
      ) : reports.length === 0 ? (
        <div style={{ ...card(th), padding: '1.5rem', textAlign: 'center', color: th.muted, fontSize: '0.85rem' }}>No incident reports filed yet.</div>
      ) : (
        <div style={{ display: 'grid', gap: '0.6rem' }}>
          {reports.map(r => (
            <div key={r.id} style={{ ...card(th), padding: '0.9rem 1.1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700, color: th.text, fontSize: '0.9rem' }}>{r.storeName || 'Unknown store'} — {r.incidentDate || r.reportDate}</div>
                <div style={{ fontSize: '0.75rem', color: th.muted, marginTop: '0.2rem' }}>Prepared by {r.preparedByName} · Filed {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}</div>
              </div>
              {/* Download PDF button wired in Task 6 */}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds with no errors.

- [ ] **Step 4: Manual verification via preview deploy**

Run `netlify deploy` (no `--prod`, per the established preview-every-change workflow), open the preview URL, log in as a non-exec/IT test account (e.g. a manager), confirm:
- The "Incident Reports" tab appears in the sidebar with its new icon.
- Filing a report with a store selected, a summary, one photo, and one person row succeeds and appears in the list.
- Logging in as a different manager does NOT show that report in their list.
- Logging in as exec/IT DOES show it.

- [ ] **Step 5: Do not commit yet** (see Task 1, Step 5)

---

### Task 4b: Tools hub tile placement (added post-preview, 2026-09-25)

First preview showed no "Incident Reports" entry anywhere in the sidebar for
exec/IT — this app's sidebar only shows non-base tabs as individual buttons
for a few roles (Manager/Auditor/Construction/Maintenance's flat catch-all
sections); exec/IT/office_staff only get the universal "Tools" button and the
`ADMIN_GROUPS` hub rows (Operations/Finance/Team & Sites/System). Everything
else lives inside a hub's own tile-grid page. Fix, in `app.jsx`:

- Add `{ id: 'incident-reports', label: 'Incident Reports' }` to
  `HUB_SUBITEMS['tools-hub']` (~line 21157) — this is also what makes
  `hubDupeIds` correctly exclude it from Manager/Auditor/Construction/
  Maintenance's flat sidebar sections, so it doesn't show twice there either.
- Add a tile to the `toolsTiles` array in the `tab === "tools-hub"` render
  block (~line 52139): `{ id: 'incident-reports', name: 'Incident Reports', sub: '...', show: accessSubOn(accessOverrides, user?.userType, 'tools-hub', 'incident-reports'), icon: <>{ICONS.incident(TOOLS)}</> }`.

See the design spec's 2026-09-25 addendum for the full reasoning. Verify with
`npm run build`, then a preview deploy: the "Tools" sidebar button should open
a tile grid containing both "District Alignment" and "Incident Reports".

### Task 6: PDF export

**Files:**
- Modify: `app.jsx` (add an export function + wire the Download button)

**Interfaces:**
- Consumes: `splitPeopleForPdf` (Task 1), `cloudLoadFile` (existing), `html2pdf` (global, loaded via CDN in `index.html` — already used elsewhere in `app.jsx`).
- Produces: `exportIncidentReportPdf(report, th)`, called from the Download button added to each report row in `IncidentReportsTab`.

- [ ] **Step 1: Write the export function**

Add near `IncidentReportsTab` in `app.jsx`:

```jsx
async function exportIncidentReportPdf(report) {
  const { parties, contacts } = splitPeopleForPdf(report.people || []);
  const photos = (report.attachments || []).filter(a => a.type === 'image');
  const videos = (report.attachments || []).filter(a => a.type === 'video');

  // Resolve attachment refs to viewable data URLs before building the DOM to export.
  const photoData = [];
  for (const p of photos) {
    const loaded = await cloudLoadFile(p.fileKey);
    if (loaded?.data) photoData.push({ ...p, dataUrl: loaded.data });
  }

  const rowsHtml = (rows) => rows.map(r => `<tr><td style="padding:6px 10px;border:1px solid #ddd;">${r[0]}</td><td style="padding:6px 10px;border:1px solid #ddd;">${r[1]}</td></tr>`).join('');

  const el = document.createElement('div');
  el.style.cssText = 'width:800px;background:#fff;color:#111;font-family:Arial,sans-serif;padding:24px;';
  el.innerHTML = `
    <div style="text-align:center;border-bottom:2px solid #FF671F;padding-bottom:10px;margin-bottom:16px;">
      <div style="font-weight:700;">PEOPLE CAPITAL GROUP</div>
      <div style="font-size:11px;font-style:italic;color:#555;">CONFIDENTIAL — INTERNAL USE ONLY</div>
      <div style="font-size:20px;font-weight:800;margin-top:8px;">WORKPLACE INCIDENT REPORT</div>
    </div>
    <h3>Case Information</h3>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">${rowsHtml([
      ['Report Date', report.reportDate || ''],
      ['Report Prepared By', report.preparedByName || ''],
      ['Incident Date', report.incidentDate || ''],
      ['Incident Time (Approx.)', report.incidentTime || ''],
      ['Incident Location', `PC#${report.storePC || ''} ${report.address || ''}`],
      ['Operating Entity', report.operatingEntity || ''],
      ['Incident Type', report.incidentType || ''],
      ['W/C Claim', `${report.wcCarrier || ''} ${report.wcClaimNumber ? 'WC Claim # ' + report.wcClaimNumber : ''}`],
      ['Reported Injury', report.reportedInjury || ''],
      ['Video Evidence', videos.length ? `Yes — see ${videos.map(v => v.name).join(', ')}` : 'No'],
    ])}</table>
    <h3>Incident Summary</h3>
    <p style="white-space:pre-wrap;">${(report.incidentSummary || '').replace(/</g, '&lt;')}</p>
    <h3>Evidence Preserved</h3>
    <ul>${(report.evidence || []).filter(e => e.checked).map(e => `<li>${e.label}</li>`).join('')}</ul>
    <h3>Preparer Certification</h3>
    <p style="font-size:12px;">I certify that the information contained in this report is accurate to the best of my knowledge.</p>
    <p>_______________________________<br/><strong>${report.preparedByName || ''}</strong><br/>People Capital Group<br/>Date: ${report.reportDate || ''}</p>
    <h3>Name / Role of Parties Involved / Witnesses</h3>
    <ol>${parties.map(p => `<li>${p.name} / ${p.role}</li>`).join('')}</ol>
    <h3>Contact List</h3>
    ${contacts.map(c => `<p><strong>NAME:</strong> ${c.name}<br/><strong>PHONE NUMBER:</strong> ${c.phone}<br/><strong>EMAIL:</strong> ${c.email}</p>`).join('')}
    ${photoData.length ? `<h3>Photo Evidence</h3>` + photoData.map(p => `<img src="${p.dataUrl}" style="max-width:100%;margin-bottom:10px;border:1px solid #ddd;" />`).join('') : ''}
    ${videos.length ? `<h3>Video Evidence</h3><p>Video file(s) attached — downloaded separately alongside this PDF: ${videos.map(v => v.name).join(', ')}</p>` : ''}
  `;

  const dateStr = new Date().toISOString().slice(0, 10);
  await html2pdf().set({
    margin: 0.4, filename: `PCG-Incident-Report-${report.storeName || report.id}-${dateStr}.pdf`,
    image: { type: 'jpeg', quality: 0.95 }, html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }, pagebreak: { mode: ['css', 'legacy'] },
  }).from(el).save();

  // Videos can't play inside a PDF — download them as separate files alongside it.
  for (const v of videos) {
    const loaded = await cloudLoadFile(v.fileKey);
    if (!loaded?.data) continue;
    const a = document.createElement('a');
    a.href = loaded.data; a.download = v.name || 'incident-video';
    document.body.appendChild(a); a.click(); a.remove();
  }
}
```

- [ ] **Step 2: Wire the Download button into the list**

In `IncidentReportsTab`'s list rendering (Task 5), replace the placeholder comment:

```
old_string:
              {/* Download PDF button wired in Task 6 */}
new_string:
              <button style={btn(th, { padding: '0.5rem 1rem', fontSize: '0.8rem' })} onClick={() => exportIncidentReportPdf(r)}>Download PDF</button>
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Manual verification via preview deploy**

Run `netlify deploy` (no `--prod`). On the preview URL, file a test report with one photo attached, then click Download PDF on it from the list. Confirm:
- The PDF downloads and visually resembles the source template's sections (case info table, incident summary, evidence list, certification, parties list, contact list).
- The attached photo appears embedded in the PDF.
- If a video was attached, confirm the PDF shows the "Video evidence attached — see [filename]" note and a separate video file download is triggered.

- [ ] **Step 5: Final full-suite check**

Run: `node --test src/incident-report.test.mjs`
Expected: still passing (this task didn't touch the pure module).

- [ ] **Step 6: Single commit**

Per the Global Constraints, this is where everything from Tasks 1-6 gets committed together:

```bash
git add src/incident-report.mjs src/incident-report.test.mjs src/icons.jsx netlify/functions/incident-reports.mjs app.jsx app.js docs/superpowers/specs/2026-09-25-incident-report-design.md docs/superpowers/plans/2026-09-25-incident-report.md
git commit -m "feat(incident-reports): add Workplace Incident Report tool (v21.13)"
```

Do NOT push — ask the user first, per the standing "never deploy without asking" rule (git push is the production deploy here).
