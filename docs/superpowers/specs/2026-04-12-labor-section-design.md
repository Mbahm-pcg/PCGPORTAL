# Labor Section — Design Spec

## Overview

A new "Labor" tab in the PCG Portal that cross-references Paycor payroll/timecard data with Pulse POS sales data to provide real-time labor cost visibility across all 45 stores. Shows labor dollars, labor percentage vs sales, overtime alerts, and drill-down by store with hourly/daily/weekly breakdowns.

## Architecture: Hybrid Cron + Live

### Cron Layer (labor-cron.js)

Scheduled Netlify function, runs every 4 hours (6am, 10am, 2pm, 6pm, 10pm, 2am ET).

**Per store (batched 8 at a time):**
1. Fetch employees + pay rates from Paycor (`/v1/legalentities/{id}/employees`, `/v1/employees/{id}/payrates`)
2. Fetch today's punches from Paycor (`/v1/legalentities/{id}/punches`)
3. Pull today's sales from Pulse (`getOperationsDailyTotals` via `netSales`)
4. Compute: labor $ (hours x rate), labor %, employee count, overtime flags
5. Handle salaried employees: bi-weekly pay / 12 days = daily labor cost

**Storage (Netlify Blobs):**
- `pcg_labor_v1` — network summary + all store summaries (dashboard reads this)
- `pcg_labor_store_{pc}` — per-store daily/weekly history (drill-down historical views)

### Live Layer (paycor.js updates)

Two new actions added to `paycor.js`:
- `punches` — `/v1/legalentities/{id}/punches` with date range filter
- `schedules` — `/v1/legalentities/{id}/schedules` with date range filter

Used when a user drills into a specific store for real-time data. Only 2-3 API calls per store.

### Salary Calculation

Salaried employees (managers) detected by `payType: "Salary"` from Paycor pay rate records.
- Take bi-weekly pay amount, divide by 12 (6 days/week x 2 weeks) for daily labor cost
- All managers assumed to work 6 days/week
- If punch data exists, use punches to determine days worked; otherwise assume Mon-Sat
- Daily cost added to store's labor $ regardless

## Data Structures

### Blob: pcg_labor_v1

```json
{
  "lastUpdated": "2026-04-12T14:00:00Z",
  "network": {
    "laborDollars": 58420,
    "sales": 213890,
    "laborPct": 27.3,
    "totalEmployees": 412,
    "employeesOnClock": 189,
    "overtimeCount": 14
  },
  "stores": {
    "339616": {
      "name": "Wadsworth",
      "district": 1,
      "paycorId": "193919",
      "today": {
        "laborDollars": 1240,
        "sales": 5148,
        "laborPct": 24.1,
        "employees": 12,
        "employeesOnClock": 8,
        "hoursWorked": 86.5,
        "overtimeCount": 1
      },
      "wtd": {
        "laborDollars": 8420,
        "sales": 34200,
        "laborPct": 24.6
      },
      "daily": [
        {
          "date": "2026-04-12",
          "laborDollars": 1240,
          "sales": 5148,
          "laborPct": 24.1,
          "hoursWorked": 86.5
        }
      ]
    }
  }
}
```

### Blob: pcg_labor_store_{pc}

```json
{
  "lastUpdated": "2026-04-12T14:00:00Z",
  "weekly": [
    {
      "weekOf": "2026-04-06",
      "laborDollars": 8420,
      "sales": 34200,
      "laborPct": 24.6,
      "avgDailyEmployees": 11
    }
  ],
  "daily": [
    {
      "date": "2026-04-12",
      "laborDollars": 1240,
      "sales": 5148,
      "laborPct": 24.1,
      "hoursWorked": 86.5,
      "employees": [
        {
          "employeeId": "abc123",
          "name": "John Smith",
          "role": "Crew Member",
          "payType": "Hourly",
          "payRate": 13.50,
          "hoursToday": 7.5,
          "hoursThisWeek": 38.5,
          "costToday": 101.25,
          "overtime": false
        }
      ]
    }
  ]
}
```

## UI Components

### Navigation

- New "Labor" sidebar tab with dollar-sign icon
- Positioned after Analytics in nav order
- Visible to: Executive, IT, Office Staff, District Managers

### Access Control

| Role | Stores Visible | Employee Detail | Network Totals |
|------|---------------|-----------------|----------------|
| Executive / IT / Office | All 45 | Yes | Yes |
| District Manager | Their district only | Yes (their district) | No (district totals only) |

### Dashboard Landing — Summary Bar + Store Grid

**Top Summary Bar (4 KPI cards):**
- Total Labor $ (today)
- Avg Labor % (weighted: total labor $ / total sales $)
- Total Sales $ (today)
- Employees On Clock

Each shows delta vs same day last week (arrow + %).

**Filter Row:**
- Time toggle: Today | This Week | Custom Date Range
- District filter: All | D1-D8 (locked for DMs to their district)

**Store Grid:**
- Responsive grid: 3 cols desktop, 2 tablet, 1 mobile
- Each card: store name, labor $, labor %, sales $, employee count
- Overtime indicator on card: "3 OT" badge in red if store has OT employees
- Left border color-coded by labor %:
  - Green: 22.9% and under
  - Yellow: 23.0% - 25.9%
  - Red: 26.0% and above
- Default sort: labor % descending (worst first)
- Click card to drill into store

**Meta:**
- "Last updated: Xh ago" with manual refresh button
- Reads from `pcg_labor_v1` blob (instant load)

### Store Drill-Down

**Store Header:**
- Store name, district, manager
- Today's KPIs: Labor $ | Labor % | Sales $ | Employees on clock
- Back arrow to dashboard

**Time Breakdown Tabs: Hourly | Daily | Weekly**

**Hourly View (default):**
- Bar chart: labor $ vs sales $ per hour (5am-10pm)
- Each bar color-coded green/yellow/red by that hour's labor %
- Table below with per-hour numbers: hour, labor $, sales $, labor %, employees on clock
- Data source: live Paycor punches + Pulse guest checks (by `opnUTC` hour)

**Daily View:**
- Current week Mon-Sun
- Each day: labor $, sales $, labor %, total hours worked
- Mini bar chart or sparkline showing week trend

**Weekly View:**
- Last 8 weeks from cron cache
- Weekly totals: labor $, sales $, labor %, avg daily employees
- Trend line for labor % over time

**Employee Panel:**
- Visible to all roles (scoped by access — DMs see their district only)
- Expandable section: "Employees (12)"
- Columns: name, role, clocked-in time, hours today, hours this week, pay rate, cost today
- Sorted by hours worked descending

### Overtime Alerts

- 35-39.99 weekly hours: yellow warning badge, label "Approaching OT"
- 40+ weekly hours: red overtime badge, cost recalculated at 1.5x rate for hours over 40
- Overtime employees sort to top of employee panel
- Store card on dashboard shows "X OT" count badge
- OT cost shown separately in employee panel (regular cost + OT cost)

## Error Handling

- **Paycor token expired / API down:** Dashboard loads from last cached data. Banner: "Paycor data may be stale — last sync: [time]"
- **Single store fetch failure on drill-down:** Show cached data with note, retry button
- **Pulse sales unavailable for a store:** Show labor $ but labor % displays "—"
- **No punch data for salaried employee:** Use 6 days/week assumption, calculate daily cost from bi-weekly rate / 12

## Refresh Strategy

- Cron: every 4 hours, all 45 stores batched 8 at a time
- Manual refresh button on dashboard: re-runs cron logic on demand
- Store drill-down: always live from Paycor (2-3 API calls)
- Rate limit budget: ~200 calls per cron run, well under 1000/min limit

## Labor % Thresholds

| Color | Range | Meaning |
|-------|-------|---------|
| Green | 0% - 22.9% | On target |
| Yellow | 23.0% - 25.9% | Watch |
| Red | 26.0%+ | Over budget |
