# Schedule Builder — Desktop Grid + Mobile Reassign — Design Spec

## Overview

Extends the existing Schedule Builder (`ScheduleBuilder`, `EmployeeScheduleCard`, `WeeklyScheduleGrid` in `app.jsx`, see `2026-08-25-labor-schedule-builder-design.md`) with a device-appropriate editing surface before it rolls out to managers broadly:

- **Desktop / Chromebook** (viewport ≥1024px): a new directly-editable grid — same visual shape as the existing read-only `WeeklyScheduleGrid` (employee rows × Sun–Sat columns), matching the look of Paycor's own native Schedules view per the manager's reference screenshot, with hover-to-reveal Edit/Copy/Cut on each shift and Paste on empty cells.
- **Mobile** (<1024px): the existing one-card-per-employee flow, unchanged in structure, gaining two small additions: reassigning a shift to a different employee, and reopening an employee's card from the Final Review step by tapping their name.

No backend changes. Both paths still end at the existing batched `createSchedulingShifts` call (`handleSendToPaycor`) — reassignment only changes which employee's in-memory shift list a shift sits in before that batch is built, and the existing write payload already sends `employeeId` per shift.

## Device Split

A `useIsDesktopViewport()` hook (`window.matchMedia('(min-width: 1024px)')`, live-updated on resize) decides which path `ScheduleBuilder` renders for `mode === 'build'`. This is automatic and per-render — the same manager sees the grid on their store Chromebook and the card stack on their phone, no separate setting to maintain. `mode === 'view'` (DM/Exec/Office Staff/IT read-only) is unaffected either way — it keeps using the existing read-only `WeeklyScheduleGrid` on both device sizes.

## Desktop: `EditableScheduleGrid` (new component)

Same table shape/props as `WeeklyScheduleGrid` (reuses `SCHEDULE_DOW`, the same day-column layout, the same Open Shifts rows), but every cell is interactive. Kept as a **separate** component rather than an `editable` prop bolted onto `WeeklyScheduleGrid` — the read-only grid stays a simple, pure renderer (used for `view` mode and unaffected by this work); all the new interactive/clipboard logic lives only in the new component.

**Per-shift-block hover:** three small inline icon buttons appear directly on the block — Edit (pencil), Copy, Cut.

- **Edit** opens a popover anchored to the block:
  - From*/To* time inputs (`type="time"`, same as the mobile edit rows)
  - Re-assign — a dropdown of this week's other employees; picking one moves the shift to them (removes from the current employee's shift list, adds to the target's, same day/time)
  - Save / Delete
  - **Not in this pass:** "Move to open shift" (visible in Paycor's own popover, dropping `employeeId` to show a shift as unassigned coverage) is deferred — it assumes `createSchedulingShifts` accepts an employee-less shift, which isn't verified against the real API yet. Delete covers the same practical need (remove the assignment); reintroducing it as a real open shift is a follow-up, not blocking this rollout.
- **Copy/Cut** stores `{ shift, sourceEmployeeId, sourceDayOffset, mode: 'copy' | 'cut' }` in local component state. Cut immediately removes the shift from its current cell. Only one item is held at a time — starting a new Copy/Cut, or pressing Escape, clears whatever was pending.
- **Empty-cell hover:** if something is pending, a **Paste** button appears; clicking it creates a shift on that employee/day using the pending shift's time. A **Cut**-sourced paste clears the pending state after the one paste (move semantics). A **Copy**-sourced paste leaves it available for pasting again elsewhere (duplicate semantics) until cleared.

No separate per-employee approve step on desktop — the whole roster is visible and directly editable at once. `RunningLaborHeader` stays visible above the grid (fed from live `cards` state, not `approvedCards` — there's no separate approved/unapproved distinction on this path), and a single **Send to Paycor** button sits below the grid, calling the existing `handleSendToPaycor` against the current `cards` array.

## Mobile Additions

1. **Re-assign a shift** — within an employee's Edit view (the Sun–Sat rows shipped 2026-08-06), each existing shift row gets a small "⇄" button next to the ✕ remove button. Tapping it shows a short picker of this week's *other* employees; selecting one removes that shift from the current employee's `draftShifts` and adds it (same day/time) onto the target employee's approved shifts. Requires `ScheduleBuilder` to pass the current roster + a reassignment handler down into `EmployeeScheduleCard` (today it only receives its own card + `onApprove`/`onSave`).
2. **Live preview while building** — a collapsible "Preview schedule so far" panel available throughout the card-by-card walk (not just at Final Review), reusing the existing read-only `WeeklyScheduleGrid` fed with `approvedCards` (shifts already locked in for employees already stepped through — the card currently being edited isn't included until it's Approved/Saved). Collapsed by default so it doesn't crowd the one-card-at-a-time flow; expanding/collapsing it doesn't lose progress or reset the current card.
3. **Tap name to edit at Final Review** — the existing read-only `WeeklyScheduleGrid` rendered at the mobile Final Review step gets one new optional prop, `onEmployeeClick(employeeId)`. When provided (mobile Final Review only — the plain `view`-mode call site omits it, so that usage is visually/behaviorally unchanged), each employee name renders as a tappable button. Tapping it reopens that one employee's `EmployeeScheduleCard` in edit mode, pre-filled with their currently-approved shifts; Save merges the change back into `approvedCards` in place, returning to Final Review — no need to re-walk every other employee's card again.

## Data Flow

No new Paycor actions and no schema changes. Reassignment (desktop dropdown or mobile picker) is pure local state — it changes which `cards` (desktop) or `approvedCards` (mobile) entry a shift object lives under. The existing `handleSendToPaycor` already builds its batched `createSchedulingShifts` payload by walking whichever list it's given and reading each shift's owning employee, so it needs no changes on either path.

## Roles & Permissions

Unchanged from the original spec — only `manager` (own store) reaches `mode === 'build'` at all; DM/Exec/IT/Office Staff stay on the existing read-only `view` mode regardless of device.

## Error Handling

- **Paste with nothing pending**: Paste button simply doesn't render on empty cells until something is copied/cut — no error state needed.
- **Reassign target list is empty** (e.g. a single-employee store): the Re-assign dropdown / mobile picker shows a "no other employees this week" state instead of an empty/broken control.
- **Everything else** (partial batch failure, missing pay rate, no prior week found) is unchanged from the original spec — both paths funnel into the same `handleSendToPaycor` and inherit its existing handling.

## Testing Plan

1. Resize a desktop browser across the 1024px breakpoint (and a real Chromebook) to confirm the grid/card split triggers correctly and cleanly (no layout break mid-resize).
2. Desktop grid: hover reveal, Edit popover (time change, re-assign, delete), Copy→Paste (duplicate persists for repeated pastes), Cut→Paste (moves, clears after one paste), Escape clears a pending clipboard item.
3. Mobile: reassign a shift from one employee's edit view onto another employee, confirm it disappears from the source and appears on the target; tap a name at Final Review, edit, Save, confirm the change reflects in the grid without disturbing other employees' already-approved shifts.
4. End-to-end: build one real schedule through each path (desktop and mobile) for the same test store/week, submit, verify both produce an identical result in Paycor's own UI.
