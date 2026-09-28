# Workplace Incident Report — Design Spec

**Date:** 2026-09-25
**Status:** Approved for planning

## Problem

HR (Sam Brown) currently produces Workplace Incident Reports as a manually-typed
Word/PDF document (see reference screenshots discussed in chat — a PCG-branded
report covering case info, subject employee, incident summary, evidence
preserved, preparer certification, and a parties-involved/contact list). This
is slow, inconsistent, and lives outside the Portal entirely. The Portal should
let any logged-in employee file one, keep the record centrally, and reproduce
the same visual document as a downloadable PDF.

## Goals

- Any real (non-kiosk) logged-in user can file a Workplace Incident Report
  from inside the Portal.
- The generated PDF visually matches the existing PCG incident-report
  template (white background, orange rule lines, centered header, bordered
  tables) closely enough to be a drop-in replacement.
- Report Date and "Report Prepared By" auto-fill from the session (today's
  date, the logged-in user's name) and are **not** editable — that field
  exists specifically so the report always credits whoever is actually
  logged in.
- Incident Date/Time auto-fill to "now" but stay editable, since the incident
  usually happened before the report is filed.
- Picking a store auto-fills PC#, address, and the legal operating-entity
  name, using the store config the rest of the app already uses.
- Users can attach photo and video evidence. Photos embed directly in the
  exported PDF. Video can't play inside a PDF, so the PDF shows a
  placeholder frame + filename note, and the actual video file downloads
  alongside the PDF.
- Exec/IT can see every report; everyone else can see only reports they
  personally filed (matches the source doc's own "CONFIDENTIAL... limited to
  authorized personnel" framing).
- IT can hide the whole feature from any role via the existing Admin →
  Access matrix, the same mechanism every other optional tab already uses.
  No new toggle UI.

## Non-goals

- No approval/review workflow (report is final once submitted — no edit,
  no comments, no status field). If a correction is ever needed later,
  that's a new report or a follow-on feature, not scope here.
- No e-signature pad. Preparer certification uses the logged-in user's
  typed name, exactly as the "keep it the same as the screenshot" answer
  specified (the source doc's signature line is just a printed name +
  date, no drawn signature).
- No notification/bell/email on submit (explicitly declined — silent
  save + PDF).
- No visible formatted case-number ("INC-2026-0001" etc.) on the PDF — the
  source doc has none. Internally, the Postgres row's `id` is enough for
  the list view; nothing forces a formatted ID into the printed document.

## Data model

New Postgres table `incident_reports`, following the same pattern as
`maint_tickets` (`netlify/functions/tickets.mjs`): an explicit `KNOWN`
column set, everything else preserved in a `meta` JSONB catch-all so no
field is silently dropped. Reports are insert-only — there is no update
path once filed (Non-goals above), so no `updated_at`/edit-tracking is
needed.

```sql
CREATE TABLE IF NOT EXISTS incident_reports (
  id                  bigint PRIMARY KEY,
  report_date         text,        -- ISO date, server-stamped at submit time
  prepared_by_user_id text NOT NULL,
  prepared_by_name    text NOT NULL,
  incident_date       text,        -- editable, defaults to today client-side
  incident_time       text,        -- editable, defaults to "now" client-side
  store_pc            text,
  store_name          text,
  address             text,
  operating_entity    text,
  incident_type       text,
  wc_carrier          text,
  wc_claim_number     text,
  reported_injury     text,
  incident_summary    text,
  people              jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{name, role, phone, email}]
  evidence            jsonb NOT NULL DEFAULT '[]'::jsonb,   -- checklist + custom rows, see below
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{fileKey, name, type, mimeType, size}]
  meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_reports_prepared_by ON incident_reports(prepared_by_user_id);
```

`report_date`, `prepared_by_user_id`, and `prepared_by_name` are always
set server-side from the authenticated session at submit time — the
client never gets to supply these three, even though the UI displays
them read-only. This is what makes "not editable" actually true instead
of a client-side-only convention.

## Netlify function: `incident-reports.mjs`

Mirrors `tickets.mjs`'s shape (CORS, `ensureTables`, action dispatch).
Actions:

- **`create`** — validates the caller session (`requireActiveUser`,
  same helper `manager-sync-check.mjs` and others already use), stamps
  `prepared_by_user_id`/`prepared_by_name`/`report_date` from the caller
  and server clock (ignoring any client-supplied values for those three
  fields), inserts one row, returns `{ ok: true, id }`.
- **`list`** — if caller is exec/IT, returns every report (most recent
  first); otherwise returns only rows where
  `prepared_by_user_id = caller.id`. This is the enforcement point for
  the "exec/IT + author only" visibility rule — it happens here, not
  just in the UI.
- **`get { id }`** — same visibility rule as `list`, applied to a single
  row (404-equivalent `{ error }` if the caller isn't allowed to see it,
  not a 403 that reveals the row exists).

No `delete`/`update` action — reports are insert-only per Non-goals.

## Evidence attachments

Reuses the existing chunked-blob helpers in `app.jsx`
(`cloudSaveFile`/`cloudLoadFile`, ~line 8112) — the same mechanism
already used to offload ticket photos/videos out of Postgres and into
Netlify Blobs. No new upload endpoint. Each attachment is uploaded
client-side under a key like `incident_media_{tempId}_{n}`, and only
`{ fileKey, name, type: 'image'|'video', mimeType, size }` is stored on
the `incident_reports` row (mirrors how ticket attachments already work).

"Evidence Preserved" is a checklist (interior camera footage / this
report / witness statements, pre-checked where applicable) plus an
"add custom" free-text row, stored as the `evidence` jsonb array. Photo/
video uploads are a separate `attachments` array, not tied one-to-one to
evidence checklist rows.

## PDF export

`html2pdf` from a styled offscreen div, the same pattern already used
for the Store Directory / District Alignment / Audit PDF exports
elsewhere in `app.jsx` (search `html2pdf().set(...).from(el).save()`).
This is the pragmatic choice for pixel-fidelity to the source template —
building the same layout in raw `jsPDF` text/table calls would take far
longer for no visible benefit here, unlike the "crisp selectable text"
exports elsewhere in the app that specifically need copyable text (e.g.
KB articles). Layout mirrors the source doc's sections in order: Case
Information table → Subject Employee table → Incident Summary → Evidence
Preserved → Preparer Certification (typed name + date, no signature pad)
→ Name/Role of Parties list → Contact List (both rendered from the one
merged `people` array) → embedded photos. A video attachment renders as
a placeholder frame with "Video evidence attached — see [filename]"; the
Download action also triggers a separate `cloudLoadFile` → blob download
for the actual video file(s) alongside the PDF save.

## Frontend

New tab `incident-reports` (label "Incident Reports"), new component
`AdminIncidentReports`-style but user-facing (not Admin-gated) — a list
view (own reports, or all reports for exec/IT) plus a "New Report" form
matching the source doc's sections. New icon added to `src/icons.jsx`
(a clipboard-with-exclamation glyph) — not reusing any existing tab icon,
per the "every tab needs a unique icon" convention already established
in this codebase.

**Tab wiring** (`app.jsx`, `computeRoleTabs`): add
`{ id: "incident-reports", label: "Incident Reports", icon: (c) => ICONS.incident(c) }`
to every individual-login role's branch — executive/it, office_staff,
auditor, dm, manager, construction, maintenance, vendor. Deliberately
**excluded** from `kiosk_pulse`, `kiosk_upload`, and `store_tablet` — those
are shared/unmanned-device logins with no real "who is filing this"
identity, which this form fundamentally depends on.

Because it's added as a normal (non-`BASE_TABS`) tab, it automatically
appears in the existing **Admin → Access** matrix (`AccessMatrix`,
~line 20858) alongside every other optional tab, with per-role show/hide
toggles that already "save automatically and apply to everyone in that
role network-wide." This is the mechanism that satisfies "IT should be
able to disable it from the admin panel" — no new toggle UI is built for
this feature; it's the same switch every other optional tab already has.

## Addendum, 2026-09-25 — reachable via the Tools hub tile, not a standalone sidebar button

Discovered during first preview: this app's sidebar for exec/IT/office_staff
doesn't render most non-base tabs as individual buttons at all anymore — they
were consolidated into "hub" tile-grid pages (`ops-hub`/`team-hub`/`system-hub`/
`tools-hub`), each with its own hand-maintained tile list
(`HUB_SUBITEMS[hubId]` + a matching `tiles` array in that hub's render block).
A tab that's only registered in `computeRoleTabs` but not in a hub's tile list
is simply invisible for those roles (Manager/Auditor/Construction/Maintenance
would instead show it as a stray flat item, which is arguably worse — see the
`hubDupeIds` fix from the "Tools showed twice" bug earlier this session).

Fix: `incident-reports` was added to `HUB_SUBITEMS['tools-hub']` and to the
`toolsTiles` array in the `tools-hub` tab's render block, gated by
`accessSubOn(accessOverrides, user?.userType, 'tools-hub', 'incident-reports')`
— the same fine-grained per-role toggle every other hub tile already uses.
This is actually a better fit for "IT should be able to disable it from the
admin panel" than the original plan: it's now a `Tools` sub-item toggle in
Admin → Access, not just a whole-tab toggle. The `computeRoleTabs` entries
from the original plan are kept as-is — every other hub sub-item (`audits`,
`district-alignment`, etc.) is registered the same way, present both in
`computeRoleTabs` (so it's a valid tab id, addressable via `setTab`, and
covered by the top-level `AccessMatrix` too) and in its hub's tile list (so
it's actually reachable from the sidebar). No regressions to the rest of the
design — data model, permissions, PDF export are unchanged.

## Addendum, 2026-09-28 — Subject Employee section was missing

The original design/implementation pass dropped the source document's whole
"Subject Employee" block (Employee Name, DOB, Status, Address, Contact) —
a real gap, caught when the user asked where to enter the employee's name.
Added: `employeeName`, `employeeDob`, `employeeStatus`, `employeeAddress`,
`employeePhone`, `employeeEmail` as their own columns (not folded into
`people`, since the subject employee is a distinct single entity, not a
witness). The source doc also lists the subject employee a second time, as
the first "Parties Involved / Witnesses" + "Contact List" entry (role
"Injured employee") — `buildSubjectEmployeeParty()` (in
`src/incident-report.mjs`) derives that second appearance from the same
fields at PDF-export time, so nothing is entered twice and the two are never
allowed to drift out of sync.

## Testing

- Pure-logic pieces (evidence-checklist merge, people-list → two-section
  PDF data shaping, autofill-from-store lookup) get unit tests in a new
  `src/incident-report.mjs` + `.test.mjs`, following this codebase's
  established pure-module pattern.
- `incident-reports.mjs`'s visibility rule (`list`/`get` restricting
  non-exec/IT callers to their own `prepared_by_user_id`) is the one
  piece of server logic worth a direct test, given it's the actual
  enforcement point for a confidentiality requirement.
