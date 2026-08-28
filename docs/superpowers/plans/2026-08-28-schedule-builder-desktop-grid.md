# Schedule Builder Desktop Grid + Mobile Reassign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Schedule Builder a directly-editable, Paycor-styled weekly grid on desktop/Chromebook, and add shift reassignment, a live build-so-far preview, and tap-to-edit-at-review to the existing mobile card flow.

**Architecture:** A `useIsDesktopViewport()` hook picks, per render, between a new `EditableScheduleGrid` component (desktop) and the existing `EmployeeScheduleCard` stack (mobile) inside `ScheduleBuilder`'s `mode === 'build'` branch. A new pure module, `src/schedule-grid.mjs`, holds the two list-mutation primitives (`removeShiftFromEmployee`, `addShiftToEmployee`) that both paths compose to move a shift between employees — reassign, cut→paste, and copy→paste are all built from the same two functions. The existing read-only `WeeklyScheduleGrid` and `RunningLaborHeader` are reused as-is; `WeeklyScheduleGrid` gains one optional prop.

**Tech Stack:** React (via esbuild bundle of `app.jsx`), plain ES modules under `src/`, Node's built-in test runner (`node --test`, already wired into `npm test` via the `src/*.test.mjs` glob in `package.json`).

**Spec:** `docs/superpowers/specs/2026-08-28-schedule-builder-desktop-grid-design.md`

## Global Constraints

- No backend or schema changes — every task in this plan touches only `app.jsx` and new files under `src/`.
- Desktop breakpoint is a viewport width of **1024px** (`window.matchMedia('(min-width: 1024px)')`).
- "Move to open shift" is explicitly **out of scope** for this plan (see spec) — the Edit popover offers Delete only, not a way to unassign-without-deleting.
- Every shift is matched by object **reference** (`===`), never by value (`dayOffset`/`startTime`/`endTime` equality) — two employees could otherwise have visually identical shifts that a value-match would confuse.
- Reuse existing helpers rather than re-implementing them: `SCHEDULE_DOW` (`app.jsx:32466`), `scheduleFormat12h` (`app.jsx:32326`), `scheduleComputeWeeklyTotal` (`app.jsx:32423`), `RunningLaborHeader` (`app.jsx:32563`), `WeeklyScheduleGrid` (`app.jsx:32472`), `handleSendToPaycor` (inside `ScheduleBuilder`, `app.jsx:32805`).
- This repo has **no automated test harness for React rendering** (no jsdom/testing-library in `package.json`) — that's an established fact of this codebase, not a gap to fix here. Pure logic (the `src/schedule-grid.mjs` module) gets real `node --test` unit tests, matching the existing pattern (`src/pulse-comparison.mjs` + `src/pulse-comparison.test.mjs`, etc.). Every other step's "testing" is: `npm run build`, `npx netlify deploy` (preview, not `--prod`), then manually verify in a resized browser window (desktop path) or a real/emulated phone (mobile path).
- Bump the `APP_VERSION` constant in `app.jsx` (currently `const APP_VERSION = "v20.25";` at `app.jsx:26143` — confirm the exact current value before each bump, since earlier tasks in this plan will have already moved it) once per task that touches `app.jsx`, per this project's CLAUDE.md convention.
- Never `git push` (which deploys straight to production on this Netlify-Git-linked site) without the user's explicit go-ahead for that specific push — `npx netlify deploy` (no `--prod`) preview deploys are the expected default after each task.

---

### Task 1: Pure shift-move helpers (`src/schedule-grid.mjs`)

**Files:**
- Create: `src/schedule-grid.mjs`
- Create: `src/schedule-grid.test.mjs`

**Interfaces:**
- Produces: `removeShiftFromEmployee(list, employeeId, shift) -> newList`, `addShiftToEmployee(list, employeeId, shift) -> newList`. `list` is an array of `{ employeeId, shifts: [...], ...otherFields }`; both functions return a new array (never mutate the input) and are a no-op passthrough of `list` when `employeeId` isn't found. Every later task composes these two to implement reassign/cut/copy/paste — no task after this one re-implements list mutation directly.

- [ ] **Step 1: Write the failing tests**

Create `src/schedule-grid.test.mjs`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { removeShiftFromEmployee, addShiftToEmployee } from './schedule-grid.mjs';

const shift = { dayOffset: 1, startTime: '09:00', endTime: '17:00' };
function makeList() {
  return [
    { employeeId: 'a', shifts: [shift] },
    { employeeId: 'b', shifts: [] },
  ];
}

describe('removeShiftFromEmployee', () => {
  test('removes the exact shift instance from the matching employee', () => {
    const result = removeShiftFromEmployee(makeList(), 'a', shift);
    assert.deepStrictEqual(result.find(c => c.employeeId === 'a').shifts, []);
  });
  test('leaves other employees untouched (same object reference)', () => {
    const list = makeList();
    const result = removeShiftFromEmployee(list, 'a', shift);
    assert.strictEqual(result.find(c => c.employeeId === 'b'), list[1]);
  });
  test('is a no-op when the employeeId is not present', () => {
    const list = makeList();
    const result = removeShiftFromEmployee(list, 'nobody', shift);
    assert.deepStrictEqual(result, list);
  });
  test('a value-equal but different-instance shift is not removed', () => {
    const lookalike = { dayOffset: 1, startTime: '09:00', endTime: '17:00' };
    const result = removeShiftFromEmployee(makeList(), 'a', lookalike);
    assert.strictEqual(result.find(c => c.employeeId === 'a').shifts.length, 1);
  });
  test('does not mutate the input list', () => {
    const list = makeList();
    removeShiftFromEmployee(list, 'a', shift);
    assert.strictEqual(list[0].shifts.length, 1);
  });
});

describe('addShiftToEmployee', () => {
  test('appends the shift to the matching employee', () => {
    const result = addShiftToEmployee(makeList(), 'b', shift);
    assert.deepStrictEqual(result.find(c => c.employeeId === 'b').shifts, [shift]);
  });
  test('is a no-op when the employeeId is not present', () => {
    const list = makeList();
    const result = addShiftToEmployee(list, 'nobody', shift);
    assert.deepStrictEqual(result, list);
  });
  test('does not mutate the input list', () => {
    const list = makeList();
    addShiftToEmployee(list, 'b', shift);
    assert.strictEqual(list[1].shifts.length, 0);
  });
});

describe('composing a reassign from the two primitives', () => {
  test('moves a shift from one employee to another', () => {
    const moved = addShiftToEmployee(removeShiftFromEmployee(makeList(), 'a', shift), 'b', shift);
    assert.deepStrictEqual(moved.find(c => c.employeeId === 'a').shifts, []);
    assert.deepStrictEqual(moved.find(c => c.employeeId === 'b').shifts, [shift]);
  });
  test('moving within the same employee to a new day works via remove-then-add', () => {
    const newShift = { ...shift, dayOffset: 3 };
    const moved = addShiftToEmployee(removeShiftFromEmployee(makeList(), 'a', shift), 'a', newShift);
    assert.deepStrictEqual(moved.find(c => c.employeeId === 'a').shifts, [newShift]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './schedule-grid.mjs'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/schedule-grid.mjs`:

```js
// Pure list-mutation helpers for moving a shift between employees' shift
// lists. Shared by the desktop editable grid (Edit popover's Re-assign
// dropdown, Cut/Copy/Paste) and the mobile card flow's "reassign to a
// different employee" action — every higher-level move is these two
// functions composed (remove from source, add to target).
//
// List shape: [{ employeeId, shifts: [{ dayOffset, startTime, endTime }], ...other fields }]
// `shift` is always matched by object reference (===), never by value —
// callers must pass the exact instance being acted on.

export function removeShiftFromEmployee(list, employeeId, shift) {
  return list.map(c => c.employeeId === employeeId
    ? { ...c, shifts: c.shifts.filter(s => s !== shift) }
    : c);
}

export function addShiftToEmployee(list, employeeId, shift) {
  return list.map(c => c.employeeId === employeeId
    ? { ...c, shifts: [...c.shifts, shift] }
    : c);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all `schedule-grid.test.mjs` cases green (this also re-runs every other existing `src/*.test.mjs` file via the same glob; confirm nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add src/schedule-grid.mjs src/schedule-grid.test.mjs
git commit -m "Add pure shift-move helpers for schedule builder reassign/cut/copy/paste"
```

---

### Task 2: Desktop/mobile split — `useIsDesktopViewport` + `EditableScheduleGrid` (structure) + Send to Paycor

**Files:**
- Modify: `app.jsx:1-10` (imports)
- Modify: `app.jsx` near `32466` (add hook before `WeeklyScheduleGrid`)
- Modify: `app.jsx` near `32557` (add new `EditableScheduleGrid` component after `WeeklyScheduleGrid`)
- Modify: `app.jsx:32909-32973` (`ScheduleBuilder`'s `mode === 'build'` render)
- Modify: `app.jsx:26143` (`APP_VERSION` bump)

**Interfaces:**
- Consumes: `SCHEDULE_DOW`, `scheduleFormat12h`, `scheduleComputeWeeklyTotal`, `RunningLaborHeader`, `handleSendToPaycor` (all pre-existing, unchanged signatures).
- Produces: `useIsDesktopViewport() -> boolean`. `EditableScheduleGrid({ weekStartISO, cards, onCardsChange, th, openShiftGroups })` — later tasks (3, 4) add interactivity to this component's cells; this task only needs it to render every employee (including ones with zero shifts, unlike the read-only grid which filters those out) and to be wired into `ScheduleBuilder` so the desktop path can load, view, and submit a schedule end-to-end even before hover-editing exists.

- [ ] **Step 1: Add the `useIsDesktopViewport` hook**

In `app.jsx`, immediately before `const SCHEDULE_DOW = ...` (`app.jsx:32466`), add:

```jsx
const SCHEDULE_DESKTOP_BREAKPOINT = 1024;

// Picks the Schedule Builder's editing surface by viewport width, live —
// the same manager sees the grid on a store Chromebook and the card stack
// on their phone, with no separate setting to maintain.
function useIsDesktopViewport() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth >= SCHEDULE_DESKTOP_BREAKPOINT : true
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(`(min-width: ${SCHEDULE_DESKTOP_BREAKPOINT}px)`);
    const onChange = (e) => setIsDesktop(e.matches);
    setIsDesktop(mql.matches);
    if (mql.addEventListener) mql.addEventListener('change', onChange); else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange); else mql.removeListener(onChange);
    };
  }, []);
  return isDesktop;
}
```

- [ ] **Step 2: Add the `EditableScheduleGrid` component (structure only)**

Immediately after `WeeklyScheduleGrid`'s closing brace (`app.jsx:32557`), add:

```jsx
// Directly-editable version of WeeklyScheduleGrid's visual shape, used only
// at desktop/Chromebook widths (see useIsDesktopViewport). Unlike
// WeeklyScheduleGrid (pure rendering, no edit state), this component owns
// hover-driven Edit/Copy/Cut/Paste (Tasks 3-4) and reports every change back
// to the parent via onCardsChange — ScheduleBuilder still owns `cards`.
// Shows every employee, including ones with zero shifts (an empty row to
// build into), unlike the read-only grid which filters those out.
function EditableScheduleGrid({ weekStartISO, cards, onCardsChange, th, openShiftGroups }) {
  const weekStart = new Date(weekStartISO + 'T00:00:00Z');
  const dayDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '0.5rem', borderBottom: `2px solid ${th.cardBorder}`, color: th.muted, position: 'sticky', left: 0, background: th.bg }}>Employee</th>
            {dayDates.map((d, i) => (
              <th key={i} style={{ textAlign: 'center', padding: '0.5rem', borderBottom: `2px solid ${th.cardBorder}`, color: th.muted, minWidth: 150 }}>
                {SCHEDULE_DOW[i]}, {d.getUTCMonth() + 1}/{d.getUTCDate()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cards.map(card => {
            const totalHours = (card.shifts || []).reduce((sum, sh) => {
              const [sh1, sm1] = sh.startTime.split(':').map(Number);
              const [sh2, sm2] = sh.endTime.split(':').map(Number);
              let mins = (sh2 * 60 + sm2) - (sh1 * 60 + sm1);
              if (mins < 0) mins += 1440;
              return sum + mins / 60;
            }, 0);
            return (
              <tr key={card.employeeId} style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                <td style={{ padding: '0.5rem', color: th.text, fontWeight: 600, position: 'sticky', left: 0, background: th.bg }}>
                  {card.employeeName}
                  <div style={{ fontSize: '0.68rem', color: th.muted, fontWeight: 400 }}>{Math.round(totalHours * 10) / 10}h</div>
                </td>
                {dayDates.map((_, dayOffset) => {
                  const shift = (card.shifts || []).find(sh => sh.dayOffset === dayOffset);
                  return (
                    <td key={dayOffset} style={{ padding: '0.35rem', textAlign: 'center', position: 'relative' }}>
                      {shift && (
                        <div style={{ background: '#FF671F18', border: '1px solid #FF671F55', borderRadius: 6, padding: '0.3rem 0.4rem', color: th.text }}>
                          {scheduleFormat12h(shift.startTime)}–{scheduleFormat12h(shift.endTime)}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {(openShiftGroups || []).map(og => (
            <tr key={'open-' + og.jobTitle} style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
              <td style={{ padding: '0.5rem', color: th.muted, fontWeight: 600, fontStyle: 'italic', position: 'sticky', left: 0, background: th.bg }}>
                Open — {og.jobTitle}
              </td>
              {dayDates.map((_, dayOffset) => {
                const shift = (og.shifts || []).find(sh => sh.dayOffset === dayOffset);
                return (
                  <td key={dayOffset} style={{ padding: '0.35rem', textAlign: 'center' }}>
                    {shift && (
                      <div style={{ background: '#94a3b81a', border: '1px dashed #94a3b8aa', borderRadius: 6, padding: '0.3rem 0.4rem', color: th.muted }}>
                        {scheduleFormat12h(shift.startTime)}–{scheduleFormat12h(shift.endTime)}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Wire the device split into `ScheduleBuilder`**

In `app.jsx`, replace the `mode === 'build'` return block (`app.jsx:32909-32973`, everything from `return (` down to its matching closing `);` right before the `LaborDrillDown` section comment) with:

```jsx
  const isDesktop = useIsDesktopViewport();

  return (
    <div>
      {!cards && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', marginBottom: '0.35rem' }}>Week start (Sunday)</div>
          <input type="date" value={weekStart} onChange={e => setWeekStart(e.target.value)} style={{ ...inp(th), width: 200 }} />
          <button onClick={load} disabled={!weekStart || loading} style={{ ...btn(th), marginLeft: '0.6rem', opacity: (!weekStart || loading) ? 0.6 : 1 }}>{loading ? 'Loading…' : 'Start building'}</button>
        </div>
      )}
      {error && <div style={{ color: '#ef4444', fontSize: '0.82rem', marginBottom: '1rem' }}>{error}</div>}

      {cards && isDesktop && (() => {
        const desktopTotal = scheduleComputeWeeklyTotal(cards, payRates);
        const allSent = submitResult && !submitResult.running && submitResult.results.length > 0 && submitResult.results.every(r => r.status === 'ok');
        return (
          <>
            <RunningLaborHeader weeklyTotal={desktopTotal} projectedSales={0} th={th} />
            <EditableScheduleGrid weekStartISO={weekStart} cards={cards} onCardsChange={setCards} th={th} openShiftGroups={openShiftGroups} />
            <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem' }}>
              <button onClick={async () => {
                const text = scheduleBuildShareText(weekStart, cards);
                if (navigator.share) { try { await navigator.share({ text }); } catch (e) { /* user cancelled — not an error */ } }
                else { await navigator.clipboard.writeText(text); alert('Copied to clipboard'); }
              }} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>
                {typeof navigator !== 'undefined' && navigator.share ? 'Share' : 'Copy'}
              </button>
              <button onClick={() => { setApprovedCards(cards.filter(c => (c.shifts || []).length > 0)); handleSendToPaycor(); }} disabled={submitResult?.running || allSent} style={{ ...btn(th, { background: '#FF671F' }), opacity: (submitResult?.running || allSent) ? 0.6 : 1 }}>
                {submitResult?.running ? 'Sending…' : allSent ? 'Sent' : 'Send to Paycor'}
              </button>
            </div>
            {submitResult && !submitResult.running && (
              <div style={{ marginTop: '1rem' }}>
                {submitResult.results.map((r, i) => (
                  <div key={i} style={{ fontSize: '0.78rem', color: r.status === 'ok' ? '#16a34a' : '#ef4444', marginBottom: '0.3rem' }}>
                    <strong>{r.employeeName}:</strong> {r.detail}
                  </div>
                ))}
              </div>
            )}
          </>
        );
      })()}

      {cards && !isDesktop && !allCardsDone && (
        <>
          <RunningLaborHeader weeklyTotal={weeklyTotal} projectedSales={0} th={th} />
          <div style={{ fontSize: '0.78rem', color: th.muted, marginBottom: '0.6rem' }}>Employee {cardIndex + 1} of {cards.length}</div>
          <EmployeeScheduleCard card={currentCard} th={th} onApprove={handleApprove} onSave={handleSave} />
        </>
      )}

      {cards && !isDesktop && allCardsDone && (
        <>
          <RunningLaborHeader weeklyTotal={weeklyTotal} projectedSales={0} th={th} />
          <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text, margin: '1rem 0 0.6rem' }}>Final review</div>
          <WeeklyScheduleGrid weekStartISO={weekStart} cards={approvedCards.filter(c => (c.shifts || []).length > 0)} th={th} openShiftGroups={openShiftGroups} />
          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem' }}>
            <button onClick={async () => {
              const text = scheduleBuildShareText(weekStart, approvedCards);
              if (navigator.share) {
                try { await navigator.share({ text }); } catch (e) { /* user cancelled share — not an error */ }
              } else {
                await navigator.clipboard.writeText(text);
                alert('Copied to clipboard');
              }
            }} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>
              {typeof navigator !== 'undefined' && navigator.share ? 'Share' : 'Copy'}
            </button>
            {(() => {
              const allSent = submitResult && !submitResult.running && submitResult.results.length > 0 && submitResult.results.every(r => r.status === 'ok');
              return (
                <button onClick={handleSendToPaycor} disabled={submitResult?.running || allSent} style={{ ...btn(th, { background: '#FF671F' }), opacity: (submitResult?.running || allSent) ? 0.6 : 1 }}>
                  {submitResult?.running ? 'Sending…' : allSent ? 'Sent' : 'Send to Paycor'}
                </button>
              );
            })()}
          </div>
          {submitResult && !submitResult.running && (
            <div style={{ marginTop: '1rem' }}>
              {submitResult.results.map((r, i) => (
                <div key={i} style={{ fontSize: '0.78rem', color: r.status === 'ok' ? '#16a34a' : '#ef4444', marginBottom: '0.3rem' }}>
                  <strong>{r.employeeName}:</strong> {r.detail}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

Note: the desktop "Send to Paycor" button first sets `approvedCards` to every card with at least one shift (so `handleSendToPaycor`'s existing `cardsToSend = approvedCards.filter(...)` picks them up unchanged) and then calls the existing `handleSendToPaycor` — no changes to that function itself.

- [ ] **Step 4: Bump `APP_VERSION`, build, deploy preview**

In `app.jsx`, find the current `const APP_VERSION = "v20.25";` line and increment it (e.g. to `"v20.26"` — confirm the actual current value first, since this is the first app.jsx-touching task in this plan).

Run: `npm run build`
Expected: `esbuild` reports success, `app.js` regenerated.

Run: `npx netlify deploy` (no `--prod`)
Expected: draft URL printed.

- [ ] **Step 5: Manually verify**

On the draft URL, open Schedule → Build for a test store/week:
- At a browser width ≥1024px: confirm the new grid renders (every active employee as a row, Sun–Sat columns, pre-filled shifts from last week where available), the labor header shows a live total, and "Send to Paycor" is present (do not actually click it against real payroll unless intentionally testing a real send).
- Resize the same window below 1024px: confirm it switches to the existing one-employee-at-a-time card flow with no console errors.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js
git commit -m "Add desktop editable schedule grid (structure) behind a viewport-width split"
```

---

### Task 3: Desktop grid — Copy / Cut / Paste

**Files:**
- Modify: `app.jsx` — `EditableScheduleGrid` (added in Task 2)
- Modify: `app.jsx:1-10` (add import from `src/schedule-grid.mjs`)
- Modify: `APP_VERSION`

**Interfaces:**
- Consumes: `removeShiftFromEmployee`, `addShiftToEmployee` (Task 1).
- Produces: no new exported interface — this task is purely internal to `EditableScheduleGrid`'s rendering/interaction.

- [ ] **Step 1: Import the pure helpers**

Near the top of `app.jsx`, alongside the other `./src/*.mjs` imports (after the `pulse-comparison.mjs` import line), add:

```jsx
import { removeShiftFromEmployee, addShiftToEmployee } from './src/schedule-grid.mjs';
```

- [ ] **Step 2: Add hover state, clipboard state, and Copy/Cut/Paste to `EditableScheduleGrid`**

Inside `EditableScheduleGrid`, right after the `const dayDates = ...` block, add:

```jsx
  const [hoveredCell, setHoveredCell] = useState(null); // { employeeId, dayOffset } | null
  const [clipboard, setClipboard] = useState(null); // { shift, sourceEmployeeId, mode: 'copy' | 'cut' } | null

  useEffect(() => {
    const onKeyDown = (e) => { if (e.key === 'Escape') setClipboard(null); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleCopy = (employeeId, shift) => setClipboard({ shift, sourceEmployeeId: employeeId, mode: 'copy' });
  const handleCut = (employeeId, shift) => {
    onCardsChange(removeShiftFromEmployee(cards, employeeId, shift));
    setClipboard({ shift, sourceEmployeeId: employeeId, mode: 'cut' });
  };
  const handlePaste = (targetEmployeeId, targetDayOffset) => {
    if (!clipboard) return;
    const pasted = { ...clipboard.shift, dayOffset: targetDayOffset };
    onCardsChange(addShiftToEmployee(cards, targetEmployeeId, pasted));
    if (clipboard.mode === 'cut') setClipboard(null); // move semantics: one-shot
    // copy semantics: clipboard stays, pasteable again elsewhere
  };
```

- [ ] **Step 3: Wire hover + Copy/Cut icons onto each shift block, and Paste onto empty cells**

Replace the per-day `<td>` block inside the `cards.map(card => ...)` row (the block rendering `shift && (...)`) with:

```jsx
                {dayDates.map((_, dayOffset) => {
                  const shift = (card.shifts || []).find(sh => sh.dayOffset === dayOffset);
                  const isHovered = hoveredCell && hoveredCell.employeeId === card.employeeId && hoveredCell.dayOffset === dayOffset;
                  return (
                    <td key={dayOffset} style={{ padding: '0.35rem', textAlign: 'center', position: 'relative' }}
                        onMouseEnter={() => setHoveredCell({ employeeId: card.employeeId, dayOffset })}
                        onMouseLeave={() => setHoveredCell(null)}>
                      {shift && (
                        <div style={{ background: '#FF671F18', border: '1px solid #FF671F55', borderRadius: 6, padding: '0.3rem 0.4rem', color: th.text, position: 'relative' }}>
                          {scheduleFormat12h(shift.startTime)}–{scheduleFormat12h(shift.endTime)}
                          {isHovered && (
                            <div style={{ display: 'flex', gap: '0.2rem', justifyContent: 'center', marginTop: '0.25rem' }}>
                              <button onClick={() => handleCopy(card.employeeId, shift)} title="Copy" style={{ ...btn(th, { background: th.card2, color: th.text }), fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>Copy</button>
                              <button onClick={() => handleCut(card.employeeId, shift)} title="Cut" style={{ ...btn(th, { background: th.card2, color: th.text }), fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>Cut</button>
                            </div>
                          )}
                        </div>
                      )}
                      {!shift && isHovered && clipboard && (
                        <button onClick={() => handlePaste(card.employeeId, dayOffset)} style={{ ...btn(th, { background: '#1B8F5C' }), fontSize: '0.68rem', padding: '0.2rem 0.5rem' }}>Paste</button>
                      )}
                    </td>
                  );
                })}
```

(The Edit button is added in Task 4, in the same hovered-shift-block toolbar as Copy/Cut.)

- [ ] **Step 4: Bump `APP_VERSION`, build, deploy preview**

Run: `npm run build` then `npx netlify deploy`.

- [ ] **Step 5: Manually verify**

On the draft URL, desktop width, with at least two employees having pre-filled shifts:
- Hover a shift block → Copy/Cut buttons appear.
- Click Copy on a Monday shift, hover an empty Wednesday cell for a *different* employee → Paste button appears; click it → the shift appears on that employee's Wednesday with the same time, and the original Monday shift is still there.
- Click Copy again elsewhere → confirm the first copy is still pasteable a second time until you copy/cut something new or press Escape.
- Click Cut on a shift, paste it onto an empty cell → confirm it disappears from the source and appears at the destination, and the Paste button no longer appears anywhere afterward (clipboard cleared).
- Press Escape after a Copy → confirm hovering an empty cell no longer offers Paste.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js
git commit -m "Add desktop grid Copy/Cut/Paste for shifts"
```

---

### Task 4: Desktop grid — Edit popover (time, delete, re-assign)

**Files:**
- Modify: `app.jsx` — `EditableScheduleGrid`
- Modify: `APP_VERSION`

**Interfaces:**
- Consumes: `removeShiftFromEmployee`, `addShiftToEmployee` (Task 1), `cards`/`onCardsChange` (Task 2).

- [ ] **Step 1: Add popover state and handlers**

Inside `EditableScheduleGrid`, alongside the `clipboard` state added in Task 3, add:

```jsx
  const [editingShift, setEditingShift] = useState(null); // { employeeId, shift } | null
  const [editDraft, setEditDraft] = useState({ startTime: '', endTime: '', reassignTo: '' });

  const openEdit = (employeeId, shift) => {
    setEditingShift({ employeeId, shift });
    setEditDraft({ startTime: shift.startTime, endTime: shift.endTime, reassignTo: '' });
  };
  const closeEdit = () => setEditingShift(null);
  const saveEdit = () => {
    const { employeeId, shift } = editingShift;
    const targetEmployeeId = editDraft.reassignTo || employeeId;
    const updatedShift = { ...shift, startTime: editDraft.startTime, endTime: editDraft.endTime };
    let next = removeShiftFromEmployee(cards, employeeId, shift);
    next = addShiftToEmployee(next, targetEmployeeId, updatedShift);
    onCardsChange(next);
    closeEdit();
  };
  const deleteEdit = () => {
    onCardsChange(removeShiftFromEmployee(cards, editingShift.employeeId, editingShift.shift));
    closeEdit();
  };
```

- [ ] **Step 2: Add the Edit button to the hovered-shift toolbar**

In the toolbar `<div>` added in Task 3 (Step 3), add an Edit button before Copy:

```jsx
                          {isHovered && (
                            <div style={{ display: 'flex', gap: '0.2rem', justifyContent: 'center', marginTop: '0.25rem' }}>
                              <button onClick={() => openEdit(card.employeeId, shift)} title="Edit" style={{ ...btn(th, { background: th.card2, color: th.text }), fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>Edit</button>
                              <button onClick={() => handleCopy(card.employeeId, shift)} title="Copy" style={{ ...btn(th, { background: th.card2, color: th.text }), fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>Copy</button>
                              <button onClick={() => handleCut(card.employeeId, shift)} title="Cut" style={{ ...btn(th, { background: th.card2, color: th.text }), fontSize: '0.65rem', padding: '0.1rem 0.35rem' }}>Cut</button>
                            </div>
                          )}
```

- [ ] **Step 3: Render the popover**

At the end of `EditableScheduleGrid`'s returned JSX (as a sibling of the outer `<div style={{ overflowX: 'auto' }}>`, i.e. wrap the existing return in a fragment), add:

```jsx
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        {/* ...existing table from Tasks 2-3, unchanged... */}
      </div>
      {editingShift && (
        <div style={{ position: 'fixed', inset: 0, background: '#00000055', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={closeEdit}>
          <div style={{ background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 10, padding: '1.1rem', minWidth: 280 }} onClick={e => e.stopPropagation()}>
            <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.95rem', color: th.text, marginBottom: '0.8rem' }}>Edit shift</div>
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
              <input type="time" value={editDraft.startTime} onChange={e => setEditDraft(d => ({ ...d, startTime: e.target.value }))} style={{ ...inp(th), fontSize: '0.8rem' }} />
              <input type="time" value={editDraft.endTime} onChange={e => setEditDraft(d => ({ ...d, endTime: e.target.value }))} style={{ ...inp(th), fontSize: '0.8rem' }} />
            </div>
            <select value={editDraft.reassignTo} onChange={e => setEditDraft(d => ({ ...d, reassignTo: e.target.value }))} style={{ ...inp(th), fontSize: '0.8rem', width: '100%', marginBottom: '0.8rem' }}>
              <option value="">Keep on {cards.find(c => c.employeeId === editingShift.employeeId)?.employeeName}</option>
              {cards.filter(c => c.employeeId !== editingShift.employeeId).map(c => (
                <option key={c.employeeId} value={c.employeeId}>Re-assign to {c.employeeName}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={saveEdit} style={{ ...btn(th, { background: '#1B8F5C' }) }}>Save</button>
              <button onClick={deleteEdit} style={{ ...btn(th, { background: '#ef444422', color: '#ef4444' }) }}>Delete</button>
              <button onClick={closeEdit} style={{ ...btn(th, { background: th.card2, color: th.text }) }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
```

- [ ] **Step 4: Bump `APP_VERSION`, build, deploy preview**

Run: `npm run build` then `npx netlify deploy`.

- [ ] **Step 5: Manually verify**

On the draft URL, desktop width:
- Hover a shift, click Edit → popover opens with the shift's current time.
- Change the time, Save → block updates in place.
- Open Edit again, pick "Re-assign to <other employee>", Save → the shift disappears from the original employee's row and appears on the target's row on the same day.
- Open Edit, click Delete → shift disappears entirely.
- Open Edit, click Cancel (or click the dark backdrop) → popover closes with no change.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js
git commit -m "Add desktop grid Edit popover (time, delete, re-assign)"
```

---

### Task 5: Mobile — reassign a shift to a different employee

**Files:**
- Modify: `app.jsx` — `EmployeeScheduleCard` (Sun–Sat edit rows, shipped 2026-08-06)
- Modify: `app.jsx` — `ScheduleBuilder` (new `handleReassign`, new props passed to `EmployeeScheduleCard`)
- Modify: `APP_VERSION`

**Interfaces:**
- Consumes: `removeShiftFromEmployee`, `addShiftToEmployee` (Task 1).
- Produces: `EmployeeScheduleCard` gains two new props, `otherEmployees` (array of `{ employeeId, employeeName }`, default `[]`) and `onReassign` (`(shift, toEmployeeId) => void`, optional). `ScheduleBuilder` gains `handleReassign(fromEmployeeId, shift, toEmployeeId)`.

- [ ] **Step 1: Add `handleReassign` to `ScheduleBuilder`**

In `ScheduleBuilder`, right after the existing `handleSave` function (`app.jsx:32800-32803`), add:

```jsx
  const handleReassign = (fromEmployeeId, shift, toEmployeeId) => {
    setCards(prev => addShiftToEmployee(removeShiftFromEmployee(prev, fromEmployeeId, shift), toEmployeeId, shift));
    setApprovedCards(prev => addShiftToEmployee(removeShiftFromEmployee(prev, fromEmployeeId, shift), toEmployeeId, shift));
  };
```

(This targets whichever of `cards`/`approvedCards` currently holds the target employee — a no-op on the list that doesn't, per `schedule-grid.mjs`'s contract — so it's correct whether the target has already been approved or hasn't been reached yet in the walk.)

- [ ] **Step 2: Pass the new props from `ScheduleBuilder` to `EmployeeScheduleCard`**

In the `!isDesktop && !allCardsDone` branch added in Task 2, change:

```jsx
          <EmployeeScheduleCard card={currentCard} th={th} onApprove={handleApprove} onSave={handleSave} />
```

to:

```jsx
          <EmployeeScheduleCard
            card={currentCard} th={th} onApprove={handleApprove} onSave={handleSave}
            otherEmployees={cards.filter(c => c.employeeId !== currentCard.employeeId).map(c => ({ employeeId: c.employeeId, employeeName: c.employeeName }))}
            onReassign={(shift, toEmployeeId) => handleReassign(currentCard.employeeId, shift, toEmployeeId)}
          />
```

- [ ] **Step 3: Accept the new props in `EmployeeScheduleCard` and add a "⇄" control per shift row**

Change the function signature (`app.jsx:32592`):

```jsx
function EmployeeScheduleCard({ card: cardData, th, onApprove, onSave, otherEmployees = [], onReassign, startInEdit = false }) {
  const [editing, setEditing] = useState(startInEdit);
```

(`startInEdit` is added here too, since Task 7 needs it — harmless default-false addition now.)

Inside the `editing` block's per-day loop (the Sun–Sat rows shipped 2026-08-06), where each existing shift renders its time inputs and ✕ button, add a reassign control. Replace:

```jsx
                {dayShifts.map(({ s, i }) => (
                  <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.3rem' }}>
                    <input type="time" value={s.startTime} onChange={e => updateShift(i, 'startTime', e.target.value)} style={{ ...inp(th), fontSize: '0.75rem', padding: '0.25rem' }} />
                    <input type="time" value={s.endTime} onChange={e => updateShift(i, 'endTime', e.target.value)} style={{ ...inp(th), fontSize: '0.75rem', padding: '0.25rem' }} />
                    <button onClick={() => removeShift(i)} style={{ ...btn(th, { background: '#ef444422', color: '#ef4444' }), padding: '0.25rem 0.5rem' }}>✕</button>
                  </div>
                ))}
```

with:

```jsx
                {dayShifts.map(({ s, i }) => (
                  <div key={i} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.3rem', flexWrap: 'wrap' }}>
                    <input type="time" value={s.startTime} onChange={e => updateShift(i, 'startTime', e.target.value)} style={{ ...inp(th), fontSize: '0.75rem', padding: '0.25rem' }} />
                    <input type="time" value={s.endTime} onChange={e => updateShift(i, 'endTime', e.target.value)} style={{ ...inp(th), fontSize: '0.75rem', padding: '0.25rem' }} />
                    {otherEmployees.length > 0 && onReassign && (
                      <select defaultValue="" onChange={e => {
                        if (!e.target.value) return;
                        onReassign(s, e.target.value);
                        removeShift(i);
                        e.target.value = '';
                      }} style={{ ...inp(th), fontSize: '0.7rem', padding: '0.2rem' }}>
                        <option value="" disabled>⇄ Move to...</option>
                        {otherEmployees.map(o => <option key={o.employeeId} value={o.employeeId}>{o.employeeName}</option>)}
                      </select>
                    )}
                    <button onClick={() => removeShift(i)} style={{ ...btn(th, { background: '#ef444422', color: '#ef4444' }), padding: '0.25rem 0.5rem' }}>✕</button>
                  </div>
                ))}
```

(Picking a name calls `onReassign` — which adds the shift onto the target in `ScheduleBuilder`'s state — then immediately calls the existing local `removeShift(i)` so it also disappears from this card's own `draftShifts`, matching how the ✕ button already works.)

- [ ] **Step 4: Bump `APP_VERSION`, build, deploy preview**

Run: `npm run build` then `npx netlify deploy`.

- [ ] **Step 5: Manually verify**

On the draft URL, mobile width (or a resized/emulated phone), Build mode, with at least two employees in the roster:
- Open an employee's Edit view, add a shift on some day, use its "⇄ Move to..." picker to move it to another employee.
- Confirm the shift disappears from the current employee's Sun–Sat rows immediately.
- Continue through the card stack until reaching the target employee (or reopen them via Final Review, once Task 7 lands) — confirm the reassigned shift shows up on their card.
- With only one employee in the roster (or after excluding the current one leaves zero others), confirm no reassign control renders and nothing breaks.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js
git commit -m "Add mobile shift reassignment to a different employee"
```

---

### Task 6: Mobile — live "preview so far" during the build walk

**Files:**
- Modify: `app.jsx` — `ScheduleBuilder`'s `!isDesktop && !allCardsDone` branch
- Modify: `APP_VERSION`

**Interfaces:**
- Consumes: `WeeklyScheduleGrid` (existing, unchanged in this task), `approvedCards` (existing state).

- [ ] **Step 1: Add a collapsed-by-default preview toggle**

In `ScheduleBuilder`, add a new state variable alongside the others (near `submitResult`):

```jsx
  const [showBuildPreview, setShowBuildPreview] = useState(false);
```

- [ ] **Step 2: Render the toggle + preview panel in the mobile build branch**

In the `!isDesktop && !allCardsDone` branch (from Task 2), change:

```jsx
      {cards && !isDesktop && !allCardsDone && (
        <>
          <RunningLaborHeader weeklyTotal={weeklyTotal} projectedSales={0} th={th} />
          <div style={{ fontSize: '0.78rem', color: th.muted, marginBottom: '0.6rem' }}>Employee {cardIndex + 1} of {cards.length}</div>
          <EmployeeScheduleCard ... />
        </>
      )}
```

to:

```jsx
      {cards && !isDesktop && !allCardsDone && (
        <>
          <RunningLaborHeader weeklyTotal={weeklyTotal} projectedSales={0} th={th} />
          <div style={{ fontSize: '0.78rem', color: th.muted, marginBottom: '0.6rem' }}>Employee {cardIndex + 1} of {cards.length}</div>
          <button onClick={() => setShowBuildPreview(v => !v)} style={{ ...btn(th, { background: th.card2, color: th.text }), fontSize: '0.75rem', marginBottom: '0.8rem' }}>
            {showBuildPreview ? 'Hide preview' : 'Preview schedule so far'}
          </button>
          {showBuildPreview && (
            <div style={{ marginBottom: '1rem' }}>
              {approvedCards.filter(c => (c.shifts || []).length > 0).length === 0
                ? <div style={{ fontSize: '0.78rem', color: th.muted, fontStyle: 'italic' }}>No employees approved yet — the preview fills in as you go.</div>
                : <WeeklyScheduleGrid weekStartISO={weekStart} cards={approvedCards.filter(c => (c.shifts || []).length > 0)} th={th} openShiftGroups={[]} />
              }
            </div>
          )}
          <EmployeeScheduleCard
            card={currentCard} th={th} onApprove={handleApprove} onSave={handleSave}
            otherEmployees={cards.filter(c => c.employeeId !== currentCard.employeeId).map(c => ({ employeeId: c.employeeId, employeeName: c.employeeName }))}
            onReassign={(shift, toEmployeeId) => handleReassign(currentCard.employeeId, shift, toEmployeeId)}
          />
        </>
      )}
```

(`openShiftGroups={[]}` here — the build-so-far preview only needs to show what's been approved, not unassigned coverage, so it's kept out to avoid duplicating those rows across every card's preview toggle.)

- [ ] **Step 3: Bump `APP_VERSION`, build, deploy preview**

Run: `npm run build` then `npx netlify deploy`.

- [ ] **Step 4: Manually verify**

On the draft URL, mobile width, Build mode:
- Before approving anyone, tap "Preview schedule so far" → see the "No employees approved yet" message.
- Approve/Save one or two employees, open the preview again → confirm their shifts show in the grid.
- Toggle the preview open and closed a few times while stepping through cards → confirm the current card's in-progress edits are never lost and `cardIndex` doesn't change just from toggling.

- [ ] **Step 5: Commit**

```bash
git add app.jsx app.js
git commit -m "Add live build-so-far preview to mobile schedule builder walk"
```

---

### Task 7: Mobile — tap employee name to re-edit at Final Review

**Files:**
- Modify: `app.jsx` — `WeeklyScheduleGrid` (new optional prop)
- Modify: `app.jsx` — `ScheduleBuilder`'s `!isDesktop && allCardsDone` branch
- Modify: `APP_VERSION`

**Interfaces:**
- Consumes: `EmployeeScheduleCard`'s `startInEdit` prop (added in Task 5, Step 3).
- Produces: `WeeklyScheduleGrid` gains one new optional prop, `onEmployeeClick(employeeId)` — when omitted (as at every other call site: plain `view` mode, the desktop path, the Task 6 preview), rendering is unchanged from today.

- [ ] **Step 1: Add `onEmployeeClick` to `WeeklyScheduleGrid`**

Change the function signature (`app.jsx:32472`):

```jsx
function WeeklyScheduleGrid({ weekStartISO, cards, th, openShiftGroups, onEmployeeClick }) {
```

In the employee-row `<td>` (the one currently rendering `{card.employeeName}` directly, `app.jsx:32505-32508`), replace:

```jsx
                <td style={{ padding: '0.5rem', color: th.text, fontWeight: 600, position: 'sticky', left: 0, background: th.bg }}>
                  {card.employeeName}
                  <div style={{ fontSize: '0.68rem', color: th.muted, fontWeight: 400 }}>{Math.round(totalHours * 10) / 10}h</div>
                </td>
```

with:

```jsx
                <td style={{ padding: '0.5rem', color: th.text, fontWeight: 600, position: 'sticky', left: 0, background: th.bg }}>
                  {onEmployeeClick ? (
                    <button onClick={() => onEmployeeClick(card.employeeId)} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: th.text, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>
                      {card.employeeName}
                    </button>
                  ) : card.employeeName}
                  <div style={{ fontSize: '0.68rem', color: th.muted, fontWeight: 400 }}>{Math.round(totalHours * 10) / 10}h</div>
                </td>
```

- [ ] **Step 2: Add reopen state and a handler in `ScheduleBuilder`**

Alongside `showBuildPreview` (Task 6), add:

```jsx
  const [reopenEmployeeId, setReopenEmployeeId] = useState(null);
  const reopenCard = reopenEmployeeId ? approvedCards.find(c => c.employeeId === reopenEmployeeId) : null;
  const handleReopenSave = (updatedShifts) => {
    setApprovedCards(prev => prev.map(c => c.employeeId === reopenEmployeeId ? { ...c, shifts: updatedShifts } : c));
    setReopenEmployeeId(null);
  };
```

- [ ] **Step 3: Render the reopened card, or the grid with the click hook wired up**

In the `!isDesktop && allCardsDone` branch, replace:

```jsx
          <WeeklyScheduleGrid weekStartISO={weekStart} cards={approvedCards.filter(c => (c.shifts || []).length > 0)} th={th} openShiftGroups={openShiftGroups} />
```

with:

```jsx
          {reopenCard ? (
            <EmployeeScheduleCard
              card={reopenCard} th={th} startInEdit
              onApprove={() => setReopenEmployeeId(null)}
              onSave={handleReopenSave}
              otherEmployees={approvedCards.filter(c => c.employeeId !== reopenCard.employeeId).map(c => ({ employeeId: c.employeeId, employeeName: c.employeeName }))}
              onReassign={(shift, toEmployeeId) => handleReassign(reopenCard.employeeId, shift, toEmployeeId)}
            />
          ) : (
            <WeeklyScheduleGrid weekStartISO={weekStart} cards={approvedCards.filter(c => (c.shifts || []).length > 0)} th={th} openShiftGroups={openShiftGroups} onEmployeeClick={setReopenEmployeeId} />
          )}
```

- [ ] **Step 4: Bump `APP_VERSION`, build, deploy preview**

Run: `npm run build` then `npx netlify deploy`.

- [ ] **Step 5: Manually verify**

On the draft URL, mobile width, walk through Build mode to Final Review:
- Confirm every employee's name in the review grid is now underlined/tappable.
- Tap one → their card reopens directly in edit mode (not the Approve/Edit choice screen).
- Change a shift's time, hit "Save & Continue" (still labeled that from the existing component — acceptable, it still saves and returns) → back at Final Review, confirm the grid reflects the change and no other employee's shifts were disturbed.
- Reopen a card and use its "⇄ Move to..." picker to reassign a shift to another already-approved employee → confirm both employees' rows update correctly back at Final Review.

- [ ] **Step 6: Commit**

```bash
git add app.jsx app.js
git commit -m "Add tap-name-to-edit at mobile schedule builder Final Review"
```

---

## Self-Review Notes

- **Spec coverage:** device split (Task 2) — covered; desktop Edit/Copy/Cut/Paste (Tasks 3-4) — covered; "Move to open shift" explicitly deferred per spec — not implemented, matches spec; mobile reassign (Task 5) — covered; mobile live preview (Task 6, added mid-brainstorm) — covered; mobile tap-name-to-edit (Task 7) — covered; no backend changes anywhere — confirmed, no task touches `netlify/functions/`.
- **Type/signature consistency:** `EmployeeScheduleCard`'s `otherEmployees`/`onReassign`/`startInEdit` props are introduced once (Task 5) and used identically at both call sites that need them (Task 5's live-walk card, Task 7's reopened card). `handleReassign(fromEmployeeId, shift, toEmployeeId)`'s signature is fixed in Task 5 and reused unchanged in Task 7. `WeeklyScheduleGrid`'s new `onEmployeeClick` prop is introduced in Task 7 and is optional everywhere else (Task 2's mobile branches, Task 6's preview) — confirmed those call sites don't pass it and don't need to.
- **No placeholders:** every step has runnable code, not a description of what to write.
