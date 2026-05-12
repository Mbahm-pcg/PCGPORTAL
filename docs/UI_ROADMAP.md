# PCG Portal — UI / UX Improvement Roadmap

**Started:** May 12, 2026  
**Engineer:** Ahmed Bhuiyan  
**Status:** In progress  
**Version:** All UI changes in this roadmap stay on **v5.76**

---

## Priority Legend
- 🔴 High — visible roughness, affects daily use
- 🟡 Medium — noticeable but not blocking
- 🟢 Low — polish pass, nice to have

---

## 1. Dashboard ← Current Focus

| # | Item | Priority | Status |
|---|------|----------|--------|
| 1.1 | Standardize section headers — one consistent divider/label pattern across all sections | 🔴 | Pending |
| 1.2 | Quick Actions — replace large card grid with compact horizontal chip strip | 🟡 | Pending |
| 1.3 | KPI cards — tighten padding, reduce height slightly, add trend delta (vs yesterday) | 🟡 | Pending |
| 1.4 | Pending Tasks section — cleaner row layout, better empty state | 🟡 | Pending |
| 1.5 | Links section — visual hierarchy improvement, group labels cleaner | 🟢 | Pending |
| 1.6 | Announcements — unread badge, cleaner dismiss interaction | 🟢 | Pending |
| 1.7 | News feed tabs — cleaner tab style consistent with rest of app | 🟢 | Pending |

---

## 2. Sidebar / Navigation

| # | Item | Priority | Status |
|---|------|----------|--------|
| 2.1 | Active tab indicator — thicker left bar, stronger contrast | 🔴 | Pending |
| 2.2 | Tab icon + label alignment — tighten gap, consistent sizing | 🟡 | Pending |
| 2.3 | Notification badge — clean pill style, cap at 99+ | 🟡 | Pending |
| 2.4 | Version footer — smaller, better muted treatment | 🟢 | Pending |

---

## 3. Labor Tab

| # | Item | Priority | Status |
|---|------|----------|--------|
| 3.1 | Store grid — color-coded labor % bars instead of plain text | 🔴 | Pending |
| 3.2 | KPI cards — match dashboard card style (currently slightly different) | 🟡 | Pending |
| 3.3 | Drill-down chart — axis labels cleaner, tooltip polish | 🟡 | Pending |
| 3.4 | Employee panel — clock-in status chips cleaner | 🟢 | Pending |

---

## 4. Pulse Tab

| # | Item | Priority | Status |
|---|------|----------|--------|
| 4.1 | Store grid cards — performance delta vs yesterday more prominent | 🔴 | Pending |
| 4.2 | Hourly sales chart — cleaner tooltip, better axis | 🟡 | Pending |
| 4.3 | District detail — header section cleanup, section dividers | 🟡 | Pending |
| 4.4 | Progress bar during load — smoother, store count label | 🟢 | Pending |

---

## 5. Global / System-wide

| # | Item | Priority | Status |
|---|------|----------|--------|
| 5.1 | Card shadow consistency — some cards use heavy shadow, some none | 🔴 | Pending |
| 5.2 | Input field style — border radius and height inconsistent across tabs | 🟡 | Pending |
| 5.3 | Modal backdrops — blur + dark overlay consistent everywhere | 🟡 | Pending |
| 5.4 | Empty states — consistent illustration/icon + message pattern | 🟡 | Pending |
| 5.5 | Button sizing — primary vs secondary vs ghost, standardize heights | 🟢 | Pending |
| 5.6 | Fade-in animation — some sections animate, some don't | 🟢 | Pending |

---

## Completed

| # | Item | Version |
|---|------|---------|
| — | Users edit page: blurred bg, role colors, instant scroll restore | v5.74 |
| — | Dashboard adaptive layout, notification bell scoping | v5.72 |
| — | Ticket form overhaul | v5.71 |

---

## Notes

- All inline `style={{}}` — no CSS framework. Changes are surgical, no global CSS.
- Dark + Light theme: every change must work in both. Test both before marking done.
- Mobile: `isMobile` prop available on all major components. Check at 375px width.
- Version bump required on every change (`v5.XX` in sidebar footer, `app.jsx`).
