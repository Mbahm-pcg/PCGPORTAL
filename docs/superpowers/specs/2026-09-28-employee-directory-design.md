# Employee Directory — Design Spec

**Date:** 2026-09-28
**Status:** Approved for planning

## Problem

Filing a Workplace Incident Report today means typing the subject employee's
name, DOB, and other details cold — even though the Portal already has (or
can now get) most of that from Paycor. When Sam, Mike, or Ahmed files a
report for a store, they should be able to search by a few letters of a
name and have the record fill in automatically, scoped to the store already
selected on the report.

This became possible after resolving a long-standing Paycor access blocker
(see [[project_break_compliance_parked]] memory) — `employeesIdentifyingData`
(the endpoint that returns `birthDate`) now works in production.

## Goals

- A searchable local directory of employees, keyed by Paycor's own employee
  ID, holding whatever of {name, DOB, work email, status, store} Paycor
  actually provides for free from data we already have access to.
- Kept fresh automatically, without anyone manually maintaining it.
- Search scoped to one store at a time (matches the Incident Report's own
  flow: pick a store, then search that store's people).
- Wired into the Incident Report's Subject Employee section: typing a name
  after picking a store shows matches; selecting one fills Name, DOB, and
  Email.

## Non-goals

- **No home address or phone number** — confirmed by inspecting a real
  Paycor `/employees` response: neither field exists anywhere in the
  payload. Address and Phone stay manual entry on the Incident Report form,
  same as today.
- Not a general-purpose company directory UI elsewhere in the app — this is
  built for the Incident Report's autofill need specifically. (Reusing it
  elsewhere later is one of the ideas parked in
  [[project_incident_report_future_ideas]].)
- No write-back to Paycor — this is read-only, one direction (Paycor →
  Portal).
- No cross-store search (a manager filing a report always has one store
  selected first; searching "everyone network-wide" was explicitly declined
  earlier when scoping the Incident Report's own person-search).

## Data model

New Postgres table `employee_directory`, one row per Paycor employee record
(the GUID, e.g. `4064f8f0-f191-0000-0000-000060f50200`, is the natural
primary key — stable across a single employee's records per the codebase's
existing "match by GUID within one fetch" pattern in `tips-report-cron-
background.mjs`):

```sql
CREATE TABLE IF NOT EXISTS employee_directory (
  paycor_employee_id text PRIMARY KEY,
  employee_number   text,
  first_name        text,
  last_name         text,
  email             text,
  birth_date        text,
  status            text,            -- 'Active' | 'Terminated' | etc, verbatim from Paycor
  store_pc          text,
  legal_entity_id   text,
  synced_at         timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_directory_store ON employee_directory(store_pc);
CREATE INDEX IF NOT EXISTS idx_employee_directory_name ON employee_directory(store_pc, last_name, first_name);
```

Terminated employees are kept, not deleted — an incident report can
legitimately involve someone who has since left. `status` lets search/UI
de-prioritize them (e.g. sort Active first) without hiding them.

## Sync: `employee-directory-cron.mjs`

A new, dedicated scheduled function (not piggybacked on Tips, per explicit
direction) — daily, off-peak (e.g. `0 8 * * *` UTC / 4am ET, ahead of the
morning Tips/labor crons). For each store in `STORES`:

1. Call `paycor.mjs`'s `employees` action (paginated via
   `continuationToken`, same pattern `tips-report-cron-background.mjs`
   already uses) → `{id, employeeNumber, firstName, lastName, email,
   statusData.status}` per record.
2. Call `paycor.mjs`'s `identifyingData` action for the same legal entity
   (also paginated) → `{employeeId, birthDate}` per record.
3. Merge the two by `id`/`employeeId` (both come from the *same* `/employees
   ?include=All` fetch's legal entity in the *same* run, so — per the
   existing codebase note that Paycor's GUID is stable within one fetch —
   no name-based fallback matching is needed here, unlike the tips report's
   cross-day/cross-snapshot case).
4. Upsert one row per employee into `employee_directory` (`ON CONFLICT
   (paycor_employee_id) DO UPDATE`).

This is a plain read-and-replace sync — no dedup/ambiguous-name logic
needed, since the primary key is Paycor's own stable GUID, not a name.

**Server-side, never client-side:** the SSN-discarding rule from
[[project_paycor_identifying_data_scope]] applies here too, transitively —
`identifyingData`'s existing mapping in `paycor.mjs` already drops
`socialSecurityNumber` before this cron ever sees the response, so there is
nothing further to guard here, but it's worth stating: this cron must never
introduce a second path to the raw Paycor response that bypasses that
mapping.

## Search

New action on a new lib module `netlify/functions/employee-directory.mjs`
(or an added action on `incident-reports.mjs` — implementation detail for
the plan, likely its own file since it's a distinct concern): `action:
'search'`, body `{ storePc, query }` → returns up to ~10 matches where
`first_name || ' ' || last_name` contains `query` (case-insensitive),
scoped to `store_pc = storePc`, Active-first ordering. Exec/IT and any
logged-in user can call this (matches "everyone can file a report" — the
search itself reveals only name/DOB/email of people at a store the caller
already knows they're filing a report for, not new information).

## Frontend

In `IncidentReportsTab`'s Subject Employee section, the "Employee Name"
input becomes a type-ahead: on each keystroke (debounced), if `form.storePC`
is set, call the search action and show a small dropdown of matches.
Selecting one sets `employeeName`, `employeeDob`, and `employeeEmail` on the
form (Address/Phone are left as-is — nothing to fill them from). Typing a
name with no match behaves exactly as today (free text, no autofill) — the
directory catches up automatically on its next daily sync if it's a
genuinely new hire.

## Addendum, 2026-09-28 — renamed to `employee-directory-cron-background.mjs`

A real manually-triggered run hit a flat 60000ms timeout partway through
45+ stores × 2 Paycor calls each (confirmed via Netlify's function log — a
suspiciously round `Duration: 60000 ms`). Same problem class
`tips-report-cron-background.mjs` already exists to solve; fixed the same
way — renamed the function file to end in `-background`, which is what
grants Netlify's 15-minute execution budget. `netlify.toml`'s function key
and the schedule are otherwise unchanged.

## Testing

- Pure merge/shape logic (combining an `employees` page and an
  `identifyingData` page into upsert-ready rows) goes in a new
  `src/employee-directory.mjs` + `.test.mjs`, following the established
  pure-module pattern.
- The cron's per-store loop and DB upsert are I/O and aren't unit-tested
  directly (consistent with how `labor-cron.mjs`/`tips-report-cron-
  background.mjs` are handled in this codebase) — verified via a manual
  trigger + inspecting the table, before relying on the schedule.
