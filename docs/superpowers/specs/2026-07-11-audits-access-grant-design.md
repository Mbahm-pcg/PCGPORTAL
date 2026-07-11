# Per-User Audits Access Grant — Design Spec

**Date:** 2026-07-11
**Status:** Approved by Mike (design review in Claude Code session)
**Context:** The Audits module (v18.37) is role-gated: auditor/executive/it get full access, office_staff/dm get scoped read-only, manager gets CAPs only. Mike wants to grant the module to individual users whose role doesn't include it, choosing per user between read-only and full audit powers.

## 1. Behavior

- New per-user setting **`audits_access`**: `null` (role default — today's behavior, unchanged) / `'view'` / `'full'`.
- **`'view'`** → inside the Audits module the user is treated like `office_staff`: Audits tab, full portfolio dashboard, reports, CAP board — all read-only. No conducting, no CAP closure, no manager rankings.
- **`'full'`** → treated like the `auditor` role inside the module: everything `'view'` gives plus conduct/submit audits and verify-close/reject CAPs, and manager rankings on the dashboard.
- Grants **only elevate**; they never reduce what a role already has. A role whose baseline exceeds the grant keeps its baseline (e.g. executive + `'view'` is still full).
- Only **executive/it** may set or change `audits_access` (server-enforced; office_staff can manage some users but must not be able to hand out audit powers).
- Server-side the grant takes effect **immediately** (per-request lookup); the sidebar tab appears at the user's **next login** (tab list derives from token claims).

## 2. Pieces

- **`netlify/functions/audit-lib/access.js`** (new, pure, tested): `effectiveAudits(userType, grant)` → `{ canView, canAudit, effUserType }` — single source of truth for elevation, used by `audits.mjs`. `canView` = role in {auditor, executive, it, office_staff, dm} OR grant ∈ {view, full}; `canAudit` = role in {auditor, executive, it} OR grant === 'full'; `effUserType` = 'auditor' when grant === 'full' and role isn't already a verifier (feeds `canTransition`).
- **`users` table**: `ALTER TABLE users ADD COLUMN IF NOT EXISTS audits_access text` run idempotently by `users.mjs` on demand (matches the codebase's self-managing-schema pattern). Documented in `db/schema.ts`.
- **`users.mjs`**: `toClient` exposes `auditsAccess`; `create`/`update` accept the field but reject the write with 403 unless the caller is executive/it; value validated to `null|'view'|'full'`.
- **`auth-lib/require-user.js`** (`requireActiveUser`): the existing per-request `users` SELECT additionally returns `audits_access`, attached to the returned claims as `auditsAccess` — fresh on every request, no extra query.
- **`portal-auth.mjs`**: login claims + user payload include `auditsAccess` (drives the sidebar tab).
- **`audits.mjs`**: replace raw `FULL_VIEW`/`CAN_AUDIT` checks with `effectiveAudits(user.userType, user.auditsAccess)`; `capUpdate` passes `effUserType` to `canTransition`. dm keeps district scoping even with a grant elevating view (grant='view' for a dm widens to full-portfolio view like office_staff — acceptable: grants elevate). manager + 'view' gets full-portfolio read-only (elevation, intended).
- **`app.jsx`**: (a) `getTabs` adds the Audits tab for any user with `auditsAccess` set (role branches unchanged); (b) `AuditsTab`/`CapBoard`/dashboard gates consult the same elevation rule client-side (`canAudit`-style checks include `auditsAccess === 'full'`, view checks include either value); (c) Admin → Users editor gains an "Audits module" dropdown (Role default / View only / Full audit powers), rendered only for executive/it. `APP_VERSION` → v18.38.

## 3. Testing

- `audit-lib/access.test.js`: elevation matrix — every role × {null, view, full}: canView/canAudit/effUserType; grants never reduce; unknown roles with grants gain exactly the granted level.
- Existing 159 tests stay green; `npm run build` clean; manual pass: grant 'view' to a construction test user → tab + read-only after re-login; flip to 'full' → conduct works; server rejects an office_staff attempt to set the field (403).

## 4. Out of scope

Per-district scoping on grants, grant audit-logging, UI for bulk grants, revocation notifications. `audits_access` is deliberately a text column so future levels (e.g. 'district_view') slot in without migration.
