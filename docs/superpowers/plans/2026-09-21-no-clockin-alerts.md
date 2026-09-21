# No Clock-In Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Text + app-notify + email a store's manager at 30 minutes, and the manager and DM at 60 minutes, when a scheduled employee has not clocked in.

**Architecture:** A pure, unit-tested logic module (`src/no-clockin.mjs`) decides who to alert and what to say. A thin scheduled Netlify function (`no-clockin-cron.mjs`, every 15 min) does the I/O: reads schedules, re-fetches live shifts and per-employee punches from Paycor, calls the pure module, and delivers over SMS/push/email. Per-shift state in a Netlify Blob prevents repeats. New behavior ships **log-only** behind a `NO_CLOCKIN_LIVE` env flag until a dry run has been checked against real data.

**Tech Stack:** Node ESM (`.mjs`), `node:test`, Netlify Functions + Blobs, Neon (`users`), Paycor REST (via `labor-cron.mjs`), Textbelt SMS, Resend email, `web-push`.

**Spec:** `docs/superpowers/specs/2026-09-21-no-clockin-alerts-design.md`

## Global Constraints

- Alert stages: **30 min** after shift start -> store manager only; **60 min** -> employee marked absent, store manager **and** DM. Constants `WARN_MIN=30`, `ABSENT_MIN=60`.
- Every alert goes on all three channels: SMS, app (web push) notification, email. One channel failing never blocks the others.
- A Paycor error / non-200 means the employee is **unknown**, never **missing**; never mark anyone absent on an API failure.
- Feed-problem guard: 3 or more missing at one store (`MASS_MISS=3`) -> one "punch data may be unavailable, please verify" message to the manager; nobody is named absent.
- A punch counts as clocked in if it falls between 60 minutes before shift start (`PRE_START_MIN=60`) and now.
- Shifts are considered only 30 to 180 minutes after start (`MAX_AGE_MIN=180`) and only if not already ended.
- Dedup: each stage fires once per shift, tracked in blob `pcg_noclockin_v1` (`{ savedAt, data }` wrapper), entries pruned after 14 days.
- Times in messages are Eastern (`America/New_York`), formatted like `6:00a`.
- The feature only reads store/user data; it never writes to `stores` or `users`.
- SMS via Textbelt (`TEXTBELT_API_KEY`), not Twilio. Email via Resend (`RESEND_API_KEY`, `NOTIFY_FROM`). Push via VAPID (`pcg_push_subscriptions_v1`).
- No `app.jsx` changes, so no `APP_VERSION` bump and no `app.js` rebuild.
- Do not deploy or push without asking the user first (git push to `main` is the production deploy).

---

## File Structure

- Create `src/no-clockin.mjs` — pure logic: shift normalization, candidate filtering, clock-in detection, alert planning, message building, state pruning. No I/O.
- Create `src/no-clockin.test.mjs` — unit tests (picked up by the existing `npm test` glob `src/*.test.mjs`).
- Create `netlify/functions/_shared/channels.mjs` — `sendSms`, `sendEmail`, `sendPush` helpers (copied patterns from `pulse-notify.mjs` / `system-health-cron.mjs`; those files are left alone).
- Create `netlify/functions/no-clockin-cron.mjs` — scheduled function + exec/IT-only `dryRun` / `sendTest`.
- Modify `netlify/functions/labor-cron.mjs` — export `callPaycor` and `fetchSchedulingShifts` (add the `export` keyword only).
- Modify `CLAUDE.md` — document the function, schedule and env var.

---

### Task 1: Pure logic module with tests

**Files:**
- Create: `src/no-clockin.mjs`
- Test: `src/no-clockin.test.mjs`

**Interfaces:**
- Produces (used by Task 2), all exported from `src/no-clockin.mjs`:
  - constants `WARN_MIN`, `ABSENT_MIN`, `MAX_AGE_MIN`, `PRE_START_MIN`, `MASS_MISS`, `STATE_TTL_DAYS`
  - `normalizeShift(raw) -> { employeeId, employeeName, startDateTime, endDateTime }`
  - `shiftKey(pc, shift) -> string`
  - `candidateShifts(shifts, nowMs) -> shift[]`
  - `hasClockedIn(punches, startMs, nowMs) -> boolean`
  - `planAlerts({ pc, storeName, candidates, punchesByEmp, state, nowMs }) -> { alerts, nextState }` where `punchesByEmp[employeeId]` is an array of punches or `null` (= unknown) and `state` is the flat blob map
  - `buildMessages(alerts) -> [{ stage, pc, storeName, subject, text, audience }]` (`audience` is an array of `'manager'` / `'dm'`)
  - `pruneState(state, nowMs) -> state`
  - `fmtEt(ms) -> string`, `shortName(full) -> string`

- [ ] **Step 1: Write the failing tests**

Create `src/no-clockin.test.mjs`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  WARN_MIN, ABSENT_MIN, normalizeShift, shiftKey, candidateShifts, hasClockedIn,
  planAlerts, buildMessages, pruneState, fmtEt, shortName,
} from './no-clockin.mjs';

const MIN = 60000;
const START = '2026-09-21T10:00:00Z';           // 6:00a ET (EDT)
const START_MS = Date.parse(START);
const END = '2026-09-21T16:00:00Z';
const at = (minAfterStart) => START_MS + minAfterStart * MIN;
const shift = (over = {}) => ({ employeeId: 'e1', employeeName: 'Jane Doe', startDateTime: START, endDateTime: END, ...over });

describe('normalizeShift', () => {
  test('maps Paycor field variants', () => {
    const n = normalizeShift({ EmployeeId: 'x', firstName: 'A', lastName: 'B', StartDateTime: START, EndDateTime: END });
    assert.deepStrictEqual(n, { employeeId: 'x', employeeName: 'A B', startDateTime: START, endDateTime: END });
  });
});

describe('candidateShifts', () => {
  test('29 min after start is too early', () => assert.strictEqual(candidateShifts([shift()], at(29)).length, 0));
  test('30 min after start is a candidate', () => assert.strictEqual(candidateShifts([shift()], at(30)).length, 1));
  test('180 min is still a candidate, 181 is not', () => {
    assert.strictEqual(candidateShifts([shift()], at(180)).length, 1);
    assert.strictEqual(candidateShifts([shift()], at(181)).length, 0);
  });
  test('shift that already ended is skipped', () => {
    assert.strictEqual(candidateShifts([shift({ endDateTime: '2026-09-21T10:20:00Z' })], at(40)).length, 0);
  });
  test('missing employeeId or bad start is skipped', () => {
    assert.strictEqual(candidateShifts([shift({ employeeId: null }), shift({ startDateTime: 'nope' })], at(40)).length, 0);
  });
});

describe('hasClockedIn', () => {
  test('no punches -> false', () => assert.strictEqual(hasClockedIn([], START_MS, at(40)), false));
  test('punch 30 min before start counts', () => {
    assert.strictEqual(hasClockedIn([{ punchDateTime: new Date(at(-30)).toISOString() }], START_MS, at(40)), true);
  });
  test('punch 61 min before start does not count', () => {
    assert.strictEqual(hasClockedIn([{ punchDateTime: new Date(at(-61)).toISOString() }], START_MS, at(40)), false);
  });
  test('punch in the future does not count', () => {
    assert.strictEqual(hasClockedIn([{ punchDateTime: new Date(at(50)).toISOString() }], START_MS, at(40)), false);
  });
  test('accepts the punchIn field', () => {
    assert.strictEqual(hasClockedIn([{ punchIn: new Date(at(5)).toISOString() }], START_MS, at(40)), true);
  });
});

describe('planAlerts', () => {
  const base = (nowMs, punchesByEmp, state = {}, candidates = [shift()]) =>
    planAlerts({ pc: '339616', storeName: 'Wadsworth', candidates, punchesByEmp, state, nowMs });

  test('35 min, no punch -> one warn30, and not again on the next run', () => {
    const r1 = base(at(35), { e1: [] });
    assert.deepStrictEqual(r1.alerts.map(a => a.stage), ['warn30']);
    const r2 = base(at(50), { e1: [] }, r1.nextState);
    assert.strictEqual(r2.alerts.length, 0);
  });
  test('65 min after a warn30 -> absent once, then never again', () => {
    const r1 = base(at(35), { e1: [] });
    const r2 = base(at(65), { e1: [] }, r1.nextState);
    assert.deepStrictEqual(r2.alerts.map(a => a.stage), ['absent']);
    const r3 = base(at(80), { e1: [] }, r2.nextState);
    assert.strictEqual(r3.alerts.length, 0);
  });
  test('first seen at 65 min (no prior warn) -> absent only', () => {
    assert.deepStrictEqual(base(at(65), { e1: [] }).alerts.map(a => a.stage), ['absent']);
  });
  test('unknown punches (null) never alert', () => {
    assert.strictEqual(base(at(65), { e1: null }).alerts.length, 0);
  });
  test('clocked in -> no alert', () => {
    assert.strictEqual(base(at(65), { e1: [{ punchDateTime: new Date(at(3)).toISOString() }] }).alerts.length, 0);
  });
  test('3 missing at one store -> a single dataProblem, not repeated', () => {
    const cands = ['e1', 'e2', 'e3'].map(id => shift({ employeeId: id }));
    const punches = { e1: [], e2: [], e3: [] };
    const r1 = base(at(35), punches, {}, cands);
    assert.deepStrictEqual(r1.alerts.map(a => a.stage), ['dataProblem']);
    assert.strictEqual(r1.alerts[0].count, 3);
    const r2 = base(at(50), punches, r1.nextState, cands);
    assert.strictEqual(r2.alerts.length, 0);
  });
  test('2 missing is not a data problem', () => {
    const cands = ['e1', 'e2'].map(id => shift({ employeeId: id }));
    const r = base(at(35), { e1: [], e2: [] }, {}, cands);
    assert.deepStrictEqual(r.alerts.map(a => a.stage), ['warn30', 'warn30']);
  });
});

describe('buildMessages', () => {
  const mk = (stage, name) => ({ stage, pc: '339616', storeName: 'Wadsworth', name, startMs: START_MS, key: 'k' + name });
  test('groups people per stage and sets audience', () => {
    const msgs = buildMessages([mk('warn30', 'Jane Doe'), mk('warn30', 'Bob Smith'), mk('absent', 'Ann Lee')]);
    const warn = msgs.find(m => m.stage === 'warn30');
    const absent = msgs.find(m => m.stage === 'absent');
    assert.deepStrictEqual(warn.audience, ['manager']);
    assert.deepStrictEqual(absent.audience, ['manager', 'dm']);
    assert.match(warn.text, /Wadsworth/);
    assert.match(warn.text, /Jane D\. \(6:00a\)/);
    assert.match(warn.text, /Bob S\. \(6:00a\)/);
    assert.match(absent.text, /ABSENT/);
    assert.match(absent.text, /Ann L\./);
  });
  test('dataProblem message names nobody and goes to manager only', () => {
    const [m] = buildMessages([{ stage: 'dataProblem', pc: '339616', storeName: 'Wadsworth', count: 4 }]);
    assert.deepStrictEqual(m.audience, ['manager']);
    assert.match(m.text, /4 scheduled employees/);
    assert.match(m.text, /verify/i);
  });
});

describe('pruneState / helpers', () => {
  test('drops entries older than 14 days, keeps recent ones', () => {
    const now = Date.parse('2026-09-21T12:00:00Z');
    const out = pruneState({ old: { startMs: now - 15 * 86400000 }, fresh: { startMs: now - 1 * 86400000 } }, now);
    assert.deepStrictEqual(Object.keys(out), ['fresh']);
  });
  test('fmtEt renders Eastern time like 6:00a / 3:30p', () => {
    assert.strictEqual(fmtEt(Date.parse('2026-09-21T10:00:00Z')), '6:00a');
    assert.strictEqual(fmtEt(Date.parse('2026-09-21T19:30:00Z')), '3:30p');
  });
  test('shortName', () => {
    assert.strictEqual(shortName('Jane Doe'), 'Jane D.');
    assert.strictEqual(shortName('William Isaac Feliciano'), 'William F.');
    assert.strictEqual(shortName('Prince'), 'Prince');
    assert.strictEqual(shortName(''), 'Employee');
  });
  test('shiftKey', () => assert.strictEqual(shiftKey('339616', shift()), `339616|e1|${START}`));
  test('constants match the spec', () => { assert.strictEqual(WARN_MIN, 30); assert.strictEqual(ABSENT_MIN, 60); });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/no-clockin.test.mjs`
Expected: FAIL — `Cannot find module './no-clockin.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `src/no-clockin.mjs`:

```js
// src/no-clockin.mjs
// Pure no-clock-in logic — no I/O. Used by netlify/functions/no-clockin-cron.mjs.
// Rules: 30 min after shift start with no clock-in -> heads-up to the store manager;
// 60 min -> employee marked absent, alert to the manager AND the DM.

const MIN = 60000;
export const WARN_MIN = 30;
export const ABSENT_MIN = 60;
export const MAX_AGE_MIN = 180;   // stop considering a shift this long after it started
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

function punchTimeMs(p) {
  return Date.parse(p.punchDateTime || p.punchIn || p.inActualPunch || '');
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
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : p[0];
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
      if (stage === 'warn30') {
        subject = `No clock-in — ${storeName}`;
        text = `${storeName}: no clock-in yet — ${people}. Shift started 30+ min ago.`;
      } else {
        subject = `Absent — ${storeName}`;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/no-clockin.test.mjs`
Expected: PASS, all tests green (0 failures).

- [ ] **Step 5: Run the full suite to check nothing else broke**

Run: `npm test`
Expected: PASS (same pre-existing results plus the new tests).

- [ ] **Step 6: Do not commit yet**

The project rule is one commit and one push for the whole feature. The single commit happens in Task 3, Step 2.

---

### Task 2: Channels helper + scheduled function

**Files:**
- Create: `netlify/functions/_shared/channels.mjs`
- Create: `netlify/functions/no-clockin-cron.mjs`
- Modify: `netlify/functions/labor-cron.mjs:249` (`callPaycor`) and `:408` (`fetchSchedulingShifts`) — add `export`

**Interfaces:**
- Consumes (from Task 1, `../../src/no-clockin.mjs`): `normalizeShift`, `candidateShifts`, `planAlerts`, `buildMessages`, `pruneState`.
- Consumes (from `labor-cron.mjs`): `STORES` (already exported; `{pc, paycor, name, district}`), `callPaycor(path) -> {status, data}`, `fetchSchedulingShifts(legalEntityId, startDate, endDate) -> rawShift[]` (returns `[]` on failure).
- Produces: `sendSms(numbers, message)`, `sendEmail(to[], subject, text)`, `sendPush(blobStore, userIds[], title, body, tag)` — all best-effort, never throw. The function's default export handles the scheduled run and `POST ?dryRun=1` / `?dryRun=1&sendTest=1` (exec/IT only).

- [ ] **Step 1: Export the two Paycor helpers from labor-cron**

In `netlify/functions/labor-cron.mjs` change:

```js
async function callPaycor(path, method = 'GET', _retried = false) {
```
to
```js
export async function callPaycor(path, method = 'GET', _retried = false) {
```
and
```js
async function fetchSchedulingShifts(legalEntityId, startDate, endDate) {
```
to
```js
export async function fetchSchedulingShifts(legalEntityId, startDate, endDate) {
```

Run: `node --check netlify/functions/labor-cron.mjs`
Expected: no output (syntax OK).

- [ ] **Step 2: Create the channels helper**

Create `netlify/functions/_shared/channels.mjs`:

```js
// netlify/functions/_shared/channels.mjs
// Best-effort delivery helpers (SMS via Textbelt, email via Resend, web push via VAPID).
// Same patterns as pulse-notify.mjs / system-health-cron.mjs. None of these ever throw,
// so one failing channel can't block the others.
import https from 'node:https';
import webpush from 'web-push';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendSms(numbers, message) {
  const KEY = process.env.TEXTBELT_API_KEY;
  const list = (Array.isArray(numbers) ? numbers : [numbers]).filter(Boolean);
  if (!KEY || !list.length) return { sent: 0, results: [] };
  const results = [];
  for (const number of list) {
    let cleaned = String(number).replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = '1' + cleaned;
    const phone = '+' + cleaned;
    const postData = new URLSearchParams({ phone, message, key: KEY }).toString();
    const r = await new Promise((resolve) => {
      const req = https.request(
        { hostname: 'textbelt.com', port: 443, path: '/text', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) } },
        (res) => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => { let j = {}; try { j = JSON.parse(raw); } catch {} resolve({ number: phone, success: !!j.success, error: j.error }); }); });
      req.on('error', (e) => resolve({ number: phone, success: false, error: e.message }));
      req.write(postData); req.end();
    });
    results.push(r);
  }
  return { sent: results.filter(r => r.success).length, results };
}

export function sendEmail(to, subject, text) {
  return new Promise((resolve) => {
    const key = process.env.RESEND_API_KEY;
    const list = (to || []).filter(Boolean);
    if (!key || !list.length) return resolve(false);
    const payload = JSON.stringify({
      from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>',
      to: list, subject, html: `<p>${esc(text)}</p>`,
    });
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false)); req.write(payload); req.end();
  });
}

export async function sendPush(blobStore, userIds, title, body, tag) {
  try {
    if (!userIds.length) return { sent: 0 };
    const vpub = process.env.VAPID_PUBLIC_KEY, vpriv = process.env.VAPID_PRIVATE_KEY;
    if (!vpub || !vpriv) return { sent: 0 };
    const w = await blobStore.get('pcg_push_subscriptions_v1', { type: 'json' });
    const subs = (w && w.data) ? w.data : {};
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`, vpub, vpriv);
    const payload = JSON.stringify({ title, body: body || '', icon: '/apple-touch-icon.png', url: '/', tag: tag || undefined });
    let sent = 0;
    for (const uid of userIds) for (const sub of (subs[String(uid)] || [])) {
      try { await webpush.sendNotification(sub, payload); sent++; } catch { /* expired subscription */ }
    }
    return { sent };
  } catch { return { sent: 0 }; }
}
```

Run: `node --check netlify/functions/_shared/channels.mjs`
Expected: no output.

- [ ] **Step 3: Create the scheduled function**

Create `netlify/functions/no-clockin-cron.mjs`:

```js
// no-clockin-cron.mjs — No Clock-In Alerts
// Every 15 min: find scheduled shifts that started 30-180 min ago with no punch, and
// alert the store manager (30 min) and manager + DM (60 min, "absent") by SMS, app
// notification and email. Per-shift dedupe lives in blob pcg_noclockin_v1.
//
// Rollout safety: scheduled runs only SEND (and write state) when env NO_CLOCKIN_LIVE=true.
// Otherwise they compute and log only. Exec/IT can POST ?dryRun=1 (never sends, never writes
// state) and ?dryRun=1&sendTest=1 (sends a sample alert to the caller only).
// Spec: docs/superpowers/specs/2026-09-21-no-clockin-alerts-design.md
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { sendSms, sendEmail, sendPush } from './_shared/channels.mjs';
import { STORES, callPaycor, fetchSchedulingShifts } from './labor-cron.mjs';
import { normalizeShift, candidateShifts, planAlerts, buildMessages, pruneState } from '../../src/no-clockin.mjs';

export const config = { schedule: '*/15 * * * *' };

const STATE_KEY = 'pcg_noclockin_v1';
const DEADLINE_MS = 20000; // stay under the function timeout; the next run picks up the rest
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
async function loadJson(bs, key) {
  try { const raw = await bs.get(key, { type: 'json' }); return raw && raw.data !== undefined ? raw.data : (raw || null); } catch { return null; }
}
const etDate = (ms, offsetDays = 0) =>
  new Date(ms + offsetDays * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const uniq = (a) => [...new Set(a)];

// Punch list for one employee, or null when Paycor errors (= unknown, never "missing").
async function fetchPunches(employeeId, from, to, statusCounts) {
  try {
    const res = await callPaycor(`/employees/${employeeId}/employeePunches?startDate=${from}&endDate=${to}`);
    statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
    if (res.status !== 200) return null;
    const recs = res.data?.records || res.data || [];
    return Array.isArray(recs) ? recs : null;
  } catch { statusCounts.error = (statusCounts.error || 0) + 1; return null; }
}

function contactsFor(role, store, users, storeRecord) {
  if (role === 'manager') {
    const found = users.filter(u => u.user_type === 'manager' && String(u.store_pc) === store.pc);
    if (found.length) return found;
    return storeRecord && storeRecord.mgrPhone ? [{ id: null, phone: storeRecord.mgrPhone, email: storeRecord.email || null }] : [];
  }
  if (role === 'dm') {
    return users.filter(u => u.user_type === 'dm' && Number(u.district) === Number(store.district));
  }
  return [];
}

async function deliver(bs, recipients, subject, text) {
  const phones = uniq(recipients.map(r => r.phone).filter(Boolean));
  const emails = uniq(recipients.map(r => r.email).filter(Boolean));
  const ids = uniq(recipients.map(r => r.id).filter(id => id != null).map(String));
  await Promise.allSettled([
    sendSms(phones, text),
    sendEmail(emails, subject, text),
    sendPush(bs, ids, subject, text, 'no_clockin'),
  ]);
  return { phones: phones.length, emails: emails.length, push: ids.length };
}

export default async (request) => {
  const started = Date.now();
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const sendTest = dryRun && url.searchParams.get('sendTest') === '1';
  const live = process.env.NO_CLOCKIN_LIVE === 'true' && !dryRun;

  let caller = null;
  if (dryRun) {
    caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
    if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
      return json({ error: 'Exec/IT session required.' }, 403);
    }
  }

  const bs = blobStore();
  const nowMs = Date.now();

  // Sample alert to the caller only — lets exec/IT confirm all three channels work before going live.
  if (sendTest) {
    const rows = await sql()`SELECT id, email, phone FROM users WHERE id = ${caller.sub}`;
    const me = rows[0] ? [{ id: rows[0].id, email: rows[0].email, phone: rows[0].phone }] : [];
    const d = await deliver(bs, me, 'No clock-in — TEST', 'TEST: this is a sample No Clock-In alert. If you got this by text, app notification and email, all three channels work.');
    return json({ ok: true, sendTest: true, delivered: d });
  }

  // Operational stores only (same fail-open approach as system-health-cron).
  let storeRecords = {};
  let openPcs = null;
  const list = await loadJson(bs, 'pcg_stores_v1');
  if (Array.isArray(list)) {
    for (const s of list) if (s && s.pc != null) storeRecords[String(s.pc)] = s;
    openPcs = new Set(list.filter(s => s && s.status === 'Open').map(s => String(s.pc)));
  }
  const stores = STORES.filter(s => !openPcs || openPcs.has(s.pc));

  let state = (await loadJson(bs, STATE_KEY)) || {};
  const from = etDate(nowMs, -1), to = etDate(nowMs, 1);
  const statusCounts = {};
  const allAlerts = [];
  let candidateCount = 0, truncated = false;

  for (const store of stores) {
    if (Date.now() - started > DEADLINE_MS) { truncated = true; break; }

    // Cheap pre-filter from the saved schedule blob; only stores with candidates hit Paycor.
    const sched = await loadJson(bs, `pcg_schedule_${store.pc}`);
    if (!candidateShifts(sched?.shifts || [], nowMs).length) continue;

    // Re-fetch LIVE shifts so a removed/moved shift doesn't alert. [] on failure -> no alerts.
    const liveRaw = await fetchSchedulingShifts(store.paycor, from, to);
    const candidates = candidateShifts(liveRaw.map(normalizeShift), nowMs);
    if (!candidates.length) continue;
    candidateCount += candidates.length;

    const ids = uniq(candidates.map(c => c.employeeId));
    const punchesByEmp = {};
    for (let i = 0; i < ids.length; i += 5) {
      await Promise.all(ids.slice(i, i + 5).map(async (id) => { punchesByEmp[id] = await fetchPunches(id, from, to, statusCounts); }));
    }

    const { alerts, nextState } = planAlerts({ pc: store.pc, storeName: store.name, candidates, punchesByEmp, state, nowMs });
    state = nextState;
    allAlerts.push(...alerts);
  }

  // Build messages per store and resolve recipients.
  let users = [];
  try {
    users = await sql()`SELECT id, name, email, phone, user_type, district, store_pc FROM users WHERE user_type IN ('manager','dm') AND active = true`;
  } catch (e) { console.warn('[no-clockin] recipient lookup failed:', e.message); }

  const messages = [];
  for (const store of stores) {
    const forStore = allAlerts.filter(a => a.pc === store.pc);
    if (!forStore.length) continue;
    const record = storeRecords[store.pc];
    const districtStore = { ...store, district: record?.district ?? store.district };
    for (const m of buildMessages(forStore)) {
      const recipients = m.audience.flatMap(role => contactsFor(role, districtStore, users, record));
      messages.push({ ...m, recipients });
    }
  }

  if (live) {
    for (const m of messages) {
      if (!m.recipients.length) { console.warn('[no-clockin] no recipients for', m.stage, m.storeName); continue; }
      await deliver(bs, m.recipients, m.subject, m.text);
    }
    await bs.setJSON(STATE_KEY, { savedAt: new Date().toISOString(), data: pruneState(state, nowMs) });
  }

  const summary = {
    ok: true, live, dryRun, truncated, stores: stores.length, candidates: candidateCount,
    punchStatuses: statusCounts,
    messages: messages.map(m => ({ stage: m.stage, store: m.storeName, subject: m.subject, text: m.text, recipients: m.recipients.length })),
  };
  console.log('[no-clockin]', JSON.stringify({ ...summary, messages: summary.messages.length }));
  return json(summary);
};
```

- [ ] **Step 4: Syntax-check everything and run the suite**

Run: `node --check netlify/functions/no-clockin-cron.mjs && node --check netlify/functions/_shared/channels.mjs && npm test`
Expected: no syntax errors; test suite passes.

- [ ] **Step 5: Do not commit yet**

Single commit at the end (Task 3, Step 2).

---

### Task 3: Docs, rollout and verification against real data

**Files:**
- Modify: `CLAUDE.md` (functions list, scheduled-functions table, env-var table)

**Interfaces:**
- Consumes: the deployed `no-clockin-cron` function from Task 2.

- [ ] **Step 1: Document the feature in CLAUDE.md**

Add to the Netlify Functions list (under Labor, after `schedule-alerts.js`):
```
  no-clockin-cron.mjs         — No clock-in alerts: 30 min → manager, 60 min → absent to manager + DM (SMS + push + email)
```
Add a row to the Scheduled Functions table:
```
| `no-clockin-cron` | `*/15 * * * *` | log-only until `NO_CLOCKIN_LIVE=true`; checks scheduled shifts with no punch |
```
Add a row to the Environment Variables table:
```
| `NO_CLOCKIN_LIVE` / `TEXTBELT_API_KEY` | `true` enables real sends for no-clockin-cron (unset = log-only); Textbelt SMS key |
```

- [ ] **Step 2: Single commit (ask the user first)**

Ask the user for the OK to commit, then make ONE commit for the whole feature (spec, plan, logic, function, docs):

```bash
git add docs/superpowers/specs/2026-09-21-no-clockin-alerts-design.md docs/superpowers/plans/2026-09-21-no-clockin-alerts.md \
  src/no-clockin.mjs src/no-clockin.test.mjs netlify/functions/_shared/channels.mjs \
  netlify/functions/no-clockin-cron.mjs netlify/functions/labor-cron.mjs CLAUDE.md
git commit -m "feat(no-clockin): 30/60-min no clock-in alerts by SMS, push and email (log-only until NO_CLOCKIN_LIVE=true)"
```

- [ ] **Step 3: Ask the user before deploying**

Pushing to `main` is the production deploy and starts the schedule (in log-only mode, because `NO_CLOCKIN_LIVE` is unset). **Stop and get the user's explicit OK before `git push`.** Scheduled functions do not run on preview deploys, and the exec session cookie only works on `pcg-ops.netlify.app`, so real-data verification happens after the prod deploy in log-only mode.

- [ ] **Step 4: Dry run against real data (after the user approves the push)**

While logged in to https://pcg-ops.netlify.app as an exec/IT user, in the browser console:

```js
fetch('/.netlify/functions/no-clockin-cron?dryRun=1', { method: 'POST', credentials: 'include' })
  .then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))
```

Expected: `{ ok: true, dryRun: true, live: false, candidates: N, punchStatuses: {...}, messages: [...] }`, with nothing sent.

Check, and fix in code if wrong:
- **`punchStatuses` has `404` entries:** Paycor may answer 404 for an employee with no punches. If a 404 employee is clearly someone who has not clocked in, change `fetchPunches` in `no-clockin-cron.mjs` to return `[]` for `res.status === 404`; otherwise real no-shows would be silently treated as unknown.
- **Times:** each message's `6:00a`-style time matches the actual shift start in Paycor's schedule (Eastern).
- **Recipients:** each message shows a non-zero `recipients` count; if 0, the store has no manager user / no `mgrPhone` and the DM lookup did not match.
- **Names:** people listed really have not clocked in (spot-check two in Paycor).

- [ ] **Step 5: Test the three channels end to end**

Same console, but send a sample to yourself only:

```js
fetch('/.netlify/functions/no-clockin-cron?dryRun=1&sendTest=1', { method: 'POST', credentials: 'include' })
  .then(r => r.json()).then(console.log)
```

Expected: `{ ok: true, sendTest: true, delivered: { phones: 1, emails: 1, push: 1 } }` and you receive a text, an app notification and an email. If a count is 0, that channel has no data for your user (phone on your Users record, or a push subscription from the installed PWA).

- [ ] **Step 6: Go live (needs the user's OK)**

Once the dry run looks right and the user approves:

```bash
npx netlify env:set NO_CLOCKIN_LIVE true
```

Then redeploy or wait for the next cold start, and watch the function logs (`[no-clockin]` lines) through the first morning: confirm at most one warn30 and one absent message per person per shift, and that clocked-in people are never messaged.

---

## Self-Review Notes

- **Spec coverage:** 30/60-minute rules, manager vs manager+DM audiences (Task 1 `AUDIENCE`, Task 2 `contactsFor`); all three channels with per-channel isolation (`deliver` uses `Promise.allSettled`; helpers never throw); unknown-on-error (`punchesByEmp` null); mass-miss guard (`MASS_MISS`); elapsed-time (not run-counter) timing (`planAlerts`); punch window (`hasClockedIn`); live re-fetch of shifts (Task 2); ET formatting (`fmtEt`); blob state + 14-day prune (`pruneState`, `STATE_KEY`); `dryRun` exec/IT only (Task 2); reads only, no writes to `stores`/`users`. Spec open items are settled: recipients come from the `users` table (`manager` by `store_pc`, `dm` by `district`) with the store record's `mgrPhone` as a manager fallback, and the Textbelt quota is left to the user to watch during go-live.
- **Additions beyond the spec, both for safe rollout:** the `NO_CLOCKIN_LIVE` flag and the `sendTest` sample alert.
- **Known limits:** the schedule-blob pre-filter can be up to ~1 hour stale (labor-cron refreshes hourly), so a shift added within the last hour may be missed; a 20-second deadline defers remaining stores to the next run.
