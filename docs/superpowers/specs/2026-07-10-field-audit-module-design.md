# Field Operations Audit Module — Design Spec (v1 Core Loop)

**Date:** 2026-07-10
**Status:** Approved by Mike (design review in Claude Code session)
**Context:** PCG is hiring a Field Operations Auditor (reports to VP, independent of DMs). The portal needs a module that lets the auditor conduct scored store audits in the field, drive corrective actions to verified closure, and give operations leadership trend visibility. V1 covers the full core loop; differentiators are deferred to phase 2 (§9).

---

## 1. Goals (mapped to the role's 90-day success criteria)

| 90-day criterion | Module feature |
|---|---|
| Baseline audit of every location on a rotation | Field audit flow + coverage tracker |
| Consistent, scored reporting format | Versioned template, weighted scoring, standardized report + PDF |
| CAP-tracking process; findings fixed, not just found | CAP engine with auditor-only verified closure + escalation |
| Portfolio-wide trend report; systemic risks by district | Leadership dashboard with repeat-finding detection |

Non-goals for v1: inspection document vault, route planner, imminent-hazard one-tap alert, Orion AI integration, secret-shopper checks (all phase 2, §9).

## 2. Role & Access

- **New `auditor` userType** — label "Field Operations Auditor".
  - Full Audits tab (create/conduct/submit audits, manage CAPs, all dashboards).
  - Read access to Pulse, Map, Tickets for field context.
- **`executive` / `it`** — everything the auditor sees, including cross-district comparisons and manager-level trends. Can unlock a submitted audit (audit-logged).
- **`dm`** — read-only Audits view filtered to their district: scores, findings, CAPs. No edit/close on anything. No cross-district comparison or manager rankings.
- **`office_staff`** — read-only, same surface as DM but unfiltered store scores only (no manager rankings).
- **`manager`** — their own store's audit results + CAPs assigned to them, surfaced in the existing My Store mobile mode.
- Independence rule: results are transparent (full-transparency model), but **no one below executive can modify an auditor's findings**, and CAPs can be verified-closed only by the auditor or an executive.

## 3. Data Model (Neon Postgres, `db/schema.ts` + drizzle)

New tables:

- **`audit_templates`** — `id`, `version`, `name`, `type` (`standard` v1; future: `health_prep`, `secret_shop`), `sections` (jsonb), `active`, `created_at`.
  - V1 ships one seeded template with four weighted sections: Food Safety 40%, Brand Standards & Guest Experience 25%, Facility Appearance & Maintenance 20%, Safety & Liability 15%.
  - Items: `{ id, text, points, critical: bool, guidance }`. Critical items include imminent hazards, cold-chain breaks, handwashing violations, blocked egress.
  - Templates are immutable once used; edits create a new version. Each audit stores its `template_id`, so historical scores never change meaning.
- **`audits`** — `id`, `template_id`, `store_pc`, `auditor_user_id`, `status` (`draft`/`submitted`), `started_at`, `submitted_at`, `submit_lat`/`submit_lng`, `score` (0–100), `section_scores` (jsonb), `capped_by_critical` (bool), `unlocked_by`/`unlocked_at` (nullable).
- **`audit_items`** — `id`, `audit_id`, `template_item_id`, `result` (`pass`/`fail`/`na`), `severity` (`low`/`medium`/`high`/`critical`), `note`, `photo_keys` (jsonb, Netlify Blob keys).
- **`caps`** — `id`, `audit_item_id`, `store_pc`, `owner_user_id`, `deadline`, `status` (`open`/`owner_resolved`/`verified_closed`/`overdue`), `owner_note`, `owner_photo_keys` (jsonb), `resolved_at`, `verified_by`, `verified_at`, `escalated_at`.

Photos use the existing chunked Blob upload pattern (`storage.js`); DB stores blob keys only.

## 4. Field Audit Flow

- Tablet-first UI patterned on the construction mobile view.
- Pick store → template renders section-by-section with progress bar.
- Each item: large Pass / Fail / N-A touch targets. Fail expands severity picker, note field, camera/photo upload.
- **Draft autosave** on every change (localStorage first, background sync to server) — resilient to dead zones between stores.
- **Submit**: captures GPS + timestamp, computes score, locks the audit. Post-submit edits require executive/IT unlock, and unlocks are recorded (`unlocked_by`, audit_log entry) to keep the trail clean for franchisor/insurer review.

## 5. Scoring

- Section score = points passed ÷ points applicable (N/A items excluded), weighted rollup to 0–100.
- **Critical auto-fail:** any failed item flagged `critical` caps the total at 69 regardless of the arithmetic; `capped_by_critical` is set and the reason prints on the report.
- Bands: **90+** Excellent · **80–89** Pass · **70–79** Needs Improvement · **≤69** Fail.
- Band colors follow the existing labor-threshold convention (green/yellow/red) from `src/theme.js`.

## 6. CAP Lifecycle

```
open → owner_resolved → verified_closed
  ↘ (deadline passes unverified) → overdue → escalation push/email to VP + DM
```

- Every failed audit item auto-creates a CAP at submit. Auditor confirms owner + deadline per CAP (defaults: store manager as owner; critical items 24–48h deadline, others 7 days).
- Owner marks **resolved** with note + photo. Only the auditor (or executive) can **verify-close**.
- **`audit-cap-cron`** (daily, pattern of `deal-alerts-cron`): flips overdue statuses, sends digest of due-soon/overdue CAPs to owners, escalation push/email to VP + district DM for overdue items via existing `push.js` / `notify.js`.

## 7. Leadership Dashboard

- **Portfolio heatmap** — 45 stores colored by latest score, grouped by district (mirrors the Labor store grid layout).
- **Trends** — score over time per store and district; portfolio average.
- **Coverage tracker** — days since last audit per store; supports the 90-day baseline rotation goal.
- **Repeat-finding detection (systemic flags)** — computed, not manual:
  - Same template item failed in ≥2 of the last 3 audits at one store → *chronic store issue*.
  - Same template item failing at ≥5 stores in the trailing 60 days → *systemic portfolio issue*.
  - Flags attribute to store, district, and manager. Manager/district rankings visible to auditor/executive/IT only.
- **CAP board** — open/overdue counts by owner and district; average time-to-close.

## 8. Report Output

Submitted audits render a standardized scored report: header (store, date/time, auditor, GPS), section scores, findings with photos inline, CAP list with owners/deadlines. One-click PDF export via the jspdf/html2pdf CDN libs already in `index.html`.

## 9. Phase 2 (explicitly deferred, schema-ready)

- Health-inspection readiness vault (certs, hood cleaning, pest control, expiry alerts).
- Rotation/route planner (risk-weighted cadence + map routing).
- One-tap imminent-hazard alert (instant push/SMS to VP + DM).
- Orion AI: trend-report narratives, audit-vs-sales/labor/review-sentiment correlation, pre-visit briefs.
- Secret-shopper template (`type: 'secret_shop'`).

## 10. Implementation Notes

- Frontend: new `AdminAudits` component tree in `app.jsx` following `AdminProjects`/Tickets patterns; tab registered in `getTabs()` with userType gating; icons in `src/icons.jsx`.
- Backend: one new function `netlify/functions/audits.js` (CRUD + scoring + CAP transitions, auth-checked server-side) + `audit-cap-cron.js` scheduled in `netlify.toml`.
- Schema via `db/schema.ts` + `db-migrate.js` manual trigger (existing pattern).
- Server-side enforcement of role rules (not just UI hiding): DM read-only, auditor-only verify-close, executive-only unlock.
- Standard workflow applies: edit `app.jsx` → `npm run build` → bump `APP_VERSION` → commit both → `npx netlify deploy --prod`.

## 11. Testing

- Unit tests for scoring math (weights, N/A exclusion, critical cap) and CAP state transitions in `netlify/functions/audit-lib/*.test.js`, wired into the existing `npm test` glob pattern.
- Manual field-flow verification on tablet viewport (draft autosave, photo upload, submit lock).
