# Pulse vs. Workpulse — Gap Analysis & Build Roadmap
**Date:** 2026-09-05 · Author: Mike + Claude · Source: live crawl of site.workpulse.com (PCG tenant, all 20 modules) vs. PCGPORTAL `main`

> Workpulse is the incumbent QSR "Restaurant Operating System" your data already flows into
> (same 46 stores, Districts 1-8 by DM, 2,154 users). It is a 20-module paid SaaS built over
> years. Goal: fold its highest-value capabilities into Pulse — and do several of them *better* —
> so Pulse becomes the single operational system for every facet of PCG.

---

## 1. The honest scope reality
Workpulse = 20 modules, ~200 reports, 2,154 users, years of build. "Fully operational for every
facet in ~1 week" is not a literal 1:1 clone — nor should it be. The right read:
- **Pulse already covers ~40% of Workpulse** (sales, labor, cash/safe, audits/CAP, complaints, KB, tasks, maintenance) — and has **4 things Workpulse has NO answer for** (see §4).
- A focused **1-week sprint can close the 3-4 highest-ROI gaps** and stand up the scaffolding for the rest.
- The remainder is a **4-8 week roadmap**, phased below.

---

## 2. Module-by-module map (Workpulse → Pulse status)

| Workpulse module | What it does | Pulse today | Verdict |
|---|---|---|---|
| **Sales** (~60 reports) | POS analytics: LY everywhere, Dunkin/Baskin split, daypart, tender type, revenue center, sales-by-time, comps, 3rd-party delivery, product mix, menu analysis | Pulse (AdminPulse) + LY comparisons (just built), district/store drill | **Partial — deepen** |
| **Financial** | Flash P&L, P&L Scorecard, budget vs actual, ideal COGS, profitability trends, GL | pnl-cron, live-store-pnl (narrow) | **Gap — high value** |
| **Labor** | Schedule vs budget, actual vs schedule, labor metrics, payroll import | Full Paycor labor, optimizer, tips, schedule-alerts | **Pulse ~even/ahead** |
| **Cash Mgmt / Loss Prevention** | Safe count, deposit lifecycle, tender exceptions, bank-deposit exceptions, LP trends | Cash Mgmt + Safe Audit + reconciliation + POS-negative | **Pulse ~even** |
| **Inventory** | Theoretical-vs-actual variance, waste $, bakery (donut) analytics, product outage | food-cost (narrow) | **Gap — high value** |
| **Purchasing** | PO, invoices, payments, PAR levels, DCP forecast, vendors, credit requests | none | **Gap — big** |
| **Prep** | Production/prep planning (how much to make) | none | **Gap — medium** |
| **Book** (ops core) | Digital checklists, brand compliance, **food-safety temp checks**, merchandising, screening, region compliance | Task Manager (shallower) | **Gap — deepen** |
| **Corrective Action** | 15,580 **auto-CAPs from failed temp/task checks** → assign/close | Audit CAPs (manual) | **Gap — automate** |
| **Audit** | My/Team/Validation audits + Action Plans + Form Builder | Field Ops + Safe Audit + CAP | **Pulse ~even** (add custom forms) |
| **People** | Skills/cert matrix (Existing/Expiring/Untrained/Expired), training, learning paths | none | **Gap — medium** |
| **GiSMo** | Complaints/guest cases: Pareto, resolution analytics, abuse report, guest feedback | Complaints/Case Watch (Ahmed) | **Pulse ~even** (add analytics) |
| **Desk** | Help-desk/vendor/maintenance ticketing | Maintenance tickets | **Pulse ~even** |
| **WOW** | Employee recognition/points/leaderboard | none | **Gap — low/fun** |
| **Knowledge + Content Hub** | KB (382 articles) + CMS authoring/publish | KB (kb-search/embed/sync) | **Pulse ~even** (add CMS UI) |
| **Unified Plan** | Workflow automation (action center + configurable workflows) | crons (hardcoded) | **Gap — platform** |
| **Report Center** | Report catalog + **scheduled subscriptions** + favorites | reports-backup only | **Gap — medium** |
| **System Health** | Data-feed health (Sales/Labor) monitoring | crons, no dashboard | **Gap — quick win** |
| **Integration** | Bank-file import + transaction mapping (bank recon), POS/payroll feeds | reconciliation (partial) | **Gap — medium** |
| **Admin** | Users (2,154), org hierarchy, locations, **Form Builder**, Report Scheduler | Users/roles admin | **Pulse ~even** (add form builder) |

---

## 3. What to BUILD — prioritized (and how to do it BETTER than Workpulse)

### TIER 1 — highest ROI, fits the 1-week sprint
1. **Inventory & Waste + Theoretical-vs-Actual Variance**
   - Workpulse: separate module, manual counts, dense tables.
   - **Better:** wire it to data Pulse already pulls (POS menu mix + food-cost recipes/BOM) so *theoretical* usage is auto-computed; manager enters only actual counts on mobile. Bakery/donut variance and product-outage flags surfaced by Orion, not buried in a report.
2. **Financial: Flash P&L + P&L Scorecard + Budget-vs-Actual**
   - Workpulse: static GL-driven P&L.
   - **Better:** live daily flash P&L from Pulse sales + Paycor labor + food-cost + fixed-cost config, per store/district, with Orion narrating variances. Pulse already has pnl-cron — extend, don't restart.
3. **Food-Safety Temp Checks → Auto Corrective Actions**
   - Workpulse: Book temp checks → 15,580 CAPs.
   - **Better:** Bluetooth-probe/manual temp entry on the manager mobile view; out-of-range auto-creates a CAP in the *existing* Pulse CAP system (reuse Safe/Field audit CAP lifecycle) with push to RGM+DM. One CAP engine, not two.
4. **System Health dashboard** (quick win, ~half day)
   - Surface every cron's last-run + per-store feed freshness (Pulse/Paycor/etc.) — you already hit the Paycor-token pain twice; this makes silent failures visible.

### TIER 2 — weeks 2-3
5. **Sales reporting depth:** daypart, tender-type, revenue-center, sales-by-time heatmap, product mix, menu analysis, 3rd-party-delivery breakout, sales comps. Mostly new views over data Pulse already has.
6. **Purchasing / Ordering:** PAR levels, POs, invoice capture, vendor list, DCP order forecast. Biggest net-new; start with PAR + order guide.
7. **People / Skills & Certifications:** skills matrix (Existing/Expiring/Untrained/Expired), cert expiry alerts (ties to your Fleet/Food-License reminder pattern), training/learning paths.
8. **Report Center:** scheduled report subscriptions (email/PDF) + favorites — leverage existing PDF/report builders.

### TIER 3 — roadmap / nice-to-have
9. **Prep planning** (forecast → prep sheet). 10. **Unified Plan-style workflow builder** (generalize crons into configurable rules). 11. **Form Builder** (custom audit/task forms vs. hardcoded). 12. **Bank-file reconciliation** (import + auto-match to POS). 13. **WOW recognition/points.** 14. **Content Hub CMS UI** for the KB. 15. **Complaints analytics** (Pareto/abuse/resolution) on top of Case Watch.

---

## 4. Where Pulse is ALREADY AHEAD (do NOT rebuild — these are your moat)
- **Orion AI analyst** — DM briefs, anomaly detection, NL Q&A, KB-grounded answers. Workpulse has **zero AI**. This is your biggest differentiator; lean into it as the connective tissue across every new module.
- **Construction / Projects** — 7-phase pipeline, Philly zoning/permits/violations/311, contractor roster. Workpulse has **nothing**.
- **Real-time Ops Map, Chat (per-store/district + DMs), Competitive Intelligence, weather correlation, reviews sentiment, Deal Pipeline.**
- **It's yours & free** — Workpulse is per-store/month SaaS. Every module you fold in removes a recurring cost and a data silo.

---

## 5. Proposed 1-week sprint (Tier 1) — realistic
- **Day 1:** System Health dashboard (quick win) + design/spec Inventory-variance and Flash-P&L data models.
- **Day 2-3:** Inventory & Waste + theoretical-vs-actual variance (mobile actual-count entry, auto-theoretical from menu mix + recipes).
- **Day 3-4:** Flash P&L + P&L Scorecard + budget-vs-actual (extend pnl-cron), Orion variance narration.
- **Day 5:** Food-safety temp checks → auto-CAP into existing CAP engine, mobile entry + alerts.
- Each shipped via our proven flow: brainstorm → spec → plan → subagent build w/ review → verify → deploy. Version bumps continue from v20.00.

---

## 6. Open questions for Mike (before we start building)
1. **Sprint scope:** all four Tier-1 items, or your pick of the top 2-3?
2. **Inventory counts:** do stores currently count manually / in Workpulse? Where does actual-usage data come from?
3. **Purchasing:** are you on National DCP ordering — is there an API/feed, or is this manual today?
4. **Kill Workpulse eventually, or run in parallel?** (affects whether we need feature-parity or just best-of.)
5. **Who are the end users per module** — RGMs (mobile), DMs, office, exec? Drives mobile-first vs desktop.
