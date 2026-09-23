// netlify/functions/shelly-temp-lib/device-map.mjs
// Shelly device id -> store pc. Shelly's Cloud API carries no usable "which store" field
// (confirmed against the real response, not assumed — see the design spec), so this is a
// small hand-maintained map, not auto-detected. A device with no entry here is monitored for
// nothing by the automation (still shows on the Dashboard display widget, which never needed
// a store mapping) — deliberately safer than guessing, since routing a food-safety alert to
// the wrong store is worse than not routing it.
//
// See docs/superpowers/specs/2026-09-23-shelly-temp-alerts-design.md for the full design.
export const SHELLY_DEVICE_STORE = {
  // '70af09e522d0': '332941', // example format only — pc goes here once a device is
  //                              actually installed at a store, not before.
};

// The current test device (70af09e522d0) is deliberately NOT in the map above — it's
// sitting in the office, not installed at any store (confirmed 2026-09-23, after almost
// wrongly assuming otherwise from the Shelly app's own device name, "Bustleton Walk in
// cooler...", which turned out to be a stale/wrong label). Until it gets a real store
// entry, both notification tiers for any unmapped device route here instead of being
// silently unmonitorable end-to-end during testing.
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
