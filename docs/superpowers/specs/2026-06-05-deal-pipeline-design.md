# Deal Pipeline (Pre-Construction Real Estate) — Design Spec

**Date:** 2026-06-05
**Status:** Approved (design) — Mike "Good to go"
**Roadmap ref:** Phase 11.1 (`docs/ROADMAP_PHASES_6-10.md`)

## Goal

A dedicated **pre-construction real estate deal pipeline tracker** for leased AND purchased sites, separate from the development/construction tracker (`AdminProjects`). It owns a site from the moment we start chasing it (sourcing) through LOI, due diligence, and lease execution / closing, up to **"Ready for Construction" — the handoff trigger**: at that point the deal is marked handed-off, drops out of the active pipeline, and is flagged for the construction tracker. Everything *before* construction.

## Scope decisions (locked 2026-06-05)

- **v1 = "Core + high-value gaps"** — Mike's full spec PLUS cheap, high-impact additions (split possession/commencement/rent dates, recurring critical dates, tiered escalating + acknowledged alerts, dead-deal reason codes, SPE/entity field, document versioning, extended lease-abstract fields). Heavy parallel-track machinery is **deferred** (see below).
- **Server-side RBAC enforcement** — this module holds confidential financial terms + executed agreements. Unlike the rest of the portal (client-side gating only), the deal data/document functions verify the caller's identity + role on the server before returning or writing anything. This is net-new auth infrastructure and is the foundation of v1.
- **Calendar push = .ics now + Google Calendar API later** — one-click `.ics` per critical date works immediately for any calendar; auto-push to users' Google Calendars is added once the Workspace admin grants the service account the Calendar scope + domain-wide delegation (today it has Gmail scope only).
- **Handoff (v1)** = mark handed-off + drop from pipeline + flag for construction. Auto-creating the construction-tracker project is deferred.

## Pipeline stages (Kanban columns)

1. Sourcing / Identified
2. LOI Out / Negotiating
3. LOI Executed
4. Due Diligence
5. Lease / PSA Negotiating
6. Executed (lease signed / under contract)
7. Closing / Possession
8. Ready for Construction → **handoff trigger** (deal leaves the active board)

Plus a terminal **Dead / Lost** state (not a column; set via action) carrying a **reason code** (lost-to-competitor, failed DD, zoning denied, franchisor rejected, economics, financing, other).

## Architecture

Existing codebase patterns reused (confirmed): chunked large-file upload (`cloudSaveFile`/`cloudLoadFile`, 4 MB base64 chunks + `_meta` blob), Neon raw-SQL via `db.js` + `db-migrate.js`, the tab/nav plumbing (`getTabs` role arrays + `ADMIN_GROUPS` id allowlist + `{tab === …}` routing).

### 1. Data model — Neon Postgres (new tables, created in `db-migrate.js` raw SQL)

- **`deals`** — one row per deal. Columns:
  - Core: `id`, `name`, `address`, `city`, `state` (`PA`|`NJ`), `deal_type` (`lease`|`purchase`), `brand` (`dunkin`|`papajohns`|`bww_go`|`dual`), `pc_number`, `stage`, `deal_lead`, `broker_source`, `sqft`, `status` (`active`|`handed_off`|`dead`), `dead_reason`, `created_at`, `updated_at`, `created_by`.
  - Lease fields: `landlord_entity`, `landlord_contact`, `lease_structure` (NNN/gross/ground), `base_rent`, `rent_psf`, `escalations`, `term_years`, `renewal_options`, `ti_allowance`, `free_rent`, `est_nnn_cam`, `cam_cap`, `cam_gross_up`, `cam_audit_window_days`, `percentage_rent`, `pct_rent_breakpoint`, `guaranty_type` (personal/corporate), `use_clause`, `exclusivity`, `radius_restriction`, `cotenancy`, `kickout`, `holdover`, `rofr_rofo`, `signage`, `parking`, `delivery_condition`, `security_deposit`.
  - Purchase fields: `seller_entity`, `seller_contact`, `purchase_price`, `earnest_money`, `emd_hard` (bool), `title_escrow_co`, `lender`, `loan_terms`, `appraisal_status`, `phase1_status`, `survey_status`, `zoning_status`.
  - High-value gaps: `spe_entity` (single-purpose LLC name/ref — full entity module deferred).
  - `notes` activity log → separate rows or `jsonb` append log.
- **`deal_dates`** — one row per critical date: `id`, `deal_id`, `date_type`, `due_date`, `recurring` (bool + cadence), `warning_tiers` (jsonb, e.g. `[180,120,90,60,30]` or `[30,14,7,3,1]`), `acknowledged_by`, `acknowledged_at`, `notes`. Date types: LOI response/expiration, DD expiration, EMD goes hard, financing contingency, closing, lease execution target, delivery of possession, **possession**, **lease commencement**, **rent commencement** (+ rent-commencement condition), construction commencement, option/renewal notice, % rent report due, CAM reconciliation/audit window, COI renewal, estoppel/SNDA response.
- **`deal_documents`** + **`deal_document_versions`** — logical doc (type: LOI, lease/PSA, amendment, estoppel, SNDA, title, survey, Phase I, zoning, appraisal, guaranty, delivery/commencement letter, closing docs) with **version history** (never overwrite): each version = `{ version_no, blob_key, filename, size, uploaded_by, uploaded_at }`. Blobs via the chunked uploader under per-version keys + a manifest row.
- **`deal_access`** — RBAC source of truth: `user_id`/identifier, `role` (`view`|`edit`|`admin`). Server-side authority.

### 2. Server-side auth + RBAC (net-new — foundation)

- Login issues a short-lived **HMAC-signed session token** (`{ sub: userId, username, role, exp }`, signed with `DEAL_SESSION_SECRET`). Stored client-side; sent on every deal API call (`Authorization: Bearer`).
- Shared `netlify/functions/_auth.js`: `verifySession(event)` → decoded user or 401; `requireDealRole(user, level)` → checks `deal_access` (cached) or 403.
- Every deal function (`deals.js`, `deal-docs.js`, `deal-calendar.js`) calls verify+authorize **before** any DB/blob access. View role → read-only; edit/admin → mutate. Document downloads also gated.
- Frontend still hides the tab/routes for non-members (UX), but **security does not depend on the client**.

### 3. Functions

- `netlify/functions/deals.js` — authed CRUD for deals + dates + notes (actions: list/get/create/update/move-stage/handoff/mark-dead).
- `netlify/functions/deal-docs.js` — authed document upload (chunked), new-version, list, download.
- `netlify/functions/deal-calendar.js` — generate `.ics` for a deal's critical dates (+ Google Calendar push later).
- `netlify/functions/deal-alerts-cron.js` — daily scan of `deal_dates`; fire tiered/escalating reminders (push + email) to deal lead + execs; compute dashboard warning flags.

### 4. Frontend — `AdminDeals` tab + components

- New top-level **Deals** tab (gated; see RBAC). Lives in the nav (`getTabs` + `ADMIN_GROUPS` group + routing).
- **Two views, one toggle** over the same data:
  - **Kanban** — 8 stage columns, drag to advance; stage 8 triggers handoff confirm.
  - **Table** — sortable/filterable (closing date, rent, next deadline, brand, lead, etc.).
- **Dashboard header:** active deals by stage; total committed capital / annual pipeline rent; closing-or-deadline within 30/60/90 days; **red** when a critical date is inside its warning window.
- **Filters:** brand, deal type (lease/purchase), state (PA/NJ), stage, deal lead.
- **Deal detail:** tabs for Terms (lease/purchase fields), Dates (with per-date one-click .ics + warning config), Documents (versioned), Notes/activity log.
- Pure helpers `src/deal-pipeline.mjs` (stage list/order, next-deadline + warning-window computation, dollar/pipeline rollups) — **unit-tested** with `node:test` (`src/deal-pipeline.test.mjs`).

### 5. Error handling

- Auth failures → 401/403 (never leak data). DB/blob errors → per-request failure, surfaced in UI; never silent. Document upload failures roll back the version row. Alert cron wraps per-deal in try/catch so one bad deal doesn't abort the scan.

## Testing

- Unit (`node:test`): RBAC (`verifySession`/`requireDealRole` accept valid, reject expired/forged/under-privileged), pure helpers (next-deadline, warning-window tiers, pipeline $ rollups, stage transitions, dead-deal handling), `.ics` generation (valid VEVENT, correct dates/alarms).
- Manual: create a lease deal + a purchase deal; advance stages on kanban; toggle to table + sort; upload a doc then a new version (confirm both retained); set a renewal-notice date with 120/90 tiers and confirm dashboard red + alert; confirm a non-member is rejected server-side (not just hidden); handoff a deal → drops from board.

## Deferred (Phase 11.2+)

Full **parallel-track machinery** (Entitlement track w/ PennDOT HOP / NJDOT Major Access Permit, land-development/site-plan, stormwater-NPDES, utility will-serve, building/sign permits + computed Ready-for-Construction gate; Franchisor track w/ site/RDA approval as condition precedent + SDA development-schedule obligation + prototype approval; Financing/SPE entity module); **underwriting fields + IC go/no-go gate** (occupancy-cost %, rent-to-sales %, total project cost, cash-on-cash, cap rate); **pipeline analytics** (weighted/probability value, days-in-stage, conversion); **full 1031** 45/180-day tracking; **Google Calendar auto-push**; **auto-create construction project** on handoff. See the research appendix.

---

## Appendix — Research gap analysis (reference for later phases)

Grounded in Dealpath (acquisitions/pipeline), Visual Lease / Occupier / Leasecake / Prophia (lease admin + critical dates), and PA/NJ regulatory practice. Key structural insight: franchise development is **multi-track** — the real-estate deal, entitlement/permitting, franchisor approval, and financing run in parallel, and any one gates "ready for construction."

**Top additions (prioritized):** split possession/lease-commencement/rent-commencement (#1 abstraction error); entitlement track (PennDOT HOP/NJDOT MAP — drive-thru trip thresholds; land-development; stormwater; utility will-serve; building+sign permits; computed RFC gate); franchisor track (site/RDA approval as condition precedent; SDA development-schedule obligation — missing forfeits territory; prototype approval); SPE-per-site entity backbone; underwriting + IC gate; weighted pipeline + days-in-stage + dead-deal reason codes; recurring dates (% rent reports, CAM audit window, COI renewal, estoppel/SNDA windows); tiered escalating acknowledged alerts (180/120/90/60/30 for options, 30/14/7/3/1 for money-at-risk); 1031 45/180-day; deeper lease abstract (CAM cap/gross-up/audit rights, co-tenancy, kick-out, holdover, ROFR/ROFO, delivery condition/LL work, signage, parking). Handoff "Ready for Construction" should ultimately = a structured handoff checklist (approved plans, all permits w/ numbers+expirations, survey, geotech, utility will-serves, executed lease/deed, LL-work scope, possession date, franchisor-approved prototype) with permit-expiration tracking.

Sources: PennDOT HOP (pa.gov, Pub. 819); NJDOT Major Access Permit (nj.gov, N.J.A.C. 16:47-4.12); Dunkin' Store Development Agreement (SEC); Dealpath acquisitions/pipeline; Prophia / Lextract lease-abstract field sets; IPX1031 deadlines.
