# PCG Portal — Claude Code Execution Prompt (Now / Next Tier)

> Paste this whole file to Claude Code, or drop it in the repo root as `EXECUTION.md` and say: "Read EXECUTION.md. Run the git pre-flight, then start with Task 1."
>
> **Scope of this work order:** Track 0 (Platform Hardening) · finish Phase 11.1 (Deal Pipeline) · the Impact / Cannibalization Radar. Nothing else. Do not start Phase 7/8/9/10 work — if you finish early, stop and report.

---

## ROLE
You are the lead engineer on the PCG internal operating platform (45+ unit Dunkin' franchisee group, PA/NJ). Owner: Mike Bahm, VP of Ops. Be direct, ship in small verifiable diffs, preserve what works, never refactor beyond scope.

## SYSTEM CONTEXT (respect these — do not change the architecture)
- **Frontend:** React 18 via CDN UMD, authored in **JSX** — source is **`app.jsx`** (~33K lines) + `src/icons.jsx`, `src/theme.js`, `src/*.mjs`, **bundled by esbuild → `app.js`** (the committed + served artifact). **Edit the `.jsx`/`src` source, run `npm run build`, commit BOTH `app.jsx` and `app.js`.** Entry: `index.html` (`<div id="root">` + `<script src="app.js">`). ⚠️ `app.js` is the generated bundle (full of `React.createElement` — that's esbuild output, NOT hand-written source); **never hand-edit `app.js`** — it's overwritten by the next build. (`npm run watch` rebuilds live.)
- **Styling:** inline style objects + `<style>` block in `index.html`. Brand `#FF671F`. Fonts: Raleway (headings), Source Sans 3 (body). Partial dark mode (`pcg_dark_mode`). Service worker (`sw.js`) present.
- **Libraries loaded:** Leaflet, Chart.js, reveal.js, pptxgenjs, jsPDF, html2pdf, xlsx, pdf.js, Google Identity Services.
- **Backend:** Netlify Functions `/.netlify/functions/`: `analyst`, `analyst-report-background`, `daily-feed`, `email-send`, `food-cost`, `kb-manage`, `kb-sync`, `labor-cron(-background)`, `ndcp`, `notify`, `paycor`, `philly-data`, `philly-zoning`, `pulse`, `pulse-notify`, `push`, `reconciliation`, `reports-backup`, `sms`, `storage`, `trusted-devices`. (Deal functions `deals`/`deal-auth`/`deal-docs` exist on the `feature/deal-pipeline` branch, not yet deployed.)
- **Auth/RBAC:** Google OAuth (GSI) + `portal-auth`. Roles: `admin`, `dm`, `gm`, `user`. VP-approval workflow exists ("Submit for VP Approval" / "Pending VP").
- **AI ("Orion"):** calls `analyst`; server-selected model (Claude Haiku/Sonnet).
- **Persistence today:** business blobs `pcg_portal_data_v8`, `pcg_sales_v1`, `pcg_tickets_v1` are **localStorage-authoritative** (the thing Task 1 fixes); `storage` function already used in ~17 places; UI prefs in localStorage.

---

## 🔒 GIT DISCIPLINE — MANDATORY (do not skip either gate)

### A) PRE-FLIGHT — run BEFORE touching any code, every session
```bash
git status                 # working tree MUST be clean
git fetch --all --prune
git branch -a              # note main + feature/deal-pipeline + others
git log --oneline -10      # what's the current state
```
- If the working tree is **dirty**, STOP. Report what's uncommitted and ask before proceeding — do not stash or discard without confirmation.
- Sync the base branch: `git checkout main && git pull --ff-only` (substitute the actual default branch if not `main`).
- **Create a dedicated branch per task — never commit to `main` directly:**
  - Task 1 → `feature/hardening-server-state`
  - Task 2 → continue on existing `feature/deal-pipeline` (do NOT create a new one; rebase it on latest main first and confirm with me)
  - Task 3 → `feature/impact-radar`
- Confirm the branch out loud before editing: "On branch X, tree clean, based on main@<sha>."

### B) DURING WORK
- Small atomic commits, clear messages (`hardening: write-through pcg_sales_v1 to storage fn`).
- Read the relevant section of `app.js` before editing it. Report what changed, which files, how to test, after each task.
- Never force-push a shared branch. Never rewrite history on `feature/deal-pipeline` without explicit OK.

### C) PRE-DEPLOY — run BEFORE any deploy, every time
```bash
git status                 # everything intended is committed, nothing stray
git log --oneline main..HEAD   # exactly what is about to ship
git branch --show-current  # confirm correct branch
```
- Confirm with me which branch deploys and how (Netlify auto-deploy on merge to `main`, vs `netlify deploy`).
- **Preview first:** `netlify deploy --build` (preview URL) → smoke-test → only then `netlify deploy --build --prod` OR merge to `main`.
- After deploy: load the live URL, run the smoke test for the feature, and for Task 1 specifically verify the cross-device data path. Report the deploy URL + result.
- If anything looks wrong post-deploy, the rollback is the previous Netlify deploy (or revert the merge commit) — state the rollback plan before deploying.

---

## TASK 1 — Finish server-state migration (Track 0.1) + hardening
**Branch:** `feature/hardening-server-state`

1. Read the `app.js` sections handling `pcg_portal_data_v8`, `pcg_sales_v1`, `pcg_tickets_v1`, and every `storage` function call. **Summarize the current data flow back to me and wait for go-ahead before editing.**
2. Make the `storage` function authoritative for those three business blobs: load from server on init, write-through to server on change, localStorage as **offline cache only**. Last-write-wins is acceptable v1. Add a small "last synced" indicator in the UI.
3. Keep pure UI prefs (`pcg_dark_mode`, `pcg_sidebar_*`, `pcg_prefer_full_portal`, `pcg_show_*`) in localStorage — do not migrate these.
4. Add loading / empty / error states to any function calls touched (skeleton, retry, friendly empty).
5. (If quick) extract a minimal `THEME` token object and point the styles you touch at it — do not boil the ocean.

**Acceptance:** data created on Device A appears on Device B after refresh; clearing localStorage does not lose business data; offline still renders from cache. Demonstrate the cross-device path in the smoke test.

## TASK 2 — Finish Phase 11.1 Deal Pipeline
**Branch:** existing `feature/deal-pipeline` (rebase on latest `main` first; confirm with me before rebasing)

Complete per `docs/superpowers/specs/2026-06-05-deal-pipeline-design.md`:
- Kanban + sortable/filterable table over one dataset (toggle); 8 stages, handoff at stage 8.
- Deal record: core + full lease + full purchase fields; brand (Dunkin / Papa John's / BWW GO / dual), PA/NJ.
- Split possession / lease-commencement / rent-commencement dates; recurring critical dates; **tiered escalating + acknowledged** alerts; dead-deal reason codes; SPE/entity field; extended lease abstract (CAM cap/gross-up/audit, co-tenancy, kick-out, holdover, ROFR/ROFO, delivery condition).
- Documents with **version history** (no overwrite; redline trail) via chunked uploader.
- Critical dates → one-click **.ics** export; configurable advance warnings.
- Dashboard: deals by stage, committed capital / annual pipeline rent, 30/60/90-day deadlines, red flags + filters.
- **Server-side RBAC (view vs edit)** on the `deals`/`deal-docs` endpoints — real auth, not client-only. **Build this generically so it can be reused across the platform** (Track 0.4).

**Acceptance:** a deal moves through all 8 stages; alerts fire at configured thresholds and can be acknowledged; documents retain version history; a non-edit role cannot write via the API (verify with a direct request, not just hidden UI).

## TASK 3 — Impact / Cannibalization Radar (Priority Insert)
**Branch:** `feature/impact-radar`

Quantify sales impact when a competing or sister store opens nearby (the manual ≈28.9% 18th-St analysis, automated).
- Inputs: store list + coordinates (existing), weekly sales (Pulse / `food-cost`), an "opening event" (date + lat/lng, competitor or sister).
- Logic: configurable trade-area radius / drive-time; trailing-vs-following weekly sales delta for affected store(s); output % change, annualized $ impact, confidence band.
- Visuals: Chart.js trend (before/after) + Leaflet affected-radius overlay. Reuse Philly Atlas (`philly-data`/`philly-zoning`) for site/competitor context where relevant.
- Output: one-click **branded PDF exhibit** (jsPDF/pptxgenjs) suitable for an impact claim / Inspire CIS-MIS filing.

**Acceptance:** given an opening event near an existing store, the module reproduces the 18th-St-style analysis and exports a clean branded exhibit.

---

## RULES OF ENGAGEMENT
1. The app **is built**: edit JSX source (`app.jsx` / `src/*`), run `npm run build` (esbuild), commit both source and the regenerated `app.js`. Never hand-edit `app.js`. React + libs stay CDN globals (no bundler for them); match the existing JSX + inline-style patterns.
2. Don't break shipped modules (Action Queue, Ops Map, Anomaly 2.0, Food Cost BOM, Labor Simulator). Read before you edit.
3. Server is source of truth for business data; localStorage is cache.
4. Brand-consistent (existing tokens/fonts/card+hover classes/animations).
5. Every async call gets loading + error + empty states.
6. **Run the git pre-flight before starting and the pre-deploy gate before shipping — every time.**
7. After each task: what changed, which files, how to test, follow-ups. Then stop for my review before the next task.

## FIRST STEP
Run the **git pre-flight (Section A)** and report branch/tree state. Then begin **Task 1, step 1** (read + summarize the persistence data flow) and **wait for my go-ahead** before editing.
