# Hexnode Maintenance Dispatch — Execution Plan

**Date:** 2026-06-09
**Status:** Planning
**Spec ref:** `docs/superpowers/specs/2026-06-09-hexnode-dispatch-design.md`

---

## Goal

When a maintenance ticket is created, automatically find the closest available maintenance tech using their live GPS location from Hexnode MDM, push an alert to their device, and let them accept or deny the job — all without a dispatcher in the middle.

---

## Prerequisites (gather before building)

| Item | Where to get it | Env var |
|---|---|---|
| Hexnode subdomain | Hexnode console → Settings | `HEXNODE_DOMAIN` (e.g. `pcg.hexnodemdm.com`) |
| Hexnode API key | Hexnode console → API → Generate Key | `HEXNODE_API_KEY` |
| How techs appear in Hexnode | Check a device record — email or full name? | — |

> Location policy is already enforced (15-min sync). Can tighten to 5-min via policy if needed.

---

## Phase 1 — Hexnode Backend Function

**File:** `netlify/functions/hexnode.js`

Actions:
- `getDevices` — list all enrolled devices, filter to maintenance group, return `{ deviceId, userName, email, lat, lon, lastSeen, online }`
- `sendMessage` — push a text alert to a specific device by ID
- `refreshLocation` — trigger a fresh GPS poll on a device (Hexnode supports on-demand location refresh)

Caching:
- Device list + locations cached in `pcg_hexnode_devices_v1` blob, refreshed every 5 min via a lightweight cron (`hexnode-sync-cron.js`)
- Dispatch reads the cache; no cold-call to Hexnode on every ticket

---

## Phase 2 — Dispatch Logic

Triggered on ticket creation when `category = 'maintenance'` (or any ticket assigned to the maintenance team).

**Steps:**
1. Load `pcg_hexnode_devices_v1` → active maintenance devices with lat/lon
2. Match each device to a portal user by email or name
3. Filter to users with `userType === 'maintenance'` and `online === true` (seen within 30 min)
4. Haversine distance from each device to `STORE_COORDS[ticket.storePC]`
5. Sort ascending by distance → dispatch queue
6. Send to #1: web push (existing `push.js`) + Hexnode direct message backup
7. Wait 10 minutes for response
8. No response or deny → send to #2, repeat up to 3 techs
9. All deny / no response → push to all maintenance users + notify supervisor

**Dispatch log saved to:** `pcg_dispatch_log_v1` blob  
Each entry: `{ ticketId, storePC, dispatchedAt, attempts: [{ userId, deviceId, distanceMi, sentAt, response, responseAt }] }`

---

## Phase 3 — Accept / Deny Mobile UI

Maintenance user receives push notification:
> **"New Ticket — Warrington | Fryer not heating | 2.1 mi away"**

Tapping opens the portal to a full-screen mobile card (only shown to maintenance role):
- Ticket title, store, category, priority, description
- Distance from their current location
- **Accept** (green) / **Deny** (red) buttons
- 10-minute countdown timer

On **Accept:**
- Ticket status → `assigned` → `en_route`
- Assigned tech name + ETA (distance ÷ 25 mph estimate) saved to ticket
- Confirmation push sent to ticket creator
- All other pending dispatches for this ticket cancelled

On **Deny:**
- Log denial reason (optional: too far, off duty, on another job)
- Next tech in the dispatch queue is alerted automatically

---

## Phase 4 — Admin Dispatch Map

New panel in the Maintenance tab (IT/executive/maintenance admin only):

- Live map showing all enrolled maintenance techs as colored pins
  - 🟢 Green = online + available
  - 🟡 Yellow = online + assigned to a ticket
  - 🔴 Red = offline (last seen > 30 min)
- Click a tech pin → drawer showing: name, last seen, current assignment, distance to each open ticket
- Open tickets shown as store pins with urgency color
- Dispatch log panel below map: today's dispatches, response times, acceptance rate

---

## Phase 5 — Supervisor Escalation

If all techs deny or no response after 3 attempts:
- Push + email to maintenance supervisor (Bill / Casey)
- Ticket flagged `escalated` in red
- Escalation logged with reason: `no_response` or `all_denied`

---

## Build Order

1. `hexnode.js` + `hexnode-sync-cron.js` + env vars → verify device list loads ✓
2. Dispatch logic wired into ticket creation → test with a real ticket
3. Accept/Deny mobile card UI
4. Admin dispatch map
5. Supervisor escalation

---

## Env Vars to Add (Netlify)

```
HEXNODE_DOMAIN=pcg.hexnodemdm.com
HEXNODE_API_KEY=xxxxxxxxxxxx
```
