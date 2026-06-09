# Pulse Daily/Week Toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Daily | Week toggle to the main Pulse grid so district and store tiles can show week-to-date (Sun→today) net sales and guests instead of just today's.

**Architecture:** All changes live in `AdminPulse` (`app.jsx`). A per-store WTD map (`weekStoreData`) is built lazily by summing the existing `fetchDate` per-day results across `getWeekDates(busDt)`. The grid's existing `allRows` seam (`{...s, live: storeData[s.pc]}`) is switched by `viewMode`, so every district rollup and store tile that reads `s.live.data` flips automatically.

**Tech Stack:** React 18 (inline-styled, CDN globals); Pulse POS via the existing `fetchDate`/`getWeekDates`/`aggResults` helpers in `AdminPulse`.

---

## Spec
`docs/superpowers/specs/2026-06-09-pulse-weekly-toggle-design.md`

## Verified anchors (all in `AdminPulse`, `app.jsx`)
- State block starts ~`app.jsx:8975` (`busDt`, `storeData`, `wtdLoading`, …). `G = '#00d084'` at 8972.
- `fetchDate(date, batchSize, onProg)` (9036) → `{ [pc]: { status:'ok'|'error', data:{netSales,guests,voids,discounts}, rcs } }`.
- `loadAll()` (9052) sets `storeData = fetchDate(busDt)` result (same shape as `fetchDate`).
- `getWeekDates(busDt)` (9014) → ISO dates Sun→today (no future).
- `activePCs` (8997) → active store PCs, DM-scoped.
- `allRows` (9218-9220): `stores.filter(...).map(s => ({ ...s, live: storeData[s.pc] }))` — drives district grouping + store tiles; tiles read `s.live.data.netSales` / `s.live.data.guests` (e.g. district rollup at 9506-9507).
- Controls row with Refresh (9358) and Auto-refresh (9366) buttons.
- Version footer `v14.52` at the sidebar footer (`app.jsx`, search `v14.52`).

> No unit tests: `AdminPulse` is live-API React UI; the repo unit-tests pure modules only. Each task ends with `npm run build` + a manual smoke note. Real browser smoke happens on preview/prod.

---

## Task 1: Data layer — state + `loadWeekGrid()`

**Files:** Modify `app.jsx` (`AdminPulse`)

- [ ] **Step 1: Add state** right after the `wtdLoading` state line (`app.jsx:8989`):

```javascript
  const [viewMode,     setViewMode]     = useState('day');   // 'day' | 'week' (WTD Sun→today)
  const [weekStoreData,setWeekStoreData]= useState({});      // pc → { netSales, guests, voids, discounts } (WTD sums)
  const [weekLoading,  setWeekLoading]  = useState(false);
  const [dayStoreCache,setDayStoreCache]= useState({});      // date → fetchDate() result (memoize per-day per-store)
```

- [ ] **Step 2: Add `loadWeekGrid()`** right after `loadWTD()` (after `app.jsx:9072`):

```javascript
  // Build per-store WTD (Sun→today) by summing each day's fetchDate results.
  async function loadWeekGrid() {
    setWeekLoading(true);
    const dates = getWeekDates(busDt);
    const cache = { ...dayStoreCache, [busDt]: storeData }; // today's slice already loaded
    for (const date of dates) {
      if (!cache[date]) cache[date] = await fetchDate(date, 8);
    }
    setDayStoreCache(cache);
    const sums = {};
    for (const pc of activePCs) {
      let netSales = 0, guests = 0, voids = 0, discounts = 0;
      for (const date of dates) {
        const r = cache[date] && cache[date][pc];
        if (r && r.status === 'ok') {
          netSales += r.data.netSales; guests += r.data.guests;
          voids += r.data.voids; discounts += r.data.discounts;
        }
      }
      sums[pc] = { netSales, guests, voids, discounts };
    }
    setWeekStoreData(sums);
    setWeekLoading(false);
  }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `npm run build`
Expected: esbuild completes, no errors.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(pulse): WTD data layer — viewMode state + loadWeekGrid per-store week sums"
```

---

## Task 2: Trigger — load WTD lazily when Week is selected / week changes

**Files:** Modify `app.jsx` (`AdminPulse`)

- [ ] **Step 1: Add a trigger effect** right after the auto-refresh effect (after `app.jsx:9145`, the `}, [autoRefresh, busDt]);` line):

```javascript
  // Lazily compute per-store WTD when Week view is active; recompute when the week (busDt) changes.
  useEffect(() => {
    if (viewMode !== 'week') return;
    loadWeekGrid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, busDt]);

  // A new day's data just loaded (storeData changed) — refresh today's slice into the WTD sums while in Week view.
  useEffect(() => {
    if (viewMode !== 'week' || loading) return;
    loadWeekGrid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeData]);
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(pulse): trigger WTD recompute on Week toggle, week change, and refresh"
```

---

## Task 3: Toggle UI in the controls row

**Files:** Modify `app.jsx` (`AdminPulse`)

- [ ] **Step 1: Insert the toggle** in the controls row, immediately after the Auto-refresh button block (around `app.jsx:9366`). Read the exact closing of that `<button …>…</button>` and insert this sibling right after it:

```jsx
              {/* Daily | Week (WTD) toggle */}
              <div style={{ display:'inline-flex', alignItems:'center', gap:6, marginLeft:8 }}>
                <div style={{ display:'inline-flex', borderRadius:8, overflow:'hidden', border:`1px solid ${th.cardBorder}` }}>
                  {[['day','Daily'],['week','Week']].map(([m,label]) => (
                    <button key={m} onClick={() => setViewMode(m)}
                      style={{ padding:'0.35rem 0.7rem', fontSize:'0.72rem', fontWeight:700, cursor:'pointer', border:'none',
                        background: viewMode===m ? G : 'transparent', color: viewMode===m ? '#04150d' : th.muted }}>
                      {label}{m==='week' && weekLoading ? ' ⏳' : ''}
                    </button>
                  ))}
                </div>
                {viewMode==='week' && (
                  <span style={{ fontSize:'0.6rem', color:th.muted }}>WTD · Sun→today ({getWeekDates(busDt).length}d)</span>
                )}
              </div>
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Manual smoke**

On a preview build, open Pulse: the `Daily | Week` toggle shows in the controls row, defaults to Daily, and clicking Week shows the "WTD · Sun→today (Nd)" caption + a brief ⏳ while loading. (Tiles won't switch yet — that's Task 4.)

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(pulse): Daily|Week segmented toggle in the controls row"
```

---

## Task 4: Switch district + store tiles to the WTD source

**Files:** Modify `app.jsx` (`AdminPulse`)

- [ ] **Step 1: Switch the `allRows` `live` source by viewMode.** Replace the `.map(...)` on `app.jsx:9220`:

```javascript
    .map(s => ({ ...s, live: storeData[s.pc] }));
```

with:

```javascript
    .map(s => ({
      ...s,
      live: viewMode === 'week'
        ? (weekStoreData[s.pc] ? { status: 'ok', data: weekStoreData[s.pc] } : undefined)
        : storeData[s.pc],
    }));
```

Because every district rollup and store tile reads `s.live.data.netSales` / `s.live.data.guests`, this flips both to WTD in Week mode and leaves Daily untouched. When `weekStoreData` hasn't loaded yet, `live` is `undefined` — exactly the "not yet loaded" state tiles already handle in Daily mode.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Manual smoke (the real test)**

Preview build, Pulse page:
1. Daily mode: tiles unchanged — district + store tiles show today's net sales + guests.
2. Toggle **Week**: every store tile and district rollup switches to WTD net sales + guests; a quick load happens (progress/⏳), then numbers settle.
3. **Reconcile:** pick one store; in Daily mode step through each day of this week and add the net sales by hand — it equals that store's Week value (consistency check).
4. District Week tile = sum of its stores' Week values.
5. Toggle back to **Daily** → instant, original numbers.
6. As a DM user: only your district loads/sums.

- [ ] **Step 4: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(pulse): district + store tiles show WTD net sales + guests in Week mode"
```

---

## Task 5: Version bump, final build, PR

**Files:** Modify `app.jsx` (version); then PR.

- [ ] **Step 1: Bump version** — change `v14.52` to `v14.53` in the sidebar footer (`app.jsx`, search `v14.52`).

- [ ] **Step 2: Final build + confirm bundle**

Run: `npm run build && grep -c "setViewMode" app.js`
Expected: build succeeds; grep prints `≥ 1`.

- [ ] **Step 3: Confirm clean tree**

Run: `git status --porcelain --untracked-files=no`
Expected: empty after the version-bump commit.

```bash
git add app.jsx app.js
git commit -m "chore(pulse): bump v14.53 — Daily/Week toggle"
```

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feature/pulse-weekly-toggle
gh pr create --title "feat(pulse): Daily/Week (WTD) toggle on main grid (v14.53)" \
  --body "Per docs/superpowers/specs/2026-06-09-pulse-weekly-toggle-design.md. Daily|Week toggle on the main Pulse grid (default Daily); Week shows WTD (Sun→today) net sales + guests on both district and store tiles, summed from the same Pulse dailies. Lazy load + per-day cache."
```

- [ ] **Step 5: STOP for review / preview-deploy smoke** before merging to prod (per the work-order: per-task branch → PR → preview → smoke → prod).

---

## Self-review notes

- **Spec coverage:** WTD Sun→today (`getWeekDates`, Task 1) ✓; both districts + stores (`allRows.live` swap, Task 4) ✓; net sales + guests (tiles read both from `s.live.data`, Task 4) ✓; default Daily (`viewMode='day'`, Task 1) ✓; consistency = sum of same dailies (`loadWeekGrid` sums `fetchDate` results, Task 1) ✓; lazy (trigger effect only fires in Week, Task 2) ✓; refresh/week-change handling (Task 2 effects) ✓; DM-scoped (`activePCs`, Task 1) ✓; session-only state ✓.
- **Deviation from spec:** the "WTD · {n}d" indicator is rendered **once next to the toggle** (Task 3) rather than as a caption on every tile — cleaner and avoids touching every tile's JSX. Matches spec confirm-point #2 (caption was optional/omittable).
- **Type consistency:** `weekStoreData[pc]` is `{netSales,guests,voids,discounts}`; wrapped as `{status:'ok', data: …}` in Task 4 to match the `s.live` shape (`{status, data}`) that tiles already read. `dayStoreCache[date]` and `storeData` are both `fetchDate` output shape. Consistent across tasks.
