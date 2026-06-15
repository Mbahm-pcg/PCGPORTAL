# Locations → Tools → "Closest To" finder — Design

**Date:** 2026-06-15
**Status:** Approved (design), pending spec review
**Section:** Locations tab (`AdminLocations`, app.jsx ~line 3607)

## Goal
Add an extensible **Tools ▾** menu to the Locations tab. Its first tool, **"Closest to an address,"** opens a popover with a map of all store locations and a ranked list of the 10 stores nearest a user-entered address.

## User flow
1. In the Locations tab, the user clicks **Tools ▾** → dropdown opens.
2. User picks **"Closest to an address."** → a `Modal` popover opens.
3. User types an address and hits **Find** (or Enter).
4. The address is geocoded; the map drops a pin for it and the list ranks the 10 nearest stores by straight-line distance — instantly.
5. For any listed store, the user clicks **"Drive time"** to fetch real road distance + time on demand.

## Architecture & components
- **Tools registry** (new): `const LOCATION_TOOLS = [{ id, label, icon, render }]`. The `Tools ▾` dropdown maps over this array, so adding a future tool is one entry. Only entry now: `closest-to`.
- **`Tools ▾` button + dropdown**: rendered in the `AdminLocations` header. Lightweight open/close `useState`; closes on outside click / Escape.
- **`ClosestToTool` component** (new, rendered inside `Modal`):
  - State: `address`, `origin` (`{lat,lng}|null`), `ranked` (array), `driveTimes` (`{[pc]: {mi,min}}`), `busy`, `status`.
  - **Geocode**: reuse `POST /.netlify/functions/geocode` `{address}` → `{matched,lat,lng}`.
  - **Ranking**: `haversineMiles(origin, STORE_COORDS[pc])` for all 45 stores; sort ascending; take 10.
  - **Map**: reuse the app's existing Leaflet loader. Marker per store (all 45); distinct pin for `origin`; the top-10 markers styled as highlighted; `fitBounds` to origin + nearest cluster. Clicking a marker highlights its list row and vice-versa.
  - **List**: 10 rows — store **name**, **address**, **straight-line miles**, and a **"Drive time"** action that populates `driveTimes[pc]` inline (e.g. `7.0 mi · ~13 min driving`).

## Drive-time on click (new Netlify function)
- **`netlify/functions/drive-time.js`** — proxies **OSRM** (`router.project-osrm.org`, free, no key). Input `{ from:{lat,lng}, to:{lat,lng} }`; returns `{ miles, minutes }` (distance/1609.344, duration/60). Server-side so the provider is swappable (e.g. Google Directions later) and to avoid client CORS/rate issues. Fail soft: on error return `{ error }` and the UI shows "—".

## Data sources (all already in the codebase)
| Need | Source | Status |
|------|--------|--------|
| Store marker coordinates | `STORE_COORDS` (app.jsx ~2711) | exists, all 45 |
| Address → lat/lng | `/.netlify/functions/geocode` | exists (Impact Radar uses it) |
| Straight-line distance | `haversineMiles` (`src/impact.mjs`) | exists |
| Map | Leaflet (already loaded) | exists |
| Popover | `Modal` helper | exists |
| Drive distance/time | `drive-time.js` (OSRM) | **new** |

## Responsive
- Desktop: map left (~60%), list right (~40%) inside the Modal.
- Mobile (`< ~760px`): map on top, list below, vertical scroll.

## Error / edge handling
- Address not found → inline status "Couldn't find that address," no map pin, list unchanged.
- Geocode/drive-time network error → fail soft with a visible message; never crash the popover.
- Empty input → Find is a no-op.

## Out of scope (YAGNI)
- Address autocomplete, saving/recalling past lookups, PDF/export, additional tools, "directions" deep-links. The dropdown is built to accept future tools, but none are added now.

## Permissions
- Inherits the existing Locations-tab visibility (full admin / office / DM / manager / construction / maintenance). No new gating.

## Build notes
- Inline styles + theme helpers (`btn(th)`, `inp(th)`, `card(th)`), matching app conventions.
- Bump sidebar version on change; `npm run build` before deploy.
- Keep store coordinate data single-sourced from `STORE_COORDS` (do not duplicate).
