# District Alignment — Design Spec

## Purpose

A new tool, living inside the universal **Tools** hub (built 2026-09-16, reachable by every role), that lets exec/IT experiment with district groupings and DM assignments — "what if we moved this store to a different district / gave it a different DM" — without touching the real, live Locations/Users data. Everyone can view it; only exec/IT can edit it.

It grew out of the "Chain of Sync" reference page built earlier, but as a real in-app, editable tool rather than a static artifact.

## Explicit non-goal

**This tool never writes to `stores`, `users`, or any Locations/Admin data.** It has its own separate persisted copy. Reassigning a store or adding/removing a DM here has zero effect on the real org data, the real Locations tab, or any user's actual account. This is the single most important constraint on the whole feature — every implementation task should treat "did this touch `stores` or `users`" as a hard failure condition.

## Access

- **View:** every role (matches the Tools hub's own access model).
- **Edit** (reassign a store's draft district, add a draft DM, remove a draft DM): `isFullAdmin(user)` only (executive/it) — same check already used for the real Locations tab's most sensitive actions.
- Edit controls (drag/reassign UI, add/remove DM buttons) simply don't render for non-admin viewers; the underlying save action is also gated server-side by the same check (never trust the client-side hide alone).

## Data model

**New Netlify Blob: `pcg_district_alignment_v1`**

```json
{
  "stores": {
    "339616": { "district": 1, "dmName": "Taylor Cormier", "dmEmail": "taylor@peoplecapitalgroup.com" },
    "...": { }
  },
  "dms": [
    { "id": "d1", "name": "Taylor Cormier", "email": "taylor@peoplecapitalgroup.com", "district": 1 },
    "..."
  ],
  "seededFromLiveAt": "2026-09-17T00:00:00.000Z"
}
```

- **First load, no blob yet:** seed this structure directly from the current real `stores` array (`district`, `dmName`, `dmEmail` per store) and a derived `dms` list (one entry per distinct district number currently in use). Save it immediately so the seed is stable going forward.
- **Every subsequent load:** read the draft blob as-is. It does NOT re-seed automatically — once it exists, it only changes via explicit edits or an explicit "Reset to live data" action.
- **"Reset to live data" button** (exec/IT only): re-runs the seed step above, overwriting the draft with a fresh copy of the current real data. Requires a confirmation dialog (this discards any unsaved draft experimentation).

### Edit operations (exec/IT only, all write only to this blob)

1. **Reassign a store to a different draft district** — updates `stores[pc].district`. Does not touch `dmName`/`dmEmail` automatically; those follow the district's DM entry in `dms` for display purposes (computed at render time: look up `dms.find(d => d.district === stores[pc].district)`), not stored redundantly per store.
2. **Add a DM** — appends to `dms` with a name/email the admin types in (a draft-only person; does not need to correspond to a real Users account, though it may).
3. **Remove a DM** — removes their entry from `dms`; any store whose `district` matches that DM's district becomes "Unassigned" in the draft (district number stays, but no DM shown) until reassigned to a different existing DM or a new one is added for that district.

## Frontend

### Table

Same layout/columns as the Directory view (district-grouped, color-coded headers matching `DISTRICT_COLORS`, PC# / Legal Name / Property Name / Address / Asset Type / Manager / Store Email) — reusing that existing rendering approach — **plus**, per store row:

- **Net sales snapshot** — the most recent day's total from that store's `pcg_hourly_history_{pc}` entry (sum of `hours[].sales` for entries[0], the newest date). Label the exact date shown (e.g., "Net sales (9/16): $4,230") so it's clear this is a snapshot, not live.
- **Busy-hours bar** — a small inline bar chart, one bar per hour the store is open, height = that hour's average `sales` across the most recent 7 available `pcg_hourly_history_{pc}` entries (average, not single-day, to smooth out one unusually slow/busy day). A newer store with fewer than 7 days of history averages over however many days it actually has — never blocks the chart on a full 7 days existing. Hover/tap a bar shows the exact hour (e.g., "12 PM–1 PM") and its averaged sales figure.
- **Distance to nearest sibling store** — using `STORE_COORDS` + the Haversine formula, the closest other store *currently in the same draft district*, e.g., "1.8 mi to Front." Recomputes live as stores are dragged between districts in the draft.

### District-level summary

Per district header (or an expandable row under it): average and max pairwise distance between that district's stores — flags a district that's geographically spread too thin at a glance.

### Manager column

Uses the same live-lookup pattern already built for the real Directory (`storeMgrName`) — reads the REAL Users data for who the actual assigned manager is (this part is genuinely live, since a store's manager is a real person fact, not part of the district-alignment experiment). Only `district` and `dmName`/`dmEmail` come from the draft; `Manager` still reflects reality.

## Prerequisite data gap to close first

`STORE_COORDS` is missing two stores added this week: **Hatboro** (365953) and **Allentown GS** (345222, permanently closed — likely excluded from the alignment tool entirely, same as it's excluded from Pulse now, since a permanently closed store isn't part of any district-planning decision). Geocode Hatboro's address (256 South York Road, Hatboro, PA 19040) via the existing `geocode.mjs`/`geocode-suggest.mjs` function before the distance feature can cover every active store.

## Global constraints (for the implementation plan)

- Never write to `stores` or `users` from any action this feature adds.
- Edit actions require server-side `isFullAdmin` verification via the session token, not a client-trusted role flag (same pattern already used for Locations' sensitive writes).
- Reuse `DISTRICT_COLORS`, `storeMgrName`, and the Directory's table-rendering approach rather than re-implementing them.
- Reuse `pcg_hourly_history_{pc}` and `STORE_COORDS` as-is; do not stand up a new sales-data collection pipeline.
- Permanently closed stores (`status === 'Permanently Closed'`) are excluded from the alignment tool, consistent with their exclusion from Pulse.
