// src/no-clockin.mjs
// Pure no-clock-in logic — no I/O. Used by netlify/functions/no-clockin-cron.mjs.
// Rules: 30 min after shift start with no clock-in -> heads-up to the store manager;
// 60 min -> employee marked absent, alert to the manager AND the DM.

import { parsePaycorPunchMs } from './paycor-time.mjs';

const MIN = 60000;
export const WARN_MIN = 30;
export const ABSENT_MIN = 60;
export const MAX_AGE_MIN = 90;    // stop considering a shift this long after it started (keeps a fresh go-live from sending stale "absent" alerts)
export const PRE_START_MIN = 60;  // a punch this early before start still counts as clocked in
export const MASS_MISS = 3;       // this many missing at one store = probably a data problem
export const STATE_TTL_DAYS = 14;

const AUDIENCE = { warn30: ['manager'], absent: ['manager', 'dm'], dataProblem: ['manager'] };

/** Normalise a raw Paycor schedulingShift (same field variants labor-cron.mjs accepts). */
export function normalizeShift(s) {
  return {
    employeeId: s.employeeId || s.EmployeeId || null,
    employeeName: s.employeeName || (s.firstName && s.lastName ? `${s.firstName} ${s.lastName}` : null) || s.EmployeeName || null,
    startDateTime: s.startDateTime || s.StartDateTime || null,
    endDateTime: s.endDateTime || s.EndDateTime || null,
  };
}

export function shiftKey(pc, s) {
  return `${pc}|${s.employeeId}|${s.startDateTime}`;
}

/** Shifts that started WARN_MIN..MAX_AGE_MIN ago and have not ended yet. */
export function candidateShifts(shifts, nowMs) {
  return (shifts || []).filter(s => {
    if (!s || !s.employeeId || !s.startDateTime) return false;
    const start = Date.parse(s.startDateTime);
    if (!Number.isFinite(start)) return false;
    const elapsed = (nowMs - start) / MIN;
    if (elapsed < WARN_MIN || elapsed > MAX_AGE_MIN) return false;
    const end = Date.parse(s.endDateTime);
    if (Number.isFinite(end) && end <= nowMs) return false;
    return true;
  });
}

// See src/paycor-time.mjs for why this isn't a plain Date.parse: Paycor's punch endpoints
// return naive (no timezone) Eastern wall-clock strings, unlike schedulingShifts' UTC times.
function punchTimeMs(p) {
  return parsePaycorPunchMs(p.punchDateTime || p.punchIn || p.inActualPunch || '');
}

/** True if any punch falls between PRE_START_MIN before the shift start and now. */
export function hasClockedIn(punches, startMs, nowMs) {
  const from = startMs - PRE_START_MIN * MIN;
  return (punches || []).some(p => {
    const t = punchTimeMs(p);
    return Number.isFinite(t) && t >= from && t <= nowMs;
  });
}

/**
 * Decide which alerts to send for ONE store this run.
 * punchesByEmp[employeeId] is an array of punches, or null when the Paycor call failed
 * (unknown — never treated as missing). state is the flat dedupe map from the blob.
 * Returns { alerts, nextState } — nextState already records the alerts as sent.
 */
export function planAlerts({ pc, storeName, candidates, punchesByEmp, state, nowMs }) {
  const missing = [];
  for (const s of candidates) {
    const punches = punchesByEmp[s.employeeId];
    if (punches == null) continue;
    const startMs = Date.parse(s.startDateTime);
    if (hasClockedIn(punches, startMs, nowMs)) continue;
    missing.push({ shift: s, startMs, key: shiftKey(pc, s) });
  }

  const nextState = { ...state };
  const alerts = [];

  if (missing.length >= MASS_MISS) {
    const dpKey = `dp|${pc}|${new Date(nowMs).toISOString().slice(0, 10)}`;
    if (!state[dpKey]) {
      alerts.push({ stage: 'dataProblem', pc, storeName, count: missing.length });
      nextState[dpKey] = { alertedAt: nowMs, startMs: nowMs };
    }
    return { alerts, nextState };
  }

  for (const m of missing) {
    const elapsed = (nowMs - m.startMs) / MIN;
    const rec = state[m.key] || {};
    const base = { pc, storeName, name: m.shift.employeeName, startMs: m.startMs, key: m.key };
    if (elapsed >= ABSENT_MIN) {
      if (!rec.absentAt) {
        alerts.push({ stage: 'absent', ...base });
        nextState[m.key] = { ...rec, startMs: m.startMs, absentAt: nowMs };
      }
    } else if (elapsed >= WARN_MIN) {
      if (!rec.alerted30At) {
        alerts.push({ stage: 'warn30', ...base });
        nextState[m.key] = { ...rec, startMs: m.startMs, alerted30At: nowMs };
      }
    }
  }
  return { alerts, nextState };
}

/** Eastern-time clock like "6:00a" / "3:30p". */
export function fmtEt(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find(p => p.type === t).value;
  return `${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase()[0]}`;
}

/** "Jane Doe" -> "Jane D."; single names and blanks are handled. */
export function shortName(full) {
  const p = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return 'Employee';
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0];
}

/** Turn a store's alerts into one message per stage, each with its audience. */
export function buildMessages(alerts) {
  const byStage = {};
  for (const a of alerts) (byStage[a.stage] ||= []).push(a);
  const out = [];
  for (const [stage, list] of Object.entries(byStage)) {
    const { pc, storeName } = list[0];
    let subject, text;
    if (stage === 'dataProblem') {
      subject = `Clock-in check — ${storeName}`;
      text = `${storeName}: ${list[0].count} scheduled employees show no clock-in. Punch data may be unavailable — please verify.`;
    } else {
      const people = list.map(a => `${shortName(a.name)} (${fmtEt(a.startMs)})`).join(', ');
      // Distinct shift times in this batch, e.g. "(10:00a)" or "(4:00a/4:30a)" — without this,
      // a store's separate no-clock-in incidents hours apart all share the exact same subject
      // ("No clock-in — Street Rd"), so an email client threads them into one conversation and
      // a later, different incident can look like a repeat of the first and get skipped.
      const times = [...new Set(list.map(a => fmtEt(a.startMs)))].join('/');
      if (stage === 'warn30') {
        subject = `No clock-in — ${storeName} (${times})`;
        text = `${storeName}: no clock-in yet — ${people}. Shift started 30+ min ago.`;
      } else {
        subject = `Absent — ${storeName} (${times})`;
        text = `${storeName}: marked ABSENT (no clock-in after 60 min) — ${people}.`;
      }
    }
    out.push({ stage, pc, storeName, subject, text, audience: AUDIENCE[stage] });
  }
  return out;
}

/** Drop state entries whose shift started more than STATE_TTL_DAYS ago. */
export function pruneState(state, nowMs) {
  const cutoff = nowMs - STATE_TTL_DAYS * 86400000;
  const out = {};
  for (const [k, v] of Object.entries(state || {})) {
    if ((v && v.startMs) >= cutoff) out[k] = v;
  }
  return out;
}
