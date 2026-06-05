# P&L Access Control — Design Spec

**Date:** 2026-06-04
**Status:** Approved (design)
**Context:** Phase 7.1 Live Store P&L shipped (v14.17). P&L is currently visible to all admin/DM/manager roles. Mike wants it restricted.

## Goal

Restrict the **P&L** tab to an explicit allowlist (initially **Mike, Ahmed, Krunal**). Provide a **Settings → "P&L Access"** panel — visible only to **Mike & Ahmed** — to grant/revoke P&L visibility for any user. No one else sees the tab or can route to it.

## Identity model (handles messy data)

The three people have inconsistent/duplicate records (case differences, multiple usernames):
- Mike → `mike.bahm` / `Mike@PeopleCapitalGroup.com`
- Ahmed → `ahmed` **and** `ahmed@peoplecapitalgroup.com`
- Krunal → `Krunal` **and** `Krunal@Raogroupinc.com` (chat code also checks `krunal`)

All checks therefore **normalize to lowercase** and match a user's **username OR email**.

## Architecture

### 1. Pure access helpers — `src/pnl-access.mjs` (new, ESM, unit-tested)

```
PNL_MANAGERS = ['mike.bahm','mike@peoplecapitalgroup.com','ahmed','ahmed@peoplecapitalgroup.com']
DEFAULT_PNL_ALLOWED = ['krunal','krunal@raogroupinc.com']   // managers are always allowed implicitly
pnlIds(user)               → [lowercased username, lowercased email] (falsy removed)
canManagePnlAccess(user)   → user matches a manager id
canViewPnl(user, allowed)  → manager OR user id ∈ normalized(allowed)
normalizeId(s)             → String(s).trim().toLowerCase()
```
ESM `.mjs` so esbuild bundles it into `app.jsx` AND `node --test` can run `src/pnl-access.test.mjs` natively.

### 2. Storage — blob `pcg_pnl_access_v1`

`{ allowed: [normalized id strings], updatedAt, updatedBy }`. Seeded (when absent) with `DEFAULT_PNL_ALLOWED` so Krunal sees P&L before any save. Managers always allowed regardless of the list.

### 3. Gating (single source of truth) — `app.jsx`

`PCGPortal` loads the blob into state on mount (`cloudLoad('pcg_pnl_access_v1')`, fallback `DEFAULT_PNL_ALLOWED`), computes `canPnl = canViewPnl(user, allowed)` and `canManagePnl = canManagePnlAccess(user)`.
- **Sidebar:** filter the `pnl` tab out of the rendered tab list unless `canPnl` (it currently lives in `getTabs` role arrays + `ADMIN_GROUPS.ops` + `DM_GROUPS.dm_ops`; pass `canPnl` into the Sidebar and drop `pnl` when false). This replaces the broad role-based exposure.
- **Routing:** `{tab === "pnl" && canPnl && <AdminPnL …/>}` (was `isFullAdmin||isOfficeStaff||isDM||isManager`).

### 4. Settings → "P&L Access" panel (managers only)

Rendered in the Settings tab only when `canManagePnl`. UI:
- Current allowed people as **removable chips** (managers shown as locked/always-on).
- **"Add by email or username"** text input (robust to the duplicate-record problem — no confusing per-user toggle rows).
- **Save** → `cloudSave('pcg_pnl_access_v1', { allowed, updatedAt, updatedBy })` and update local state so the change takes effect immediately.

### 5. Security model (accepted)

Gating is **client-side**, consistent with all existing permissions in this app. It removes the tab and blocks routing. The underlying `pcg_pnl_live_v1` blob is served by the `storage` function without per-user auth, so it is not cryptographically protected. **Mike accepted client-side gating "for now"** (2026-06-04).

## Testing

- `src/pnl-access.test.mjs` (node:test): manager match (both Mike/Ahmed ids), grantee match, case-insensitive + email-or-username, duplicate-identity (Krunal variants), denial for non-listed users, empty/nullish list. Wire `src/*.test.mjs` into `npm test`.
- Manual: Mike & Ahmed see tab + Settings panel; Krunal sees tab, NOT panel; a DM/office_staff sees neither tab nor route; grant a test user → gains access, revoke → loses it.

## Out of scope
- Server-side auth on the data endpoint (larger change; deferred).
- Per-user toggle UI (rejected due to duplicate records).
