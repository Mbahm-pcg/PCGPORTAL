# PCG Ops Task & Checklist System — Plan

**Status:** Planning · Created 2026-06-17
**Owner:** Ahmed (IT) · Sponsor: Mike & Krunal (Exec/VP)
**Goal:** A portal-native scheduled-task + checklist + corrective-action system for store
Managers, District Managers, and Execs — **fully independent of Workpulse**, so the
company can decommission Workpulse without losing functionality or data.

---

## 1. Strategic Decision (locked)

**Build our own — do NOT integrate Workpulse APIs.**

VP direction: the company plans to move **off** Workpulse; access to Workpulse APIs may
go away in the future. Therefore:

- ❌ No new dependency on `api.workpulse.com` (no Tasks API integration, even if one exists).
- ✅ Every feature lands in **our** Neon Postgres on **our** Netlify infra.
- ✅ The day Workpulse is dropped, nothing here breaks.

> The existing `Workpulse_Dunkin` / `Workpulse_Order` / `Workpulse_Ticket` keys are a
> **separate** topic (NDCP order data + Belltower tickets). They are not part of this system.

**Path:** Option B (build native) now → Option C (full Workpulse task-engine replacement) over phases.

---

## 2. Core Requirements (from the user)

1. **Mobile-first.** Managers and DMs live on their phones — the UI must work properly on phone first, desktop second. (Portal is already a PWA / installable.)
2. **Cross-device sync.** When store 332941's manager completes a checklist, DM7 sees it on her phone and Execs see it on their devices — same data, all roles, near-real-time.
3. **Role-scoped views:**
   - **Manager** → their store only (complete tasks).
   - **DM** → their district's stores (monitor roll-up). *(332941 → Bustleton → District 7 → DM7)*
   - **Exec / IT** → all 45 stores (org roll-up).
4. **Integrated into the existing portal** (new tab), not a separate webapp — reuses auth, roles, store config, push, theming, deploy.
5. **Exec/IT template admin ("Book Task").** Exec/IT must be able to manage the task catalog:
   - **Assign locations** per task (which of the 45 stores a task applies to).
   - Toggle **Active / Inactive** status.
   - Set **Category**, **Task Label**, **Task Type** (Shift / General), **Master Task**,
     **Assigned Roles**, and **Allow Manager & PCQI Sign-Off**.
   - This is the system of record for *what tasks exist and where* — managers/DMs only
     consume the resulting scheduled instances.

---

## 3. Reference Model (reverse-engineered from the Workpulse screenshots)

The Workpulse task app shows the target feature set. Four layers:

### 3a. Task Definitions ("Book Task" admin — ~229 templates)
Columns observed: `Task Name`, `Task Type` (Shift), `Category`, `Task Label`,
`Assigned Locations`, `Assigned Roles`, `Master Task`, `Allow Manager & PCQI Sign-Off`, `Status` (Active).

- **Task Type:** two kinds —
  - **Shift** — tied to a shift time (1 AM / 5 AM / 9 AM / 1 PM / 5 PM / 9 PM; also AM/Noon/PM).
  - **General** — recurring-interval, e.g. Master Sanitation "every 3 / 6 / 7 / 14 / 30 / 60 / 72 days".
- **Categories seen (full list):** Cold Holding, Hot Holding, Cooking Temp, Dairy Dispenser,
  Sugar Dispenser, Flavor Shot Dispenser, Frozen Beverage, Hot Beverage, Ice Coffee, Espresso,
  Sanitizer, Merchandising, Manager Checklist, Backroom Checklist, Exterior Checklist,
  Dining Room, Rest Room Checklist, Food Prep Checklist, Queuing Area Checklist,
  Service Area Checklist, Safety Checklist, Master Sanitation, Receiving Log,
  Thermometer Calibration, Health & Wellness, Miscellaneous.
- **Task Labels seen:** Food Safety, Facility, Fresh, Planning Checklist.
- **Allow Manager & PCQI Sign-Off:** per-task flag (e.g. "Hot Holding" has it enabled).
- **Assigned Locations:** a count per task, ranging 0 → 51. *(Note: 51 > 45 stores — Workpulse
  may count Baskin-Robbins combo units or additional location records separately. Confirm the
  true location universe before seeding — see Open Questions.)*
- **Status:** Active / Inactive (e.g. "Food Prep Areas Checklist(Noon)" and
  "Service Area Checklist(Noon)" are Inactive).
- **Shift times seen:** 5 AM / 9 AM / 1 PM / 5 PM (also 1 AM / 9 PM, and Daily / Weekly / Noon variants).

### 3b. Task Instances ("Tasks" tab)
Definitions scheduled per **store + date + shift**. Each instance has a completion **%**
and a state. Example: store 351050 on 06/15 → **18 Open / 17 Missed / 39 All**.
- States: **Open, Missed, Overdue, Completed** (+ "All").
- Some are simple checklists (Manager Daily Task Checklist, Backroom Checklist).
- Some are **measurements** with target + range, e.g.
  *"Bottom Temperature — 53°F (35.0–41.0°F | Target 37°F)"*.

### 3c. Corrective Actions
When a measurement is out of range → a corrective action is created.
- Fields: title, location (store-station, e.g. `304669-CH01`), measured value vs range/target,
  due date, status (Open), assignee (e.g. RGM), age ("5 hrs ago"), flag + voice-note icons.
- Scale: ~14,559 org-wide in the reference app.

### 3d. Roll-ups (Dashboard + Reports)
- **Dashboard:** per store + date, totals (Open / Overdue / Completed / All + %), broken
  down by category (e.g. Cold Holding 6 open / 11 overdue / 20 all).
- **Reports:** Daily Progress, Task Dashboard, Merchandising.

---

## 4. Proposed Architecture

**Integrate into existing portal** (new tab), Postgres-backed, mobile-first, role-scoped.

### Data model (Neon Postgres — new tables)
```
task_templates
  id, name, type ('shift'|'daily'|'weekly'), category, label,
  input_type ('checklist'|'temperature'|'weight'|'photo'|'count'),
  target, min_val, max_val, unit,         -- for measurement tasks
  shift_times text[],                     -- e.g. ['05:00','09:00','13:00','17:00']
  assigned_roles text[],                  -- who can complete
  allow_signoff bool,                     -- Manager & PCQI sign-off
  is_master bool, active bool, created_by, created_at

task_template_locations
  template_id, store_pc                   -- which stores; or a flag for "all 45"

task_template_items                       -- checklist sub-items (for checklist type)
  id, template_id, label, sort_order, requires_photo

task_instances                            -- generated per template+store+date+shift
  id, template_id, store_pc, business_date, shift_time,
  status ('open'|'completed'|'missed'|'overdue'),
  pct, completed_by, completed_at, signed_off_by, signed_off_at

task_instance_results                     -- per-item / per-reading completion
  id, instance_id, item_id, checked bool, value numeric, photo_url, note, by, at

corrective_actions
  id, instance_id, store_pc, station, title, description,
  measured_value, target, min_val, max_val,
  assignee, due_date, status ('open'|'resolved'),
  resolved_by, resolved_at, photo_url, voice_url, created_at
```

### Instance generation
- Scheduled Netlify function (cron, ~per store start-of-day) reads active templates and
  **generates that day's `task_instances`** per store/shift. Mirrors the existing
  cron pattern (labor-cron, pulse-cron). Overdue/missed transitions handled by the same job.

### Sync model (no WebSockets — Netlify limitation)
- Source of truth: Postgres.
- Manager completes item → POST to function → write → optimistic UI on phone.
- DM/Exec views **poll every ~20–30s** while open (existing pattern).
- **Push notification** (existing VAPID infra) on key events: checklist completed, corrective
  action created/overdue.
- ~30s freshness is the right bar here; true real-time not required.

### Roles / gating
- Reuse `userType`: `manager` (own store), `dm` (district filter), `executive`/`it` (all 45).
- Store→district→DM mapping already exists (`STORES_SEED`).

### Frontend
- New tab in `getTabs()` + component in `app.jsx`, gated by role.
- Mobile-first layout (phone-first), reuse `src/theme.js` helpers, design tokens.
- Manager: today's tasks, % rings, tap-to-complete, temp entry, photo capture.
- DM/Exec: store grid + category roll-up dashboard (like the reference Dashboard tab).

---

## 5. Phased Rollout

| Phase | Scope | Proves |
|-------|-------|--------|
| **1. Manager Daily Task Checklist** | One checklist template, checkbox items, mobile complete → DM7 + Exec roll-up view. Postgres tables + 1 read/write function + polling. | The mobile + cross-device sync pattern end-to-end. |
| **2. Template engine** | "Book Task" admin (create/edit templates), categories, labels, shift times, assigned locations/roles, daily instance-generation cron. | Scheduled instances per store/shift, multi-template. |
| **3. Measurements + Corrective Actions** | Temperature/weight tasks with target/range; out-of-range auto-creates a corrective action; assignee + due date + resolve flow. | Food-safety core + corrective-action engine. |
| **4. Dashboards + Reports** | Per-store/category roll-ups (Open/Overdue/Completed/%), Daily Progress + Task Dashboard reports, push alerts. | Exec/DM monitoring parity. |
| **5. Sign-off + parity + cutover** | Manager & PCQI sign-off, photo/voice attachments, full template parity (~229), then **decommission Workpulse tasks**. | Full replacement (Option C). |

---

## 6. Open Questions

- [ ] **Phase 1 checklist content** — what items are on the "Manager Daily Task Checklist"? (Need the actual list.)
- [ ] **Cadence/reset** — daily reset at store open? What time zone / business-day cutoff per store?
- [ ] **Shift times** — standardize on 5 AM / 9 AM / 1 PM / 5 PM, or per-store?
- [ ] **Who authors templates** — Exec/IT only, or DMs too?
- [ ] **Corrective action assignee** — always the store RGM, or routable to DM/Maintenance?
- [ ] **Photo/voice** — required in Phase 1, or defer to Phase 5? (Portal already has chunked photo upload.)
- [ ] **Existing portal tickets** — does a corrective action also create a Maintenance ticket (existing `tickets` table)? Or stay separate?
- [ ] **History/audit** — retention of completed instances for reporting (how far back).
- [ ] **Location universe** — Workpulse shows assigned-location counts up to 51; reconcile against
      our 45 `STORES_SEED` stores (Baskin combo units? extra records?) before seeding.
- [ ] **Catalog seed** — best to get the full ~229-task catalog as a **CSV/export** from Workpulse
      (Task Name, Type, Category, Label, Assigned Locations, Roles, Master, Sign-off, Status)
      rather than transcribing screenshots, to avoid typos. Appendix A is the working reference.

---

## 7. Why integrate (not a separate webapp)

Everything this needs already exists in the portal: role gating (`manager`/`dm`/`executive`),
mobile modes, Neon Postgres, VAPID push, PWA install, `STORES_SEED` district mapping, theming,
single deploy. A separate app would duplicate all of it **and** require a cross-app auth/data
bridge — for zero benefit. One portal, one login, one data layer.

---

## Appendix A — Task Catalog (reverse-engineered from Workpulse, ~229 tasks)

Working reference only — **seed from an authoritative CSV export**, not this list. Grouped by
category; shift-timed tasks abbreviated as (times). "Loc" = assigned-location count where visible.

**Cold Holding (Food Safety)** — most are 5 shift-times (1/5/9 AM, 1/5 PM) ± 9 PM:
Walkin Cooler · Walkin Freezer · Walkin Freezer Combo · Reachin Cooler · Reachin Freezer ·
Reachin Freezer Combo · Sandwich Station · Pepsi Cooler · Milk Cooler · Hash Brown Freezer ·
Flash Freezer · TAPS · Baskin Dessert Case · Baskin Dipping Cabinet · Baskin Hardening Cabinet ·
Baskin Reachin Cooler

**Hot Holding (Food Safety):** Hot Holding (sign-off ✓) · Steam Table (shifts) · Baskin Hot Topping Warmer (shifts)

**Hot Beverage (Fresh):** High-Volume & Axiom Calibration · Hot (High Volume Brewer) Calibration ·
Hot (HV Single Brewer) Calibration · Hot Winter Beverage Temp (Weekly) · Single Brewer Vol. & Temp. ·
Single Grind Weight · Soft Heat High Volume Grind · Softheat HV Double Brewer · Softheat HV Single Brewer ·
Dual Brewer Vol. & Temp. (Large/Medium/Small) · Dual Grind Weight (Large/Medium/Small) · Cold Brew TDS

**Ice Coffee (Fresh):** Iced Coffee Brewer Vol. & Temp. · Iced Digital IC3 Brewer Measurements · Iced Infused Series Brewer Vol. & Temp.

**Espresso (Fresh):** Espresso Cleaning · Espresso Measurements · Espresso Shot Time (Coffee Art / WMF) ·
Espresso Vol. & Temp. Coffee Art (Lg/Med/Sm) · Espresso Vol. & Temp. WMF (Lg/Med/Sm)

**Frozen Beverage (Fresh):** Island Oasis Ice Calibration · Island Oasis Weight Calibration ·
Coolatta Neutral Dual Unit (shifts) · Coolatta Neutral Single Unit (shifts) · Vitamix Cleaning (Food Safety)

**Sugar / Flavor Dispensers (Fresh):** Sugar Dispenser · Island Oasis Liquid Sugar Bag (shifts) ·
Sure Shot Flavor Dispenser · Taylor Flavor Dispenser

**Dairy Dispenser (Fresh):** Dairy Dispenser Temp (shifts) · Dairy Dispenser Weight (Daily/Weekly)

**Cooking Temp (Food Safety):** Daily Product Cooking Temp. · Weekly Product Cooking Temps.

**Sanitizer (Food Safety):** Sanitizer (shifts)

**Merchandising (Fresh):** Donut Merchandising (10 AM / 2 PM / 8 PM) · Baskin Cake Freezer Merchandising (shifts) · Baskin Dipping Cabinet Merchandising (shifts)

**Checklists (Planning Checklist / Facility):** Manager Daily Task Checklist · Backroom Checklist (AM/Noon/PM) ·
Food Prep Areas Checklist (AM/Noon/PM) · Dining Room Checklist (AM/Noon/PM) · Service Area Checklist (AM/Noon/PM) ·
Queuing Area Checklist (AM/Noon/PM) · Safety & Security Checklist (Weekly) · Safety Inspection Checklist ·
Product Quality Spot Check · Food Safety Checklist (Daily) · Building Exterior & Landscaping · Exterior Checklist (AM/Noon/PM)

**Rest Room Checklist (Facility):** Mens / Womens / Unisex / Employee Rest Rooms Checklist (AM/Noon/PM)

**Master Sanitation (General — recurring):** Schedules every 3 / 6 / 7 / 14 / 30 / 60 / 72 days

**Other:** Thermometer Calibration · Receiving Log · Headset Inventory · Hot Water Dispenser Temp. ·
Dish Washing Machine · Employee/Location/Workplace Health & Wellness

> Some tasks are **Inactive** (e.g. Food Prep Areas Checklist(Noon), Service Area Checklist(Noon)).
> Sign-off enabled observed on: Hot Holding. Assigned-location counts vary 0→51 per task.
