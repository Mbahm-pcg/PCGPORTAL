# Per-User Audits Access Grant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-settable per-user `audits_access` grant (`null`/`'view'`/`'full'`) that elevates any user's Audits-module access, enforced server-side and editable only by executive/it.

**Architecture:** A pure elevation helper (`audit-lib/access.js`, tested) is the single source of truth; `users.mjs` owns the column + admin write path; `require-user.js` returns the grant on claims per-request; `audits.mjs` and the frontend both gate through the same elevation rule.

**Tech Stack:** Same as the module — CommonJS libs + node:test, .mjs Netlify functions, Neon Postgres, app.jsx/esbuild.

**Spec:** `docs/superpowers/specs/2026-07-11-audits-access-grant-design.md` (binding; read it first)

## Global Constraints

- `audits_access` values: `null` | `'view'` | `'full'` — anything else rejected with 400.
- Only `executive`/`it` may set/change the field (server-enforced 403 otherwise, even though office_staff can edit some users).
- Grants only elevate, never reduce. `'view'` ⇒ office_staff-equivalent module access; `'full'` ⇒ auditor-equivalent (conduct + verify-close + manager rankings).
- Column added via idempotent `ALTER TABLE users ADD COLUMN IF NOT EXISTS audits_access text` (users.mjs, before first use).
- `APP_VERSION` → `"v18.38"` (current: v18.37); rebuild app.js; commit both.
- Branch `feature/audits-access-grant`; no push to main, no deploy without Mike's explicit approval.
- All 159 existing tests must stay green; new access tests join the `audit-lib` glob.

---

### Task 1: Elevation helper (`audit-lib/access.js`)

**Files:** Create `netlify/functions/audit-lib/access.js`, `netlify/functions/audit-lib/access.test.js`

**Interfaces (produces):** `effectiveAudits(userType, grant)` → `{ canView: bool, canAudit: bool, effUserType: string }`.
- Baselines: canView roles = auditor/executive/it/office_staff/dm (+manager? NO — manager's CAP card is separate; canView=false for manager baseline). canAudit roles = auditor/executive/it.
- grant `'view'` → canView=true. grant `'full'` → canView=true, canAudit=true. Invalid/unknown grant values behave as null.
- `effUserType` = userType, except grant==='full' and userType not in {auditor,executive,it} → `'auditor'` (for canTransition).

- [ ] Step 1: failing tests — full matrix: each of the 11 known roles × {null,'view','full'}; unknown role ('vendor', undefined) × grants; invalid grant string treated as null; executive+'view' keeps canAudit=true (never reduces).
- [ ] Step 2: run (fail) → implement (~20 lines, VERIFIERS/VIEWERS sets) → run (pass) → `npm test` green.
- [ ] Step 3: Commit `feat(audits): per-user access elevation helper`.

### Task 2: Backend wiring

**Files:** Modify `netlify/functions/users.mjs`, `netlify/functions/auth-lib/require-user.js`, `netlify/functions/portal-auth.mjs`, `netlify/functions/audits.mjs`, `db/schema.ts` (doc), `netlify/functions/auth-lib/require-user.test.js` (extend if it stubs the SELECT)

**Interfaces (consumes Task 1's `effectiveAudits`).** Steps:
- [ ] users.mjs: idempotent `ensureAuditsColumn()` (ALTER TABLE IF NOT EXISTS) called before create/update/list; `toClient` maps `audits_access` → `auditsAccess`; create/update: if `auditsAccess` present in payload — 400 unless value ∈ {null,'view','full'}, 403 unless caller executive/it; write it.
- [ ] require-user.js `requireActiveUser`: add `audits_access` to the SELECT, return claims with `auditsAccess` (null-safe). Update its tests.
- [ ] portal-auth.mjs: SELECTs already fetch the users row — include `audits_access`; add `auditsAccess` to claims object and login response user payload.
- [ ] audits.mjs: `const eff = effectiveAudits(user.userType, user.auditsAccess)` once per request; replace `FULL_VIEW.has(user.userType)` → `eff.canView` **except** keep dm district scoping logic keyed on real userType; replace `CAN_AUDIT.has(...)` → `eff.canAudit`; CAN_UNLOCK unchanged (executive/it only); `capUpdate` passes `eff.effUserType` to `canTransition`; dashboard gate = `eff.canView || userType==='dm'` (dm already in canView baseline — simplify accordingly); manager-rankings visibility in dashboard payload/UI keyed on `eff.canAudit`.
- [ ] db/schema.ts: add `auditsAccess` line to users doc block.
- [ ] `npm test` green; `node --check` each .mjs; commit `feat(audits): audits_access grant — column, claims, server enforcement`.

### Task 3: Frontend

**Files:** Modify `app.jsx` (getTabs, AuditsTab gates, Admin user editor), rebuild `app.js`

- [ ] getTabs: after the role branches compute their list, append the audits tab `{ id: 'audits', label: 'Audits', icon: (c) => ICONS.audits(c) }` when `user.auditsAccess` is 'view'/'full' and the list lacks it (grep `getTabs`; keep role branches untouched).
- [ ] AuditsTab + children: every `["auditor","executive","it"].includes(user.userType)`-style gate becomes a shared `canAuditFn(user)` = role check OR `user.auditsAccess === 'full'`; CapBoard/dashboard visibility checks include `auditsAccess` ∈ {view, full}; manager-rankings client gate uses canAuditFn.
- [ ] Admin → Users editor: "Audits module" `<select>` — Role default / View only / Full audit powers — mapped to `auditsAccess` null/'view'/'full'; rendered only when the editing admin is executive/it (grep the editor form near the userType `<select>`; follow its style); the users-list row may show a small "Audits: view/full" chip when set.
- [ ] `APP_VERSION` → "v18.38"; `npm run build`; commit both files: `feat(audits): per-user audits access grant UI (v18.38)`.

### Task 4: Verify + gate

- [ ] `npm test` (all green), fresh `npm run build` zero-diff, final whole-branch review, push branch. **STOP: Mike approves merge+deploy explicitly.**
