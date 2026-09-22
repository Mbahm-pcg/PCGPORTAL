# Manager Sync (Paycor-Driven Manager Detection) — Design Spec

## Purpose

Store manager accounts in the Portal are hand-maintained and go stale: nothing today notices when Paycor shows a different person now holding the manager title at a store. This feature detects that automatically, using data `labor-cron.mjs` already pulls every hour for payroll, and surfaces it as a one-click action on the existing Admin · Users page — never applying a change on its own.

This is Part B of the Locations manager/employee work; Part A (live employee count on Locations, from the same Paycor data) shipped separately (v21.05/v21.06, 2026-09-22).

## Rules (as agreed 2026-09-22)

- **Manager-title match:** an active employee whose title contains "manager" (case-insensitive) and does **not** also contain "assistant". Title comes from the same field labor-cron already reads (`emp.jobTitle || emp.department || ''`). "Assistant Manager" and "Assistant General Manager" are excluded; "Store Manager" and "General Manager" count.
- **No new Paycor calls.** Detection runs inside `labor-cron.mjs`'s existing hourly per-store processing, against the exact `employees` array it already fetches and filters to `Active` (the same array `today.employees` is already counted from).
- **Exactly one match, and it's not the currently-linked manager (or there is no linked manager)** → queue a **replace** change immediately. No waiting period — the human-approval step already guards against acting on one bad read.
- **Two or more matches at once** → queue a **needs-review** flag. Never auto-pick between them.
- **Zero matches** → queue a **vacant** flag, but only once the store has had zero matches continuously for **3 straight weeks** of hourly checks. A short medical/other leave must never look like a departure. (This 3-week rule applies only to the zero-match case — a clear single replacement is never delayed.)
- **Identity link, not ongoing name matching.** `users` gets a new nullable `paycor_employee_id` column. Once linked, every future comparison for that store is an exact ID match. Fuzzy name comparison is used **only once per store**, to bootstrap the link for an already-correct, already-serving manager who predates this feature (see Bootstrap linking below) — never on a routine hourly check.
- **New account email:** left blank in the pre-fill. Paycor's personal-email field isn't used (dropped 2026-09-22 to avoid depending on an unverified field) — the admin types in whatever email they want when reviewing the pre-filled form, same as creating any other user today. Never falls back to the shared store inbox (the outgoing manager may still read that).
- **Outgoing account:** deactivated (`active: false`), never hard-deleted. Preserves ticket/task/chat/audit history tied to that user id and is reversible if a Paycor read turns out wrong.
- **Nothing is automatic beyond detection.** Creating the new account and deactivating the old one both require an explicit admin click. Paycor showing a change never touches a real account by itself.

## Detection — extends `labor-cron.mjs`

- Inside `processStore`, immediately after the existing `Active`-filtered `employees` array is computed (no new fetch), compute that store's manager-title matches using a new pure function `detectManagerCandidate(employees, currentLinkedEmployeeId)` in a new module `src/manager-sync.mjs` (mirrors the `src/no-clockin.mjs` / `system-health-lib/recipients.mjs` pattern already used today: no I/O, fully unit-testable). Returns one of:
  - `{ status: 'ok' }` — matches the linked employee, nothing to do.
  - `{ status: 'replace', candidate: { employeeId, name, jobTitle, personalEmail } }`
  - `{ status: 'needsReview', candidates: [...] }`
  - `{ status: 'zeroMatch' }` — the vacant-streak counting (3 weeks) happens in the aggregation step below, not in this pure function, since it needs history across runs.

### Bootstrap linking (handles day one, and any future store whose manager predates a link)

Every existing manager account starts with `paycor_employee_id = null`. Without special handling, the very first hourly run after this ships would see 45 stores' worth of "current manager has no link" and misreport every one of them as a `replace` candidate — including the ones that are already correctly staffed. To avoid that:

- When a store has **exactly one** manager-title match and its currently-linked-by-`store_pc` Portal manager account (`storeMgrName`'s own lookup: active, `userType='manager'`, matching `store_pc`) has **no** `paycor_employee_id` yet, compare the Paycor candidate's name against that Portal account's `name` with a normalized, lenient comparison (case/whitespace/punctuation-insensitive, matching on first + last token — good enough to equate "MD Obaid" and "MD Obaid Amin", not a hard exact match).
  - **Names correspond** → silently set `paycor_employee_id` on the existing account. No notification, no admin action, nothing queued. This is the expected outcome for the large majority of stores on day one.
  - **Names don't correspond, or there's no current Portal manager at all** → this is a genuine `replace` candidate, queued exactly like any other detected replacement (even on day one — if Paycor already shows a real, different person, that's real information worth surfacing right away, not something to suppress).
- This bootstrap check only ever runs for a store whose linked manager has no `paycor_employee_id`. Once a store has a link, every future check is the exact-ID comparison described above — this fuzzy pass never runs again for that store unless the account is later replaced and a new one goes through the same bootstrap step in turn.

- After `processAllStores` finishes (same place the existing `pcg_labor_v1` network blob gets built), a small aggregation step:
  1. Reads current manager accounts (`SELECT id, name, store_pc, paycor_employee_id FROM users WHERE user_type='manager' AND active=true`).
  2. Loads the previous pending state from `pcg_manager_pending_v1`.
  3. For each store, combines this run's candidate result with the loaded state to decide: keep waiting (zero-match streak not yet 3 weeks), promote to a queued item, or leave an existing queued item as-is (don't re-notify for something already pending and unresolved).
  4. Persists the updated pending state (including the running zero-match week-count per store).
  5. For any store whose pending item is newly created this run, appends one entry to `pcg_notifications_v1` (the same blob `pos-negative-cron.mjs` already writes to for the bell), with a deep link to Admin · Users.

## Pending state — blob `pcg_manager_pending_v1`

One entry per store that currently has something to show:

```json
{
  "339616": {
    "kind": "replace",
    "candidate": { "employeeId": "...", "name": "Jane Doe", "jobTitle": "Store Manager", "personalEmail": "jane@example.com" },
    "outgoingUserId": 42,
    "detectedAt": "2026-09-22T14:00:00.000Z"
  },
  "340794": { "kind": "vacant", "zeroMatchWeeks": 2, "lastSeenMatchAt": "2026-09-08T..." }
}
```

- `kind`: `replace` | `needsReview` | `vacant`.
- Cleared for a store the moment the admin resolves it (creates the new account and/or deactivates the old one) or explicitly dismisses it.
- Standard `{ savedAt, data }` blob wrapper.

## Surfacing

- **Bell notification** (`pcg_notifications_v1`, same mechanism `pos-negative-cron.mjs` already uses): one entry per newly-queued pending item, e.g. "Detected: replace Satpal Kaur with Jane Doe at Drexel Hill." Deep-links to Admin · Users.
- **Admin · Users page:** a small "N pending" indicator near the existing "Active" pill (`app.jsx:3757-3760`). Clicking it:
  - For a `replace` item: calls the existing `openEditPage(prefill)` (`app.jsx:3438`) with a synthetic object — `{ name, userType: 'manager', storePC, username: <suggested>, password: <generated> }` (no `email` — left for the admin to type in) and **no `id` field**, which the existing form already treats as "create new" (confirmed: `setEditId(u ? u.id : null)` — an object with no `id` sets `editId` to `undefined`, same falsy path as the explicit `null` case). The admin reviews/edits (including adding an email) and clicks the existing "Create User" button; the existing `sendWelcomeEmail` flow (`app.jsx:3369`) runs unchanged, but only if the admin filled in an email (matching that flow's existing `if (!newUser.email) return;` guard). On successful creation, the new user's `paycor_employee_id` is set to `candidate.employeeId`, and the pending item for that store is cleared.
  - The outgoing manager's existing row shows a suggested "Deactivate" action (sets `active: false`, does not delete). Clearing the pending item does not require the admin to also deactivate the old account in the same action — creating the new manager and deactivating the old one are two separate clicks, and the pending item only fully clears once both are done (see Edge cases).
  - For a `needsReview` or `vacant` item: no pre-fill, just the heads-up text and the store name; a human decides what to do (there's no single obvious action to suggest).

## Pre-fill generation (new — no existing convention to reuse)

Nothing in the app currently auto-suggests a username or password; every user today is created by an admin typing both by hand. This feature introduces the first such generator, used only to seed the pre-filled form (the admin can edit either before clicking Create):

- **Username:** first initial (uppercase) + "." + full last name (capitalized), alphanumeric only aside from the separating dot (e.g. "Jane Doe" → `J.Doe`, "MD Obaid Amin" → `M.Amin`). On collision with an existing username (compared case-insensitively — the server lowercases every username anyway), append `2`, `3`, ... until unique.
- **Password:** a random string satisfying the app's own existing policy (`validatePasswordClient`, `app.jsx:559` — 12+ characters, at least one lowercase, one uppercase, one digit, one special character). Since it's a pre-fill the admin can change, it only needs to already pass validation, not be memorable.

## Safety rails

- Detection never mutates a real account. The only writes detection itself makes are to the `pcg_manager_pending_v1` blob and `pcg_notifications_v1`.
- The identity link means a manager's name being spelled slightly differently in Paycor vs. the Portal never triggers a false "replace" — only a genuine different employee ID does.

## Edge cases

- **Partial resolution:** admin creates the new manager but hasn't deactivated the old one yet. The pending item stays open (shown as "new manager added — deactivate the old account to finish") until both sides are done, so a store never silently ends up with two active linked managers.
- **Store closes (Permanently Closed / Temp Closed) while a pending item is open:** leave the pending item as-is; it's cheap and correct to just let the admin dismiss it manually. Not worth special-casing.
- **A newly-added store with no Paycor legal entity yet:** `employees` is empty every run; this immediately starts the 3-week vacant counter like any other zero-match case rather than a special "new store" path — simplest, and 3 weeks is enough runway for a brand-new store to get its Paycor setup done before anything is surfaced.
- **Multiple stores share the same Paycor legal entity or employee** (not currently a known real case, but not assumed impossible): each store's detection is independent, keyed by `store_pc`; the same employee could in principle become a `replace` candidate at more than one store simultaneously. Not specially handled — each store's pending item is independent and both would need separate admin action.

## Out of scope for v1

- Automatically deactivating/creating without a click.
- Retroactively linking every existing manager account to a Paycor employee ID in bulk (each store's first real detection handles its own linking as it comes up naturally).
- SMS/email alerting for a pending item beyond the existing bell notification.
- Any UI for browsing pending-item history after it's resolved.

## Open items for the plan

- Confirm no other code path already relies on `users.paycor_employee_id` not existing (should be safe — brand new nullable column).
