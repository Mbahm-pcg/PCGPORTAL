// src/shelly-temp.test.mjs
// Unit tests for the pure temp-alert decision logic. See
// docs/superpowers/specs/2026-09-23-shelly-temp-alerts-design.md for the full design this
// implements — test names below map directly to that doc's Testing section.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceTempState,
  WARNING_THRESHOLD_C,
  WARNING_SUSTAIN_MS,
  RED_FLAG_THRESHOLD_C,
  PROLONGED_WARNING_ESCALATE_MS,
} from './shelly-temp.mjs';

const BASE_MS = new Date('2026-09-23T18:00:00.000Z').getTime();
const min = (n) => n * 60 * 1000;
const NO_STATE = { overSince: null, warningNotified: false };

describe('advanceTempState — thresholds', () => {
  test('exports match the spec\'d values', () => {
    assert.equal(WARNING_THRESHOLD_C, 5);
    assert.equal(WARNING_SUSTAIN_MS, min(30));
    assert.equal(RED_FLAG_THRESHOLD_C, 7);
    assert.equal(PROLONGED_WARNING_ESCALATE_MS, min(120));
  });
});

describe('advanceTempState — normal / reset', () => {
  test('at exactly 5°C is a full reset, not "over"', () => {
    const r = advanceTempState({ tempC: 5, prevState: NO_STATE, nowMs: BASE_MS });
    assert.deepEqual(r.state, { overSince: null, warningNotified: false });
    assert.equal(r.shouldWarn, false);
    assert.equal(r.shouldTicket, false);
  });

  test('under 5°C from a prior in-progress episode fully resets it', () => {
    const prev = { overSince: new Date(BASE_MS - min(50)).toISOString(), warningNotified: true };
    const r = advanceTempState({ tempC: 3.2, prevState: prev, nowMs: BASE_MS });
    assert.deepEqual(r.state, { overSince: null, warningNotified: false });
    assert.equal(r.shouldWarn, false);
    assert.equal(r.shouldTicket, false);
  });
});

describe('advanceTempState — unknown readings', () => {
  test('null reading leaves state completely unchanged', () => {
    const prev = { overSince: new Date(BASE_MS - min(20)).toISOString(), warningNotified: false };
    const r = advanceTempState({ tempC: null, prevState: prev, nowMs: BASE_MS });
    assert.deepEqual(r.state, prev);
    assert.equal(r.shouldWarn, false);
    assert.equal(r.shouldTicket, false);
  });

  test('unknown readings never themselves trigger or reset anything, but real wall-clock time still elapses through the gap', () => {
    // A sensor that goes over-threshold, then unreachable, then comes back still
    // over-threshold gives no reason to believe it was ever "fine" in between — the
    // elapsed-time clock (anchored to the original crossing, same as no-clockin-cron's own
    // "minutes since shift start, not a run counter" design) keeps running through the gap.
    // Excluding that time would make a flaky sensor SLOWER to escalate a real problem —
    // backwards for a food-safety system. What unknown DOES guarantee: it never itself
    // fires shouldWarn/shouldTicket, and never itself looks like a safe reset.
    let state = NO_STATE;
    let t = BASE_MS;
    ({ state } = advanceTempState({ tempC: 5.5, prevState: state, nowMs: t })); // episode starts
    for (let i = 0; i < 4; i++) {
      t += min(10);
      const r = advanceTempState({ tempC: null, prevState: state, nowMs: t });
      state = r.state; // unchanged from prev, each time
      assert.equal(r.shouldWarn, false);
      assert.equal(r.shouldTicket, false);
    }
    // 40 min of real elapsed time has now passed since the original crossing (some of it
    // "unknown"), so the next real reading correctly still crosses the 30-min warning mark.
    t += min(10);
    const r = advanceTempState({ tempC: 5.6, prevState: state, nowMs: t });
    assert.equal(r.shouldWarn, true);
  });
});

describe('advanceTempState — Warning tier', () => {
  test('one over-5°C reading alone does not warn', () => {
    const r = advanceTempState({ tempC: 5.5, prevState: NO_STATE, nowMs: BASE_MS });
    assert.equal(r.shouldWarn, false);
    assert.ok(r.state.overSince);
  });

  test('30+ min sustained between 5-7°C warns exactly once', () => {
    let state = NO_STATE;
    const start = BASE_MS;
    ({ state } = advanceTempState({ tempC: 5.5, prevState: state, nowMs: start }));
    let r = advanceTempState({ tempC: 5.6, prevState: state, nowMs: start + min(10) });
    state = r.state;
    assert.equal(r.shouldWarn, false); // only 10 min elapsed
    r = advanceTempState({ tempC: 5.8, prevState: state, nowMs: start + min(30) });
    state = r.state;
    assert.equal(r.shouldWarn, true); // 30 min elapsed — fires
    assert.equal(state.warningNotified, true);
    // Next check, still in-band: does NOT warn again.
    r = advanceTempState({ tempC: 5.7, prevState: state, nowMs: start + min(40) });
    assert.equal(r.shouldWarn, false);
  });
});

describe('advanceTempState — Red-flag tier', () => {
  test('a reading over 7°C tickets immediately, no prior warning needed', () => {
    const r = advanceTempState({ tempC: 7.5, prevState: NO_STATE, nowMs: BASE_MS, openTicketExists: false });
    assert.equal(r.shouldTicket, true);
    assert.equal(r.reason, 'red-flag');
    assert.equal(r.shouldWarn, false);
  });

  test('once ticketed, further over-threshold checks do not re-fire shouldTicket', () => {
    let r = advanceTempState({ tempC: 7.5, prevState: NO_STATE, nowMs: BASE_MS, openTicketExists: false });
    assert.equal(r.shouldTicket, true);
    // Ticket now exists (caller would have created it) — next check passes openTicketExists: true.
    r = advanceTempState({ tempC: 7.8, prevState: r.state, nowMs: BASE_MS + min(10), openTicketExists: true });
    assert.equal(r.shouldTicket, false);
  });

  test('straight jump to red-flag still sets warningNotified, so a later dip back in-band does not warn', () => {
    let r = advanceTempState({ tempC: 7.5, prevState: NO_STATE, nowMs: BASE_MS, openTicketExists: false });
    assert.equal(r.shouldTicket, true);
    assert.equal(r.state.warningNotified, true);
    // Eases back to 6.5°C (still >5, so no full reset) with the ticket still open.
    r = advanceTempState({ tempC: 6.5, prevState: r.state, nowMs: BASE_MS + min(40), openTicketExists: true });
    assert.equal(r.shouldWarn, false);
    assert.equal(r.shouldTicket, false);
  });
});

describe('advanceTempState — Prolonged-warning escalation', () => {
  test('still 5-7°C for 2+ hours tickets via reason "prolonged-warning", never having crossed 7°C', () => {
    let state = NO_STATE;
    let t = BASE_MS;
    ({ state } = advanceTempState({ tempC: 5.4, prevState: state, nowMs: t }));
    // Sail past the 30-min warning mark first.
    let r = advanceTempState({ tempC: 6.0, prevState: state, nowMs: t + min(30) });
    state = r.state;
    assert.equal(r.shouldWarn, true);
    // ...and keep going, still never touching 7°C, until 2 hours have elapsed since t.
    r = advanceTempState({ tempC: 6.2, prevState: state, nowMs: t + min(119) });
    assert.equal(r.shouldTicket, false);
    r = advanceTempState({ tempC: 6.3, prevState: r.state, nowMs: t + min(120) });
    assert.equal(r.shouldTicket, true);
    assert.equal(r.reason, 'prolonged-warning');
  });

  test('prolonged-warning ticket is also suppressed by an existing open ticket', () => {
    let state = NO_STATE;
    ({ state } = advanceTempState({ tempC: 5.5, prevState: state, nowMs: BASE_MS }));
    const r = advanceTempState({ tempC: 6.0, prevState: state, nowMs: BASE_MS + min(120), openTicketExists: true });
    assert.equal(r.shouldTicket, false);
    assert.equal(r.reason, 'prolonged-warning'); // reason still reported, just not actionable
  });
});

describe('advanceTempState — open ticket suppresses Warning too, not just a second ticket', () => {
  test('Warning is skipped while a ticket is already open for this sensor', () => {
    let state = NO_STATE;
    let t = BASE_MS;
    ({ state } = advanceTempState({ tempC: 5.5, prevState: state, nowMs: t }));
    const r = advanceTempState({ tempC: 5.8, prevState: state, nowMs: t + min(30), openTicketExists: true });
    assert.equal(r.shouldWarn, false);
    // But it's still marked "handled" so it doesn't retroactively fire once the ticket closes.
    assert.equal(r.state.warningNotified, true);
  });

  test('a Warning that was suppressed by an open ticket never fires later even after the ticket closes, absent a full reset', () => {
    let state = NO_STATE;
    let t = BASE_MS;
    ({ state } = advanceTempState({ tempC: 5.5, prevState: state, nowMs: t }));
    let r = advanceTempState({ tempC: 5.8, prevState: state, nowMs: t + min(30), openTicketExists: true });
    state = r.state;
    assert.equal(r.shouldWarn, false);
    // Ticket closes; temp is still lingering in-band (no full reset happened).
    r = advanceTempState({ tempC: 5.9, prevState: state, nowMs: t + min(40), openTicketExists: false });
    assert.equal(r.shouldWarn, false);
  });
});

describe('advanceTempState — a second, independent episode', () => {
  test('full reset then a fresh climb re-triggers both a new Warning and a new ticket', () => {
    let state = NO_STATE;
    let t = BASE_MS;
    // Episode 1: warns, then tickets via red-flag.
    ({ state } = advanceTempState({ tempC: 5.5, prevState: state, nowMs: t }));
    let r = advanceTempState({ tempC: 5.6, prevState: state, nowMs: t + min(30) });
    state = r.state;
    assert.equal(r.shouldWarn, true);
    r = advanceTempState({ tempC: 7.5, prevState: state, nowMs: t + min(40) });
    state = r.state;
    assert.equal(r.shouldTicket, true);
    // Full reset — temp drops back to normal (ticket presumed closed by a human by now).
    r = advanceTempState({ tempC: 3.0, prevState: state, nowMs: t + min(200) });
    state = r.state;
    assert.deepEqual(state, { overSince: null, warningNotified: false });
    // Episode 2, well after the reset: climbs again, gets its OWN fresh Warning...
    t += min(300);
    ({ state } = advanceTempState({ tempC: 5.5, prevState: state, nowMs: t }));
    r = advanceTempState({ tempC: 5.6, prevState: state, nowMs: t + min(30), openTicketExists: false });
    state = r.state;
    assert.equal(r.shouldWarn, true);
    // ...and its own fresh ticket if it goes far enough.
    r = advanceTempState({ tempC: 7.2, prevState: state, nowMs: t + min(50), openTicketExists: false });
    assert.equal(r.shouldTicket, true);
    assert.equal(r.reason, 'red-flag');
  });
});
