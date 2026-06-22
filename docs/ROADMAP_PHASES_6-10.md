# PCG Unified Operations Portal — Phases 6–10 Roadmap

> **Context:** Phases 1–5 built the foundation: real-time POS data, labor analytics, AI analyst (Orion), project tracking, team chat, KB, notifications, guest reviews, weather forecasting, food cost tracking, P&L reports, and role-scoped access for 45 stores across 8 districts. Phases 6–10 shift the platform from "rearview mirror" to "operations copilot" — telling operators what to do next, not just what happened.

---

## Phase 6 — Command Center + Predictive Intelligence
*"Stop staring at dashboards. Get told what matters."*

### 6.1 Action Queue
✅- AI-prioritized list of items needing human attention, ranked by business impact
✅- "Store 412 above 28% labor for 3 consecutive days" — multi-day streak tracking built "5 stores haven't submitted daily reports" — not yet implemented
✅- One-click actions: call manager (📞), acknowledge (✓ snooze 4h), delegate to DM (📤 push) Adjust schedule action — not yet (navigates to Labor tab instead)
✅- Track resolution time per DM — ack time logged to pcg_action_log, 7-day scorecard per district

### 6.2 AI Sales Forecasting Engine(Give it more time to collect data)(6-10 weeks of data)
✅- Train on Pulse POS historical data to predict next-day / next-week sales by store, by hour, by daypart
- Factor in: day of week, weather (Open-Meteo), holidays, seasonality, local events
- Display as "Forecast vs Actual" overlay on Pulse charts — managers see how they're tracking in real-time
- Foundation for labor scheduling, inventory ordering, and prep planning

### 6.3 Smart Labor Recommendations
✅ - Show projected labor % before the week starts — 7-day forecast strip on every store card in Labor tab
✅ - Alert DMs + managers when a store is projected ≥26% — push notification + branded email (Mon & Thu 6 AM ET via schedule-alerts.js)
- Use sales forecasts to generate recommended staffing levels per store, per hour (needs 6.2 hourly data — 4+ more weeks)
- Compare actual Paycor schedule against AI-recommended schedule — highlight over/under-staffed periods (deferred, depends on per-hour forecasting)

### 6.4 Real-Time Operations Map 
✅- Interactive map of all 45+ stores with live status indicators
✅- Color-coded by current performance: green (on-target), yellow (watch), red (intervention needed)
✅- Click a store pin → live snapshot: current hour sales, who's clocked in, labor %, open alerts
✅- Overlay weather conditions

### 6.5 Anomaly Detection 2.0
✅ - Move from static thresholds to rolling baselines per store
✅ - "Store 345 sales are 22% below forecast at 11 AM — unusual for a Tuesday"
✅ - Cash handling anomalies: high voids, unusual refund rates, cash vs card ratio shifts
✅ - Employee clock-in pattern anomalies: buddy punching detection, ghost shifts

---

## Phase 7 — Financial Mastery
*"Know your unit economics in real time, not 30 days later."*

### 7.1 Live Store P&L
- Combine Pulse sales + Paycor labor + Food Cost(T) for real-time estimated P&L per store, updated hourly ← pnl-cron runs monthly; true hourly update not yet done
✅ - Weekly/monthly rollups with trend lines (pcg_pnl_store_{pc} daily history, PnLStoreDetail drill-down)
✅ - Rank stores by contribution margin, not just sales (AdminPnL sorts by contribution)
✅ - Revenue - Labor - COGS = Gross Contribution, visible at a glance (KPI cards: Revenue / Labor / COGS / Contribution / Margin %)

### 7.2 Food Cost(T) Full BOM
✅ - Complete bill-of-materials for every menu item — cost-to-make per unit sourced from POS analysis report (Jun 2026)
✅ - Raw ingredient cost table with per-unit pricing — WorkPulse RI10xxx bakery codes + full beverage/food/ice cream catalog
✅ - True theoretical food cost across ALL categories — beverages, food, sandwiches, ice cream, bakery all covered in food-cost.js
- **Prerequisite:** Mike provides item list + build sheets + ingredient costs

### 7.3 Labor Optimization Simulator
✅ - What-if simulator: cut N people × H hours → daily savings, new labor %, new break-even, weekly savings. Day-selectable from schedule table.
✅ - Break-even analysis: avg daily labor cost, break-even sales at 25% target, gap indicator, progress bar
✅ - Network/district comparison: top 5 performers vs needs attention, rank (exec/IT), district-only view (DMs), hidden for managers

### 7.4 Royalty & Fee Forecasting
- Based on current sales trajectory, forecast monthly royalties, ad fund contributions, net revenue
- Alert when a store is trending toward missing targets
- Forward-looking cash flow projections

### 7.5 DM Scorecard
75/100 (not fully yet) - Rank district managers on composite metrics: sales growth, labor efficiency, turnover rate, project completion
✅ - Trend over time — is each DM improving?
- Used for coaching conversations and bonus calculations

---

## Phase 8 — People & Compliance
*"Reduce 150% annual turnover. Automate every checklist."*

### 8.1 Employee Lifecycle Dashboard
- Track every employee from hire to separation: days employed, training completion, schedule reliability, tenure milestones
- Predict flight risk: employees whose hours have been cut, passed over for raises, or match patterns of past departures
- "Retention score" per store and per DM — which managers keep people longest?

### 8.2 Training & Certification Tracker
- Track Dunkin' University completion, food handler certifications, safety training, new product training
- Alert when certifications are expiring
- Gamify: leaderboards for training completion, badges for milestones
- Correlate: "Stores with >90% training completion average 8% higher sales"

### 8.3 Digital Checklists & Task Management
- Opening/closing checklists, food safety temp logs, cleaning verification — all digital, timestamped, GPS-verified
- Photo verification: "Take a photo of the clean drive-thru area" — timestamped and stored
- Escalation: incomplete checklists trigger DM notification
- Audit trail: 90 days of digital records for health inspector visits

### 8.4 Shift Marketplace
- Employees post shifts to drop, pick up available shifts across nearby stores in same district
- DM approval required but one-tap
- Cross-store labor sharing: "Store A overstaffed Tuesday morning, Store B needs coverage" — AI suggests the swap

### 8.5 Crew Pulse Surveys
- Weekly 3-question check-in: "How was your week? 1-5 stars" + one open-ended
- Aggregate sentiment by store/district — early warning system for morale problems
- Correlate with turnover data

---

## Phase 9 — Supply Chain & Customer Intelligence
*"Know what you're selling, wasting, and missing."*

### 9.1 Waste & Variance Tracking
- Theoretical vs actual usage: "Store X should have used 400 lbs of coffee but reported 450"
- Highlight variance outliers — potential theft, overportioning, or waste
- COGS is 28-32%. A 2% reduction across 45 stores on $50M revenue = $1M to the bottom line

### 9.2 Par Level Optimizer (June 23)
- Use sales forecasts to recommend optimal par levels per product per store per day
- "Tomorrow is projected 15% above average at Store 310 — increase donut par by X dozen"
- Detect stockout events (menu item sales dropping to zero mid-day)

### 9.3 Sales Mix Intelligence
✅ - Menu item performance by store (daily totals via Pulse getMenuItemDailyTotals — full item name + sales $ + count per store drill-down)
- Menu item performance by daypart and day of week — not yet done
- "Store 220 sells 40% fewer espresso drinks than district average — equipment or training issue?" — cross-store item comparison not yet done
- Track new product launch performance across the network

### 9.4 Guest Check Analytics
✅ - Average check size trending, items per transaction (avgCheck computed per store; full transaction detail modal with itemized line items via getGuestChecks)
✅ - Upsell rate (proxy: % of checks with 2+ real items, tracked daily per store in pcg_hourly_history, surfaced in Pulse store detail + Orion ops context)
✅ - Identify top upselling stores (network top/bottom 5 surfaced to Orion); item-level "what they're doing differently" via daily-cached item-mix diff — top-5 vs bottom-5 upsell stores, units per 100 checks, cited in DM/exec briefs (v14.90)
✅ - "Store X averages $Y/check vs network $Z — what are they doing differently?" (district-neighbor avg check + upsell rate comparison in Orion store brief)

### 9.5 Daypart Performance Matrix ✅ shipped v14.91–14.96
✅ - Heat map: every store's performance by hour of day × day of week (7-day hour×day sales heatmap in the Map pin popup — quantized intensity scale, per-day totals, peak-hour callout; plus live Uber-surge-style heat clouds on the map itself: red = busy / orange = steady / grey = dead, today's actual sales vs own peak, refreshed every 15 min)
✅ - Identify "dead zones" where staffing doesn't match traffic (Staffing Fit grid: upcoming Paycor schedule vs typical traffic per weekday-hour — red = overstaffed (<$35 sales/labor-hr), amber = understaffed/no coverage (>$110), flagged before the shift happens)
✅ - Spot opportunities: "Store 410 has almost no late-afternoon business — market issue or ops issue?" (dead-zone callout: store's share-of-day by daypart vs district peers' 7-day curve, worst gap surfaced verbatim with the "market issue or ops issue?" prompt)

---

## Phase 10 — Platform & Moonshots
*"From franchise dashboard to franchise operating system."*

### ~~10.1 Voice-First GM Mode~~ ✅ shipped v14.65–14.67
- ~~"Hey Orion, how did we do last night?" → 30-second spoken summary~~
- ~~Web Speech API (STT) → Orion backend → speech synthesis (TTS)~~
- ~~Hands-free during morning walkthrough~~
- ~~Mic button center of manager mobile nav; Orion context includes sales, labor, tickets, DCP, schedule (store-scoped)~~

### 10.2 Drive-Thru Performance Analytics
✅ - Avg service time per car (order entry → payment close via POS opnUTC/clsdUTC — no HME needed)
✅ - Cars/hour by daypart — hourly bar chart color-coded by threshold (≤2m excellent / 2–3m good / 3–4m watch / 4m+ slow)
✅ - Peak wait identification — slowest hour KPI + service time distribution buckets (< 2m / 2–3m / 3–4m / 4–5m / 5m+)
✅ - DT % of total traffic, DT revenue, DT avg check — all surfaced per store per day (v14.68)
✅ - Staffing correlation: hover any hour → see service time + staff count on schedule side by side (Paycor schedule + POS service time joined by hour)
✅ - Pre-menu-board queue time — covered by POS opnUTC/clsdUTC (order entry → payment close); HME not required
✅ - Drive-thru is 70%+ of Dunkin' revenue — DT % of traffic surfaced per store per day

### 10.3 Benchmarking Engine
- Every metric ranked: store vs district vs network
- Percentile rankings: "Store 345 is in the 85th percentile for labor efficiency"
- "If your bottom 10 stores improved to median, your network would gain $X/year"

### 10.4 New Store / Remodel ROI Tracker 
- Track pre/post performance for every capital project
- "Remodel completed 3 months ago: sales up 12%, labor down 1.5%, guest count up 8%"
- Calculate payback period on capital investments

### 10.5 Competitive Intelligence Layer
✅ - Track nearby competitor openings/closings (manual entry or public data)
✅ - Correlate with store performance: "Sales dropped 8% after Starbucks opened 0.3 miles away" — ImpactRadar: before/after event analysis vs distance-ranked control stores, exportable PDF report
✅ - Market share estimation using data proxies

### 10.6 White-Label / Multi-Brand Architecture
- Abstract platform to support any franchise brand, not just Dunkin'
- Data model is already mostly brand-agnostic: stores, districts, labor, sales, projects
- Potential to license to other multi-unit operators

### 10.7 Admin Console & Access Governance ✅ shipped v14.98–v15.05
✅ - Unified **Admin** console (replaces Settings) — one flat tab bar: Notifications · Users · Access · Orion · Vendors · System & Logs (IT/Exec only)
✅ - **Access** tab: live "who-can-see-what" matrix derived from the real `getTabs()` logic, per role, with user counts + scope notes
✅ - **Per-role tab visibility toggles** — IT/Exec show/hide any role-specific section network-wide (Netlify Blob `pcg_access_overrides_v1`, 12s live propagation), with a lockout guard that keeps Admin visible for IT/Exec
✅ - System overview (users/stores/roles/version) + role breakdown; audit log + notification log consolidated under System & Logs
✅ - Expense Log promoted to its own Finance tab (IT/Exec only); P&L data-access management relocated to the Access tab

---

## Phase 11 — Deal Pipeline & Real Estate (Pre-Construction)
Dedicated pre-construction real estate deal tracker for leased AND purchased sites — separate
from the Projects/Construction tracker. Owns a site from sourcing → LOI → due diligence →
lease/PSA execution → closing/possession → **"Ready for Construction" handoff**. Everything
before we break ground. Design spec: `docs/superpowers/specs/2026-06-05-deal-pipeline-design.md`.

### 11.1 Deal Pipeline v1 (Core + high-value gaps) — IN PROGRESS (branch `feature/deal-pipeline`)
- Kanban + sortable/filterable table over one dataset (toggle); 8 stages, handoff on stage 8
- Deal record: core + full lease + full purchase field sets; brand (Dunkin/Papa John's/BWW GO/dual), PA/NJ
- High-value gaps folded in: split possession/lease-commencement/rent-commencement dates; recurring
  critical dates; **tiered escalating + acknowledged** alerts; dead-deal reason codes; SPE/entity field;
  extended lease abstract (CAM cap/gross-up/audit, co-tenancy, kick-out, holdover, ROFR/ROFO, delivery condition)
- Documents with **version history** (redline trail, no overwrite) via chunked uploader
- Critical dates → one-click **.ics** now (Google Calendar auto-push later); configurable advance warnings
- Dashboard (deals by stage, committed capital / annual pipeline rent, 30/60/90-day deadlines, red flags) + filters
- **Server-side RBAC** (view vs edit) — real auth on the data/document endpoints (net-new for the portal)

### 11.2+ Deferred (multi-track depth)
- Parallel tracks: Entitlement (PennDOT HOP / NJDOT MAP, land-development, stormwater, utility will-serve,
  building/sign permits → computed Ready-for-Construction gate); Franchisor (site/RDA approval as condition
  precedent, SDA development-schedule obligation, prototype approval); Financing/SPE entity module
- Underwriting fields + Investment-Committee go/no-go gate (occupancy-cost %, rent-to-sales %, total project
  cost, cash-on-cash, cap rate); pipeline analytics (weighted/probability value, days-in-stage, conversion)
- Full 1031 (45/180-day) tracking; Google Calendar auto-push; auto-create construction project on handoff
- Structured "Ready for Construction" handoff checklist + permit-expiration tracking

---

## Implementation Priority

**Phase 6 is the inflection point.** Action Queue + AI Forecasting shift the platform from "shows data" to "tells you what to do." Everything in Phases 7–10 builds on that predictive foundation.

### Data sources needed per phase:
- **Phase 6:** Existing (Pulse + Paycor + Weather) — just new logic
- **Phase 7:** Food Cost BOM data from Mike, existing APIs for the rest
- **Phase 8:** Paycor HR data (already accessible), new checklist data collection
- **Phase 9:** Inventory/DCP data feed (WorkPulse or manual), existing Pulse data
- **Phase 10:** HME timer integration, mapping libraries, architectural refactoring
