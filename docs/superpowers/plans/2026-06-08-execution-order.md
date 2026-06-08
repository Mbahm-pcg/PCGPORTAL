# PCG Portal — Master Execution Order (Track 0 + 11.1 + Impact Radar + Portal Auth)

**Date:** 2026-06-08
**Driver doc:** `docs/PCG_PORTAL_EXECUTION_PROMPT.md` (work order: Track 0 hardening · Phase 11.1 Deal Pipeline · Impact/Cannibalization Radar)
**Adds:** the full portal-wide auth rollout (Phases A–D), folded into Track 0.

## Architecture correction (applied)
The execution prompt's SYSTEM CONTEXT originally said "no build step / no JSX / edit `app.js`". That described the **build output**. Reality (per `CLAUDE.md`): source is **`app.jsx` + `src/*`, bundled by esbuild → `app.js`**. Edit the JSX, `npm run build`, commit both; never hand-edit `app.js`. Fixed in the prompt's SYSTEM CONTEXT bullet + Rule of Engagement #1.

## Key couplings (why the order is what it is)
1. **Task 1 (server-state) ↔ Auth Phase C** touch the **same surface** — `cloudLoad`/`cloudSave` + the `storage` function. Task 1 makes `storage` authoritative for business data; Phase C is what then *protects* those endpoints. → Do **Task 1 first, Phase C immediately after.**
2. **Auth Phase A/C `requireUser`/`requireRole` (`auth-lib/require-user.js`) IS the "generic, reusable server-side RBAC (Track 0.4)"** that Task 2 calls for. Don't build a second auth — Deal Pipeline endpoints consume the portal-auth RBAC. → Phase C lands the canonical RBAC that Task 2 reuses.
3. **Task 3 (Impact Radar) is fully independent** (read-only sales analysis + PDF; no auth/state coupling) → can be pulled earlier or run in parallel. Mike: OK to slot earlier.

## Sequence

| # | Work | Branch | Status / depends on |
|---|------|--------|---------------------|
| 0 | Merge PR #3 (NDCP); sync `main`; fix prompt architecture + this plan | `docs/execution-plan` | **DONE** — `main`@`7e45d92` matches prod |
| 1 | **Task 1 — server-state migration** (Track 0.1): `storage` authoritative for `pcg_portal_data_v8`/`pcg_sales_v1`/`pcg_tickets_v1`; localStorage = cache; loading/empty/error states; "last synced" indicator | `feature/hardening-server-state` | foundational |
| 2 | **Auth Phase C** — (a) migrate Google login to ID-token (`google.accounts.id` → `portalLoginGoogle(credential)`); (b) attach `authHeader()` to `cloudLoad`/`cloudSave` + direct fetches; (c) gate read endpoints `requireUser`: accept-but-log → require | `feature/portal-auth-phase-c` | after Task 1 (same code surface); protects the now-authoritative data |
| 3 | **Auth Phase D** — strip `USERS_SEED`/`pcg_users_v1` passwords; remove client compare + grace; reset all users to temp passwords (`must_change`), deliver list to Mike once | `feature/portal-auth-phase-d` | only after C is enforced & stable |
| 4 | **Task 2 — Phase 11.1 Deal Pipeline** (rebase on latest `main` first — confirm with Mike before rebasing) per `docs/superpowers/specs/2026-06-05-deal-pipeline-design.md`; **reuse the Phase A/C `requireUser` RBAC** for `deals`/`deal-docs` (satisfies Track 0.4) | `feature/deal-pipeline` (existing) | reuses generic RBAC from C |
| 5 | **Task 3 — Impact/Cannibalization Radar** (automate the 18th-St ≈28.9% analysis → branded PDF) | `feature/impact-radar` | independent — may pull earlier / parallel |

## Portal-auth phase status
- **Phase A ✅** foundation (`auth-lib/passwords.js`, `auth-lib/require-user.js`, `portal-auth.js`) — on `main`.
- **Phase B ✅** server login + grace (`src/portal-auth.mjs`, `Login.submit`) — shipped v14.40, on `main`.
- **Phase C / D** — sequenced above. Plan: `docs/superpowers/plans/2026-06-08-portal-auth.md`.

## Git & deploy discipline (this work order — stricter, per the prompt + Mike)
- Pre-flight before each session (clean tree, fetch, branch off `main`); **per-task branch, never commit to `main` directly**; small atomic commits; **stop for Mike's review between tasks**.
- Pre-deploy gate: **preview deploy → smoke → then prod/merge**; state rollback plan (previous Netlify deploy / revert merge).
- This overrides the looser standing rule (deploy-if-tracked-tree-clean), which applies only to small routine fixes — not to these tasks.

## First action
Branch `feature/hardening-server-state`, then **Task 1 Step 1**: read & summarize the persistence data flow (`pcg_portal_data_v8`/`pcg_sales_v1`/`pcg_tickets_v1` + every `storage` call) and **wait for Mike's go-ahead before editing.**
