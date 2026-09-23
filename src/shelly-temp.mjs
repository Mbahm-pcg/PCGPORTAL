// src/shelly-temp.mjs
// Pure decision logic for walk-in cooler/freezer temp alerts — no I/O. Used by
// netlify/functions/shelly-temp-lib/run.mjs. See
// docs/superpowers/specs/2026-09-23-shelly-temp-alerts-design.md for the full design.

export const WARNING_THRESHOLD_C = 5;
export const WARNING_SUSTAIN_MS = 30 * 60 * 1000; // 30 min
export const RED_FLAG_THRESHOLD_C = 7;
export const PROLONGED_WARNING_ESCALATE_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Advances one sensor's episode state by one check.
 *
 * @param {object} args
 * @param {number|null} args.tempC - current reading, or null/undefined if the check failed
 *   (unreachable device, API error) — treated as "unknown", never as over-threshold or a reset.
 * @param {{overSince: string|null, warningNotified: boolean}|null|undefined} args.prevState
 * @param {number} args.nowMs
 * @param {boolean} args.openTicketExists - true if a ticket is already open for this exact
 *   sensor (live DB check, done by the caller — kept as an input so this function stays pure).
 * @returns {{state: {overSince: string|null, warningNotified: boolean}, shouldWarn: boolean,
 *   shouldTicket: boolean, reason: 'red-flag'|'prolonged-warning'|null}}
 */
export function advanceTempState({ tempC, prevState, nowMs, openTicketExists = false }) {
  const prev = prevState || { overSince: null, warningNotified: false };

  // Unknown reading: nothing moves, in either direction. Doesn't advance the elapsed-time
  // clock either — a failed check is time that didn't count, not time that passed safely.
  if (tempC == null) {
    return { state: prev, shouldWarn: false, shouldTicket: false, reason: null };
  }

  // At or under the warning threshold: full reset. Whatever happens next is a new episode.
  if (tempC <= WARNING_THRESHOLD_C) {
    return {
      state: { overSince: null, warningNotified: false },
      shouldWarn: false,
      shouldTicket: false,
      reason: null,
    };
  }

  // Over 5°C. Start (or continue) this episode's clock.
  const overSince = prev.overSince || new Date(nowMs).toISOString();
  const elapsedMs = nowMs - new Date(overSince).getTime();

  let shouldTicket = false;
  let reason = null;

  if (tempC > RED_FLAG_THRESHOLD_C) {
    shouldTicket = !openTicketExists;
    reason = 'red-flag';
  } else if (elapsedMs >= PROLONGED_WARNING_ESCALATE_MS) {
    shouldTicket = !openTicketExists;
    reason = 'prolonged-warning';
  }

  // Whenever the red-flag/prolonged-warning condition is met — whether or not a ticket
  // already existed to suppress shouldTicket — the episode is considered "handled" for
  // Warning purposes too. Covers both a straight jump to red-flag that skipped the Warning
  // stage, and a re-entry into the 5-7°C band while an earlier ticket for this same episode
  // is still open: neither should ever produce a fresh "keep an eye on it" Warning.
  if (reason) {
    return {
      state: { overSince, warningNotified: true },
      shouldWarn: false,
      shouldTicket,
      reason,
    };
  }

  // Still in the 5-7°C band, not yet at the 2-hour prolonged-warning mark. Once the 30-min
  // sustain point is reached, this episode's Warning moment is considered "handled" for
  // good — warningNotified flips true whether or not shouldWarn actually fires, so a ticket
  // that later closes (while the temp is still lingering in-band, no full reset) can never
  // cause a stale, redundant Warning to surface after the fact.
  const warningEligible = elapsedMs >= WARNING_SUSTAIN_MS;
  const shouldWarn = warningEligible && !prev.warningNotified && !openTicketExists;

  return {
    state: { overSince, warningNotified: prev.warningNotified || warningEligible },
    shouldWarn,
    shouldTicket: false,
    reason: null,
  };
}
