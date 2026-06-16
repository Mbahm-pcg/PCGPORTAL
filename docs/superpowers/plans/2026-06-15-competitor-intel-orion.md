# Roadmap 10.5 — Competitive Intelligence as an Orion daily/event email (no new tab)

## Context
ImpactRadar (10.5 ✅) already turns a competitor *event* ("Starbucks opened 0.3mi from Store X on date Y")
into a before/after sales-impact analysis vs distance-ranked control stores. What's missing is the **feed**:
nobody is detecting those openings/closings, so the engine sits idle. The user wants this delivered as an
**Orion report emailed to Exec + the relevant DM** — *no new UI tab*. Orion already runs a daily cron
(`analyst-cron.js`) that emails DM briefs + exec reports, so this extends existing rails.

## Approach (server-side, inside Orion)
Monitor each store's trade area with Google Places, diff day-over-day to catch new/closed competitors,
log them as events, run the impact analysis as post-event sales data accrues, and email Exec + that
store's DM. Detection runs **weekly, Wednesday 5 AM ET** via its own `competitor-cron` (`0 9 * * 3`);
it sends a **weekly digest** (openings/closings + impact + promotions). `emailOnlyWhenNew` (default
false) can be flipped on to suppress quiet weeks; promos are diffed week-over-week to tag what's NEW.

## Data we already have (from code review)
- **Impact math** — `beforeAfter()` in [src/impact.mjs](src/impact.mjs) is a self-contained pure function (event week = last "before" week). Port to CommonJS for the function runtime.
- **Store coordinates** — `STORE_COORDS` (45 stores, lat/lng) in [app.jsx](app.jsx) ~line 2712. Copy into a server module (server `STORES` in analyst-lib has no coords).
- **Places client** — [netlify/functions/reviews-cron.js](netlify/functions/reviews-cron.js) ~line 84 uses `places.googleapis.com/v1` with `X-Goog-Api-Key` (env `GOOGLE_PLACES_API_KEY`). Reuse `fetchJSON()`; new endpoint `places:searchNearby`.
- **Cron + email** — [netlify/functions/analyst-cron.js](netlify/functions/analyst-cron.js) (steps 1–5, morning run). Email via `sendEmail()` in [analyst-lib/analyst-reports.js](netlify/functions/analyst-lib/analyst-reports.js) (SMTP→Resend fallback). DM-by-district lookup exists there (`users` blob + `DM_INFO` fallback); exec via `settings.execReportCC`.
- **Sales history** — `pcg_labor_store_{pc}.weekly` blob (~13 weeks rolling, auto-refreshed) + optional `pcg_sales_v1` scorecard (longer if uploaded). Sufficient for impact analysis of **recent** events.

## Build — Phase 1: detection + alert (recommended first)
1. **`analyst-lib/store-coords.js`** (new) — server copy of `STORE_COORDS` {pc → lat,lng}.
2. **`analyst-lib/competitor.js`** (new):
   - `snapshotStore(pc)` — Places `searchNearby` (radius ~1.6 km, competitor types: coffee shop / QSR; e.g. `cafe`, `coffee_shop`, `fast_food_restaurant`), returns `[{placeId,name,types,lat,lng,distanceMi,businessStatus,userRatingCount,rating}]`.
   - Persist latest per-store snapshot blob `competitor/snapshot_{pc}` (via analyst cache helpers).
   - `diff(prev,curr)` → **appeared** = opening candidate; **disappeared / businessStatus=CLOSED** = closing candidate. Compute distance from store coords.
   - Append to event log blob `competitor/events_v1`: `{id, pc, district, competitor, type, eventType:'open'|'close', distanceMi, detectedDate, status:'monitoring', impact:null}`.
3. **`analyst-cron.js`** — add a **weekly** step (gate to one morning/day, e.g. Monday): loop stores, snapshot+diff, collect new events.
4. **Email** — for each new event, email **Exec** (settings.execReportCC + dynamic exec lookup) and the **store's DM** (existing district lookup). Branded HTML: competitor, type, distance, which store, detected date, and **"auto-detected candidate — verify"** label. DMs only get events in their district.

## Build — Phase 2: impact analysis (the ImpactRadar payoff)
5. **`analyst-lib/impact-math.js`** (new, CJS) — port `beforeAfter()` + distance-ranked control selection.
6. In the weekly step, for each event with status `monitoring` and ≥ N weeks (e.g. 4) of post-event data:
   - Load affected store + nearest control stores' `pcg_labor_store_{pc}.weekly` (fallback scorecard).
   - Compute store deltaPct vs control-store average delta around `detectedDate`; store on the event (`impact`), set status `analyzed`.
   - Email the result: *"Store X sales −8% in the 4 weeks since [competitor] opened 0.3mi away; control stores flat — est. annualized $Y."* Re-run/refine until window closes.

## Build — Phase 3: competitor promotions (added per request)
- New `callClaudeWithWebSearch()` in [analyst-lib/analyst-claude.js](netlify/functions/analyst-lib/analyst-claude.js) — Claude (Sonnet) with the `web_search` server tool.
- In `competitor.js`: `deriveBrands()` reads the stored Places snapshots and keeps only known national/regional chains actually near our stores; `fetchPromos()` asks Claude (web search) for current/upcoming LTOs/app deals for those brands, parses a JSON array `{brand,offer,ends,source}`, diffs vs last week (`competitor/promos_v1`) to flag **NEW**, and appends a "Competitor promotions" section to the weekly email. Every line carries a source link + "AI-gathered, verify."
- Runs on the weekly detection pass; degrades gracefully (logs + omits the section) if web search isn't enabled on the API key. Gated by `promosEnabled` in the competitor-settings blob.

## Deferred
- **Market-share index (10.5 bullet 2)** — proxy only (no competitor sales). Trade-area share index from Places `userRatingCount` + competitor density. Ship later, clearly labeled an estimate.
- **Philly business-license feed** ([philly-data.js](netlify/functions/philly-data.js)) as a second opening signal — Philadelphia stores only; optional later.
- Surfacing the event log in Orion chat / a read-only view (still no dedicated tab).

## Honest caveats
- **Places is noisy** — new listings lag real openings, "closed" flags are unreliable → events are **candidates to verify**, never auto-treated as ground truth.
- **13-week sales window** limits impact analysis to recent events; older events lack before-data unless `pcg_sales_v1` scorecard history covers them.
- **No manual entry without UI** — Phase 1 is fully automated; if a human wants to log a known opening, that needs a small input (deferred, since "no new tab").

## Verification
1. Manual POST to `analyst-cron` (or a temporary `competitor` test function) → confirm `searchNearby` returns competitors with distances for a known store; snapshot blob written.
2. Seed a fake "prior snapshot" missing one competitor → confirm diff produces an `open` event and an email to Exec + that district's DM (test recipient).
3. Phase 2: pick a store with a real recent event date → confirm `beforeAfter` delta vs controls matches what the ImpactRadar tab shows for the same event.
4. Confirm DMs only receive their district's events; no email sent on a week with zero detections.
```
