# Hexnode Maintenance Dispatch — Design Spec

**Date:** 2026-06-09
**Status:** Design review
**Plan ref:** `docs/superpowers/plans/2026-06-09-hexnode-dispatch.md`

---

## Mobile View — Maintenance Tech (Accept/Deny Card)

When a ticket is dispatched to a tech, tapping the push notification opens this full-screen card on their phone.

```
┌─────────────────────────────────────┐
│  PCG Portal           🔔  ⚙         │
├─────────────────────────────────────┤
│                                     │
│   🔧  NEW JOB REQUEST               │
│   ─────────────────────────────     │
│                                     │
│   Warrington                        │
│   337839  ·  District 2             │
│   📍 2.1 miles from you             │
│                                     │
│   ┌─────────────────────────────┐   │
│   │ PRIORITY    🔴  HIGH        │   │
│   │ CATEGORY    Equipment       │   │
│   │ REPORTED    Today 9:14 AM   │   │
│   └─────────────────────────────┘   │
│                                     │
│   Fryer #2 not heating. Unit        │
│   showing error code E-04.          │
│   Store opens at 5am, needs         │
│   resolution ASAP.                  │
│                                     │
│   ┌─────────────────────────────┐   │
│   │  ⏱  Respond within  08:42  │   │
│   └─────────────────────────────┘   │
│                                     │
│   ┌────────────┐  ┌────────────┐    │
│   │            │  │            │    │
│   │   ✓ ACCEPT │  │   ✗ DENY  │    │
│   │            │  │            │    │
│   └────────────┘  └────────────┘    │
│    (green)           (outlined)     │
│                                     │
│   [ View full ticket details ]      │
│                                     │
└─────────────────────────────────────┘
```

### On Accept
```
┌─────────────────────────────────────┐
│  PCG Portal                         │
├─────────────────────────────────────┤
│                                     │
│          ✅                         │
│                                     │
│   Job Accepted                      │
│                                     │
│   Warrington · Fryer #2             │
│                                     │
│   Est. arrival: ~5 min              │
│   Based on your current location    │
│                                     │
│   The store has been notified.      │
│                                     │
│   ┌─────────────────────────────┐   │
│   │  📍 Get Directions          │   │
│   └─────────────────────────────┘   │
│                                     │
│   ┌─────────────────────────────┐   │
│   │  📋 Open Ticket             │   │
│   └─────────────────────────────┘   │
│                                     │
└─────────────────────────────────────┘
```

### On Deny (reason picker)
```
┌─────────────────────────────────────┐
│  Reason for declining               │
├─────────────────────────────────────┤
│                                     │
│   ○  Too far away                   │
│   ○  Currently on another job       │
│   ○  Off duty                       │
│   ○  Not my specialization          │
│   ○  Other                          │
│                                     │
│   ┌─────────────────────────────┐   │
│   │        Confirm Deny         │   │
│   └─────────────────────────────┘   │
│                                     │
└─────────────────────────────────────┘
```

---

## Portal Admin View — Dispatch Map

Visible to IT, executive, and maintenance supervisors in the Maintenance tab.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Maintenance  ·  Dispatch Map                          [Live ● ]     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  LEGEND:  🟢 Available   🟡 On Job   🔴 Offline   📍 Open Ticket   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    [ MAP - Philadelphia Region ]               │  │
│  │                                                                │  │
│  │     🟢                          📍  Warrington               │  │
│  │   Mike T.                          HIGH · Fryer #2            │  │
│  │   0.3mi from Warrington            Dispatched 2 min ago       │  │
│  │                                                                │  │
│  │          🟡                    📍  Drexel Hill                │  │
│  │        Chris R.                    MED · Ice machine          │  │
│  │        On job @ Sonic                                          │  │
│  │                                                                │  │
│  │                    🔴                                          │  │
│  │                  Dave M.                                       │  │
│  │                  Offline 2h ago                                │  │
│  │                                                                │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  TODAY'S DISPATCHES                                             │ │
│  ├──────────┬────────────────┬───────────┬──────────┬─────────────┤ │
│  │  Time    │  Store         │  Tech     │  Dist    │  Response   │ │
│  ├──────────┼────────────────┼───────────┼──────────┼─────────────┤ │
│  │  9:14 AM │  Warrington    │  Mike T.  │  2.1 mi  │  ⏳ Pending │ │
│  │  8:02 AM │  Sonic         │  Chris R. │  0.8 mi  │  ✅ 1m 12s  │ │
│  │  7:45 AM │  Drexel Hill   │  Mike T.  │  3.4 mi  │  ✅ 3m 05s  │ │
│  │  6:30 AM │  Front         │  Dave M.  │  —       │  ❌ Escalated│ │
│  └──────────┴────────────────┴───────────┴──────────┴─────────────┘ │
│                                                                      │
│  Avg response time today: 2m 08s    Acceptance rate: 87%            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Tech Detail Drawer (click a tech pin)
```
┌────────────────────────────────────┐
│  Mike Torres          🟢 Available │
│  ────────────────────────────────  │
│  Last location: 9:18 AM            │
│  Near: Warrington (0.3 mi)         │
│                                    │
│  Today's jobs: 2 completed         │
│  Avg response: 1m 45s              │
│                                    │
│  DISTANCE TO OPEN TICKETS          │
│  📍 Warrington      0.3 mi  →      │
│  📍 Drexel Hill     4.1 mi  →      │
│                                    │
│  [ Dispatch Manually ]             │
│  [ Message Tech     ]              │
└────────────────────────────────────┘
```

---

## Push Notification Format

**Web push (existing push.js):**
```
Title:  🔧 New Job — Warrington
Body:   Fryer #2 not heating · HIGH · 2.1 mi away
        Tap to Accept or Deny → 
```

**Hexnode direct message (backup):**
```
PCG Portal Dispatch:
New job at Warrington (District 2)
Fryer #2 not heating | HIGH priority
2.1 miles from your location
Open portal to accept: https://pcg-ops.netlify.app
Respond within 10 minutes.
```

---

## Data Flow

```
Ticket Created (maintenance)
        │
        ▼
Load pcg_hexnode_devices_v1 (cache, refreshed every 5 min)
        │
        ▼
Match devices → portal maintenance users
        │
        ▼
Haversine distance to STORE_COORDS[storePC]
        │
        ▼
Sort by distance → dispatch queue [Tech1, Tech2, Tech3]
        │
        ▼
Send to Tech1: web push + Hexnode message
        │
   ┌────┴──────────────────┐
   │                       │
Accept (< 10 min)    Deny or timeout
   │                       │
   ▼                       ▼
Assign ticket         Send to Tech2
Update status              │
Notify creator        (repeat up to 3x)
                           │
                      All failed?
                           │
                           ▼
                    Escalate to supervisor
                    Flag ticket ESCALATED
```

---

## Hexnode API Calls Used

| Action | Endpoint | Method |
|---|---|---|
| List devices + location | `/api/v1/devices/?extra_search_fields=location` | GET |
| Send message to device | `/api/v1/devices/{id}/actions/` | POST |
| Refresh device location | `/api/v1/devices/{id}/actions/` | POST |

Auth: `Authorization: Mxadmauth {HEXNODE_API_KEY}` header on all requests.

---

## Blob Keys

| Key | Contents |
|---|---|
| `pcg_hexnode_devices_v1` | Cached device list + GPS, refreshed every 5 min |
| `pcg_dispatch_log_v1` | All dispatch attempts + responses, rolling 30 days |

---

## Role Gating

| Feature | Who sees it |
|---|---|
| Accept/Deny card | `maintenance` users only |
| Dispatch map + log | `it`, `executive`, maintenance supervisors |
| Manual dispatch button | `it`, `executive` only |
| Tech location pins | `it`, `executive` only (privacy) |
