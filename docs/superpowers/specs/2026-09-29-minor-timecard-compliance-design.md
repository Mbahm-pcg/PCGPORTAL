# Minor Timecard Compliance — Design Spec

## Overview

A new, fully automated weekly system that detects Pennsylvania minor-labor-law timecard violations (an employee under 18 working 5.0+ consecutive hours without a qualifying 30-minute break), notifies the people responsible for fixing them in an escalating sequence until each one is actually resolved, and gives visibility into current status via a new read-only Admin screen.

This is a **separate, new feature**, not a revival of the old `break-compliance-cron.mjs` (built July 2026, reverted, removed from the codebase — see commits `eeefe48`, `36aa073`, `b0d3f2a`, `bc09088`, `e9f3480`). That feature checked **live**, every 15 minutes during business hours, and alerted a manager **before** a violation happened. This feature checks **retrospectively**, once a week, after the fact, and drives a multi-day escalation to get an already-happened violation corrected in Paycor. The old feature stays retired; this is additive.

The reason the old feature could be reverted rather than fixed is resolved: determining minor status requires Paycor's `employeesIdentifyingData` endpoint (birthDate), which was blocked by a scope/activation issue. That issue is fixed as of 2026-09-28 (see `project_paycor_identifying_data_scope.md` memory) — `identifyingData` is a normal, working action in `netlify/functions/paycor.mjs` today.

## Background / What Gets Reused

From the old, working, since-removed implementation (`git show eeefe48:netlify/functions/break-compliance-cron.mjs` for full reference):

- Paycor OAuth token handling (same pattern as `labor-cron.mjs`).
- `fetchIdentifyingData()` — pulls `employeesIdentifyingData`, keeps only `employeeId`/`birthDate`, discards every other field (including `socialSecurityNumber`) before it leaves the mapping function. This rule is non-negotiable and must be preserved exactly: **only `birthDate` is ever used, stored, or logged.**
- `ageFromBirthDate()` — exact age calculation, unchanged.
- The minor-roster-per-store caching pattern (Active employees, cross-referenced against birthDate, filtered to age < 18), refreshed periodically rather than on every single check.
- The core "consecutive hours since the last qualifying break" shift-analysis logic — adapted here to run over a **whole past week's punches per day**, not "right now, today."
- PA's legal threshold: **5.0 consecutive hours without a break of at least 30 minutes** is a violation. (The old code's `MIN_BREAK_MINUTES = 15` was a *different* threshold — the minimum gap to count as "any break attempt at all" for the real-time proactive-warning use case. This feature only cares about the actual legal test: was there a break of **30+ minutes**. A shorter gap does not satisfy the requirement and does not prevent a violation.)

## What's New

### 1. Detection (Sunday)

New scheduled function: `netlify/functions/minor-timecard-detect-cron.mjs`.

- Schedule: `0 10 * * 0` (10:00 UTC = 6:00 AM ET on Sundays, matching the timing convention of other manager-facing morning digests like `schedule-alerts.mjs`).
- The week checked is the **7 days ending yesterday (Saturday)** — i.e., Sunday through Saturday, matching the Pulse/Tips week convention already used elsewhere in this codebase (not the Labor page's Monday-start convention — this is a deliberate choice, flagged here because the codebase uses both conventions in different places).
- For each of the 46 stores:
  1. Get that store's minor roster (Active employees, age < 18), reusing the cached-if-fresh pattern from the old feature.
  2. For each minor, fetch their punches for each of the 7 days of the past week individually (`employeePunches` per day, or a single 7-day range call if the endpoint supports it — implementation detail for the plan).
  3. For each day, compute actual worked segments. A day is a violation if the employee had 5.0+ consecutive hours of work with no gap of 30+ minutes between two punches anywhere in that stretch.
  4. For every violation day found that isn't already tracked as an open issue for that employee/store/week, create a new issue record (see Data Model) and queue it for the manager email.
- After scanning all stores: send one email per store that has at least one new issue this week, to that store's manager. (See Notifications.)

### 2. Daily Follow-Up / Escalation (every day)

New scheduled function: `netlify/functions/minor-timecard-followup-cron.mjs`.

- Schedule: `0 10 * * *` (6:00 AM ET, every day — including Sundays). Runs after the detection cron on Sundays, so ordering matters: **this cron only processes issues whose `firstFlaggedAt` is from a previous calendar day**, never the same day they were just created. Without this guard, a brand-new Sunday issue (already emailed once by the detection cron minutes earlier) would immediately get a second, redundant "reminder" email the same morning. An issue's real first follow-up check is always the next day.
- For every issue currently `status: 'open'` and not flagged today:
  1. Re-fetch that specific employee's punches for the **same violation date** from live Paycor data.
  2. Re-run the same violation check against the fresh data.
     - **If it no longer violates** (a 30+ minute break now shows, or the consecutive-hour stretch is now under 5.0h): mark the issue `status: 'resolved'`, `resolvedAt: now`, `resolvedVia: 'auto'`. No further emails for this issue.
     - **If it still violates:** continue to step 3.
  3. Determine escalation state:
     - If today's date is on or after the **Monday following** the issue's `weekEnd` (i.e., the first calendar day after the week closes, per the user's explicit "manager first, then if not complete by Monday it moves to Monday" requirement) **and** `escalatedAt` is not yet set: set `escalatedAt: now`. From this point forward, this issue's notifications include the DM for that store's district and every active `office_staff` user, in addition to the manager.
  4. Send today's reminder email to whoever is currently "in the loop" for this issue: manager only (not yet escalated) or manager + DM + all office_staff (escalated). This is a **daily repeat**, not a one-time send — confirmed explicitly by the user ("Until the store is finished with the minor time card").
  5. Record every attempted notification (recipient role, resolved email address, timestamp, success/failure) onto the issue's `notifications` array. A failed send (bad address, provider error) is recorded as `success: false` with the error — it must never look identical to a successful send, matching this app's existing convention for surfacing (not swallowing) notification failures.

**Backstop (my judgment call, flag if you want it different):** if an issue is still open **7 days after it escalated**, also notify exec/IT once (not repeated daily) — a safety net so a store that somehow stays broken for weeks doesn't just silently keep nagging the same three groups forever with no one above them ever finding out. No cap on how long the daily manager/DM/office-staff reminders continue beyond that; it always keeps checking until `resolved`.

### 3. Manual Override (safety valve)

Because Paycor's `punches`/`employeePunches` endpoints have a confirmed real gap where a manager's correction in Paycor's own UI doesn't always show up in the raw punch data even much later (found 2026-09-29, Omar Ali/Westchester case), the daily auto-resolve check alone cannot be fully trusted to always catch a real fix. The Admin UI (below) includes a **"Mark Resolved"** action, restricted to `exec`/`it`/`dm` roles, which sets `status: 'manually_resolved'`, `resolvedAt: now`, `resolvedVia: 'manual'`, `resolvedBy: <user id>`, and stops the daily follow-up/escalation for that issue immediately. This requires a lightweight confirm step (not a full modal — a native `confirm()`-style "Are you sure? This stops the daily reminders." is sufficient) since it's a meaningful, hard-to-silently-undo action per this app's existing pattern for destructive/consequential actions.

### 4. Data Model

New Netlify Blob key: `pcg_minor_timecard_issues_v1`, wrapped in the standard `{ savedAt, data }` shape. `data` is an array of issue records:

```js
{
  id: string,                  // stable, e.g. `${pc}_${employeeId}_${violationDate}`
  pc: string,
  storeName: string,
  district: number,
  employeeId: string,          // Paycor employee GUID
  employeeName: string,
  weekStart: string,           // ISO date, the Sunday that opens this issue's week
  weekEnd: string,             // ISO date, the Saturday that closes it
  violationDate: string,       // ISO date, the specific day that violated
  consecutiveHours: number,
  status: 'open' | 'resolved' | 'manually_resolved',
  firstFlaggedAt: string,      // ISO datetime, when the Sunday detection created this
  escalatedAt: string | null,
  resolvedAt: string | null,
  resolvedVia: 'auto' | 'manual' | null,
  resolvedBy: string | null,   // user id, only set for resolvedVia:'manual'
  notifications: [
    { recipientRole: 'manager'|'dm'|'office_staff', recipientEmail: string, sentAt: string, success: boolean, error: string|null }
  ],
}
```

A second blob, `pcg_minor_roster_v1` (same key/shape the old feature used), caches each store's current minor roster so the birthDate lookup isn't repeated on every single run. Refresh cadence: daily, same `ROSTER_MAX_AGE_MS = 24h` pattern as before.

Both are plain Netlify Blobs (not Neon Postgres) — consistent with the old implementation, and this data doesn't need relational queries or joins; it's read as a small, whole array by both cron functions and the UI.

### 5. Notifications

- **Email only.** No push or SMS for this feature (unlike the old real-time version) — this was never raised as a requirement in the design conversation, and a once-a-day-at-most digest doesn't need push/SMS's speed.
- Subject lines:
  - Sunday, manager only: `⚠ Minor Timecard Review Needed — {Store Name}`
  - Monday+, escalated (manager + DM + office staff): `⚠ Minor Timecard Still Open — {Store Name} (Day {N})` — `{N}` is the number of calendar days since `firstFlaggedAt`.
- **One email per store per day**, not one per violation — if a store has multiple open issues (different minors and/or different days), they're all listed as separate cards in the same email.
- Each violation card shows:
  - Employee name and the violation date.
  - A punch timeline: clock-in time, then either "No break recorded during shift" or, if a break attempt under 30 minutes was found, "Break attempt: {N} min (below the 30-minute requirement)" — never rendered identically to zero break at all — then clock-out time.
  - A summary strip: hours worked / the 5.0h PA limit / minutes of break actually taken.
- A direct link to Paycor (not this Portal) as the call to action, since the actual fix happens there.
- Recipients are resolved from the existing `pcg_users_v1` blob at send time: manager = the active `manager` user for that `pc`; DM = the active `dm` user for that `district`; office staff = every active user with `userType: 'office_staff'`.
- Sent via Resend, matching every other automated alert email in this codebase (`tips-reconcile-cron.mjs`, `schedule-alerts.mjs`, etc.).

### 6. Admin UI

New screen, reachable as a Tools-hub tile ("Minor Timecard Compliance", needs its own unique icon per this project's standing rule — no reused icon).

**Visibility/scope** (role-based, no manual toggle):
- `exec` / `it`: every store.
- `office_staff`: every store, read-only (no "Mark Resolved").
- `dm`: stores in their own district only.
- `manager`: their own store only.

**Layout:**
- Header: icon, title, subtitle showing the last run time, and a week selector (defaults to the current/most recent week).
- Three clickable stat panels: **Open** (amber), **Escalated** (red), **Resolved this week** (green) — clicking one filters the list below to that status.
- A filter/status row above the list (district count, status dropdown) for the exec/IT/office-staff views, where there's enough data to make filtering useful; not needed for a manager's single-store view.
- One row per store with an open/recently-resolved issue: colored status accent, avatar circle with the store's initial, store name/district/pc, status badge, a notification-progress bar + mini activity trail (who's been notified, when, success/fail), "View Details" (expands to the same per-violation breakdown as the email), and "Mark Resolved" (only for `exec`/`it`/`dm`, with the confirm step from §3).

**Visual language:** matches the live app's actual `src/theme.js` DARK tokens (background `#0f0f0f`, card `#1c1c1c`/`#242424`, border `#2a2a2a`, text `#e8e8e8`, muted `#a0a0a0`), Raleway for headings and Source Sans 3 for body text, and the brand orange (`#FF671F`) for primary actions — not a generic or unrelated color scheme. Status colors: amber (open), red (escalated), green (resolved) — always paired with an icon and text label, never color alone.

## Explicitly Decided Edge Cases

- **A minor with multiple violation days in the same week, same store:** one issue record per violation day, but bundled into a single email/UI row per store (multiple cards within it), not one email per violation.
- **A minor working at more than one store in the same week:** tracked independently per store — this matches how hours/tips are already store-scoped everywhere else in this codebase; there's no cross-store merging.
- **Week boundary:** Sunday–Saturday (Pulse/Tips convention), explicitly not the Labor page's Monday-start convention. Called out here because both conventions exist elsewhere in this app and it would be an easy, silent bug to use the wrong one.
- **Unresolved for a very long time:** the daily manager/DM/office-staff cycle never stops on its own; a one-time exec/IT notification fires once an issue has been escalated for 7 days, as a backstop, not a resolution mechanism.

## Explicit Non-Goals

- This does **not** revive or modify the old real-time (every-15-minutes) proactive break-warning alerts. That stays retired.
- This does **not** attempt to auto-correct anything in Paycor. It only detects, notifies, and tracks — the actual fix always happens in Paycor's own UI, by a human.
- This is not a substitute for confirming PA minor labor law specifics with HR/legal — same disclaimer the old feature carried, kept in every email footer.

## Open Questions for Review

1. The 7-day exec/IT backstop notification (§2) was not explicitly requested — flag if you'd rather it not exist, or fire on a different timeline.
2. The "Mark Resolved" confirm step (§3) — a simple browser confirm, not a full modal, unless you want more ceremony there.
3. Email-only, no push/SMS (§5) — confirm this is fine, since the old feature did use push+SMS for its (different, real-time) use case.
