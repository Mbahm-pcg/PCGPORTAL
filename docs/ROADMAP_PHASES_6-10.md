# PCG Unified Operations Portal — Phases 6–10 Roadmap

> **Context:** Phases 1–5 built the foundation: real-time POS data, labor analytics, AI analyst (Orion), project tracking, team chat, KB, notifications, guest reviews, weather forecasting, food cost tracking, P&L reports, and role-scoped access for 45 stores across 8 districts. Phases 6–10 shift the platform from "rearview mirror" to "operations copilot" — telling operators what to do next, not just what happened.

---

## Phase 6 — Command Center + Predictive Intelligence
*"Stop staring at dashboards. Get told what matters."*

### 6.1 Action Queue
- AI-prioritized list of items needing human attention, ranked by business impact
- Examples: "Store 412 above 28% labor for 3 consecutive days" (high), "5 stores haven't submitted daily reports" (medium)
- One-click actions: call manager, adjust schedule, acknowledge, delegate to DM
- Track resolution time per DM — how quickly do they respond to alerts?

### 6.2 AI Sales Forecasting Engine
- Train on Pulse POS historical data to predict next-day / next-week sales by store, by hour, by daypart
- Factor in: day of week, weather (Open-Meteo), holidays, seasonality, local events
- Display as "Forecast vs Actual" overlay on Pulse charts — managers see how they're tracking in real-time
- Foundation for labor scheduling, inventory ordering, and prep planning

### 6.3 Smart Labor Recommendations
- Use sales forecasts to generate recommended staffing levels per store, per hour
- Compare actual Paycor schedule against AI-recommended schedule — highlight over/under-staffed periods
- Show projected labor % before the week starts: "If you run this schedule, projected labor is 24.7%"
- Alert DMs when a store's schedule is likely to blow past 26% labor threshold

### 6.4 Real-Time Operations Map
- Interactive map of all 45+ stores with live status indicators
- Color-coded by current performance: green (on-target), yellow (watch), red (intervention needed)
- Click a store pin → live snapshot: current hour sales, who's clocked in, labor %, open alerts
- Overlay weather conditions

### 6.5 Anomaly Detection 2.0
- Move from static thresholds to rolling baselines per store
- "Store 345 sales are 22% below forecast at 11 AM — unusual for a Tuesday"
- Cash handling anomalies: high voids, unusual refund rates, cash vs card ratio shifts
- Employee clock-in pattern anomalies: buddy punching detection, ghost shifts

---

## Phase 7 — Financial Mastery
*"Know your unit economics in real time, not 30 days later."*

### 7.1 Live Store P&L
- Combine Pulse sales + Paycor labor + Food Cost(T) for real-time estimated P&L per store, updated hourly
- Weekly/monthly rollups with trend lines
- Rank stores by contribution margin, not just sales
- Revenue - Labor - COGS = Gross Contribution, visible at a glance

### 7.2 Food Cost(T) Full BOM
- Complete bill-of-materials for every menu item (e.g., bacon egg & cheese = 1 egg + 1 cheese slice + 4 bacon strips + 1 croissant)
- Raw ingredient cost table with per-unit pricing
- True theoretical food cost across ALL categories (not just bakery)
- **Prerequisite:** Mike provides item list + build sheets + ingredient costs

### 7.3 Labor Optimization Simulator
- "What-if" tool: "If I cut one crew member from the 6-10 AM shift, what's the labor savings? What's the risk?"
- Show break-even analysis: "You need $X in sales this hour to justify current staffing"
- Compare best-performing stores' staffing patterns against underperformers

### 7.4 Royalty & Fee Forecasting
- Based on current sales trajectory, forecast monthly royalties, ad fund contributions, net revenue
- Alert when a store is trending toward missing targets
- Forward-looking cash flow projections

### 7.5 DM Scorecard
- Rank district managers on composite metrics: sales growth, labor efficiency, turnover rate, project completion
- Trend over time — is each DM improving?
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

### 9.2 Par Level Optimizer
- Use sales forecasts to recommend optimal par levels per product per store per day
- "Tomorrow is projected 15% above average at Store 310 — increase donut par by X dozen"
- Detect stockout events (menu item sales dropping to zero mid-day)

### 9.3 Sales Mix Intelligence
- Menu item performance by store, daypart, day of week
- "Store 220 sells 40% fewer espresso drinks than district average — equipment or training issue?"
- Track new product launch performance across the network

### 9.4 Guest Check Analytics
- Average check size trending, items per transaction, upsell rate (combo vs individual)
- Identify top upselling stores and extract their practices
- "Store 345 averages $8.20/check vs network $7.10 — what are they doing differently?"

### 9.5 Daypart Performance Matrix
- Heat map: every store's performance by hour of day × day of week
- Identify "dead zones" where staffing doesn't match traffic
- Spot opportunities: "Store 410 has almost no late-afternoon business — market issue or ops issue?"

---

## Phase 10 — Platform & Moonshots
*"From franchise dashboard to franchise operating system."*

### 10.1 Voice-First GM Mode
- "Hey Orion, how did we do last night?" → 30-second spoken summary
- Web Speech API (STT) → Orion backend → speech synthesis (TTS)
- Hands-free during morning walkthrough

### 10.2 Drive-Thru Performance Analytics
- Integrate with HME/timer systems: avg service time, cars/hour, peak wait times
- Correlate with staffing: "4 people on shift = 180 sec avg. 5 people = 140 sec avg."
- Drive-thru is 70%+ of Dunkin' revenue

### 10.3 Benchmarking Engine
- Every metric ranked: store vs district vs network
- Percentile rankings: "Store 345 is in the 85th percentile for labor efficiency"
- "If your bottom 10 stores improved to median, your network would gain $X/year"

### 10.4 New Store / Remodel ROI Tracker
- Track pre/post performance for every capital project
- "Remodel completed 3 months ago: sales up 12%, labor down 1.5%, guest count up 8%"
- Calculate payback period on capital investments

### 10.5 Competitive Intelligence Layer
- Track nearby competitor openings/closings (manual entry or public data)
- Correlate with store performance: "Sales dropped 8% after Starbucks opened 0.3 miles away"
- Market share estimation using data proxies

### 10.6 White-Label / Multi-Brand Architecture
- Abstract platform to support any franchise brand, not just Dunkin'
- Data model is already mostly brand-agnostic: stores, districts, labor, sales, projects
- Potential to license to other multi-unit operators

---

## Implementation Priority

**Phase 6 is the inflection point.** Action Queue + AI Forecasting shift the platform from "shows data" to "tells you what to do." Everything in Phases 7–10 builds on that predictive foundation.

### Data sources needed per phase:
- **Phase 6:** Existing (Pulse + Paycor + Weather) — just new logic
- **Phase 7:** Food Cost BOM data from Mike, existing APIs for the rest
- **Phase 8:** Paycor HR data (already accessible), new checklist data collection
- **Phase 9:** Inventory/DCP data feed (WorkPulse or manual), existing Pulse data
- **Phase 10:** HME timer integration, mapping libraries, architectural refactoring
