// netlify/functions/shelly-temp-lib/device-map.mjs
// Shelly device id -> store pc is now admin-editable, stored in the pcg_shelly_device_map_v1
// blob (loaded at the top of run.mjs), not hardcoded here — see the Dashboard's per-device
// store picker (exec/IT only) in app.jsx. This file now only holds what's genuinely still
// code-level config: the test-recipient fallback for a device with no store assignment yet.
//
// See docs/superpowers/specs/2026-09-23-shelly-temp-alerts-design.md for the full design.
export const SHELLY_DEVICE_MAP_BLOB_KEY = 'pcg_shelly_device_map_v1';

// A device with no entry in that blob is monitored for nothing by the ticket automation
// (still shows on the Dashboard display widget, which never needed a store mapping) —
// deliberately safer than guessing, since routing a food-safety alert to the wrong store is
// worse than not routing it. For any such device, both notification tiers route here instead
// of being silently unmonitorable end-to-end during testing.
//
// Matched by NAME, not by role (user_type='it') — a first dry-run test (2026-09-23) showed
// role-based matching also sweeps in shared/service accounts tagged 'it' that happen to
// exist ("IT Admin", "HR Admin", "Google Review" — the last one's a bot account for the
// Reviews sync, not a person), none of whom should get a text about an office desk sensor.
export const TEST_RECIPIENT_FALLBACK = {
  itNameMatch: 'Ahmed',
  execNameMatch: 'Mike',
  // both matched case-insensitively as a substring of users.name
};
