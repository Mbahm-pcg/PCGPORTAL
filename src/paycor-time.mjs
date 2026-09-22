// src/paycor-time.mjs
// Paycor's schedulingShifts timestamps carry a real UTC "Z" suffix, but its punch endpoints
// (employeePunches, and the bulk /punches feed) return naive "YYYY-MM-DDTHH:mm:ss" strings
// with NO timezone marker — that's America/New_York wall-clock time, not UTC. Parsing a naive
// punch string as UTC (the server runs in UTC) misreads every real on-time punch as ~4-5
// hours "earlier" (EDT/EST) than it actually happened. Confirmed live 2026-09-22 against a
// real Paycor punch, via the no-clockin-alerts feature's mass "no clock-in" false-positive.
// Used by src/no-clockin.mjs and netlify/functions/labor-cron.mjs (live hours-worked-so-far
// for a currently-clocked-in employee) — anywhere a punch timestamp gets compared against an
// absolute UTC instant. A completed shift's own duration (clock-in vs. clock-out, both naive)
// is NOT affected by this — the same wrong assumption applied to both cancels out in the
// subtraction — so this fix targets comparisons against "now", not stored shift lengths.
const HAS_TZ = /(Z|[+-]\d{2}:?\d{2})$/;

/** Convert a naive "YYYY-MM-DDTHH:mm:ss" string, understood as America/New_York wall-clock
 *  time, to a UTC epoch ms — correct across the EDT/EST boundary (no fixed offset assumed). */
function etNaiveToUtcMs(naiveStr) {
  const guessMs = Date.parse(naiveStr.endsWith('Z') ? naiveStr : naiveStr + 'Z'); // rough guess: treat as if UTC
  if (!Number.isFinite(guessMs)) return NaN;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guessMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  // What the guess's instant actually reads as in ET, re-parsed the same "as if UTC" way —
  // the gap between the two is exactly the real UTC offset for that date (4h EDT / 5h EST).
  const asUtcMs = Date.parse(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`);
  return guessMs + (guessMs - asUtcMs);
}

/** Parse a Paycor punch timestamp string to a UTC epoch ms. A string that already carries a
 *  zone ("Z" or +/-HH:mm) is trusted as-is; a bare naive string is treated as America/New_York
 *  wall-clock time (see module comment). Returns NaN for falsy/unparseable input. */
export function parsePaycorPunchMs(raw) {
  if (!raw) return NaN;
  return HAS_TZ.test(raw) ? Date.parse(raw) : etNaiveToUtcMs(raw);
}
