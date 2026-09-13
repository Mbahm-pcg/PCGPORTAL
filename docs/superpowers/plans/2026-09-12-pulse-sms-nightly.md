# PCG Pulse Nightly SMS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a nightly SMS (today's + WTD sales, Saturday adds Top-5 by WTD) to Mike & Krunal, piggybacked on the existing PCG Pulse email job, plus a config-page button to send a test SMS with the latest day's data.

**Architecture:** A pure, unit-tested builder `src/pulse-sms.mjs` formats the message. `netlify/functions/pulse-notify.mjs` (the existing nightly job) accumulates per-store WTD in its existing week-loop, builds the SMS, and sends it via an inline Textbelt helper — after the email, best-effort. A `testSms` request mode sends only the SMS to one number and returns the text for preview. The `PulseDailyPanel` config UI in `app.jsx` gains an SMS-recipients field + a test button.

**Tech Stack:** Node ES modules (`.mjs`), Textbelt SMS (`TEXTBELT_API_KEY`), Netlify Blobs (`pcg_pulse_notify_config`, `pcg_stores_v1`), React 18 (JSX, esbuild-bundled), `node:test` + `node:assert`.

## Global Constraints

_Every task's requirements implicitly include this section._

- New/edited function & `src` modules are ES modules (`.mjs`). `pulse-notify.mjs` already `import https from 'node:https'`.
- **Message format (dollars WITH cents, comma-grouped; header `(Ddd M/D)` from the business date):**
  - Nightly (Sun–Fri): three lines — `PCG Pulse Daily Update (Fri 9/11)` / `Today's Sales: $X,XXX.XX` / `WTD Sales: $XXX,XXX.XX` — then `Have a Good Night`.
  - Saturday (business-date weekday === 6): after the WTD line, `Top 5:` then `1) <StoreName> $WTD.cc` … up to 5 (operational stores only, highest WTD first), then `Have a Good Night`.
- Dollar formatter: `'$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`.
- **Recipients:** nightly send uses `config.smsRecipients` (array) from `pcg_pulse_notify_config`, defaulting to `['+12154903936', '+12679340658']` (Mike, Krunal). Test send uses only the single `testTo` from the request.
- **SMS is best-effort:** sent AFTER the email, wrapped so any failure is logged and never blocks the email or the run result.
- Textbelt: `POST https://textbelt.com/text`, form body `phone, message, key`; normalize numbers to E.164 (`+1` + 10 digits).
- `src/pulse-sms.test.mjs` is auto-discovered by the existing `package.json` test glob `'src/*.test.mjs'` — **no package.json change**.
- **`app.jsx` is bundled:** edit `app.jsx` → `npm run build` → commit BOTH `app.jsx` and `app.js`. Edit the **live** `PulseDailyPanel` component, NOT the dead `{false && (() => { … })()}` duplicate that follows it.
- **Deploy safety (see the `pcg-deploy-drift-safety` memory):** reconcile with `origin/main` FIRST (`git fetch` + fast-forward — Ahmed pushes daily, incl. to `paycor.mjs`); set `APP_VERSION` to one above the current `origin/main` value; `npm test`; commit; run `git push origin main` on its own (NEVER piped through `tail`/`head` — a pipe masks a rejected push); confirm it fast-forwarded; then `npx netlify deploy --prod`; verify live shows the new version AND Ahmed's latest work intact.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/pulse-sms.mjs` | **New.** Pure builder: `fmtUSD`, `topStoresByWtd`, `buildPulseSms`. Zero I/O. | 1 |
| `src/pulse-sms.test.mjs` | **New.** `node:test` unit tests for the builder. | 1 |
| `netlify/functions/pulse-notify.mjs` | **Modify.** Inline `sendSms` helper; parse body for `testSms`/`testTo`; accumulate per-store WTD; build + send SMS (nightly best-effort + test mode). | 2 |
| `app.jsx` | **Modify.** `PulseDailyPanel`: SMS-recipients field + test-to input + "Send Test Pulse SMS" button + preview; `APP_VERSION` bump. | 3 |

---

## Task 1: Pure SMS builder — `src/pulse-sms.mjs`

**Files:**
- Create: `src/pulse-sms.mjs`
- Test: `src/pulse-sms.test.mjs`

**Interfaces (Produces):**
- `fmtUSD(n: number) → string` — `"$1,234.56"`.
- `topStoresByWtd(perStoreWtd: {[pc:string]:number}, stores: Array<{pc,name}>, statusByPc?: {[pc:string]:string}, n=5) → Array<{name:string, wtd:number}>` — operational only (`statusByPc[pc]` absent or `'Open'`), sorted desc by wtd, limited to `n`, pc→name mapped.
- `buildPulseSms({ busDt: string /*YYYY-MM-DD*/, todaySales: number, wtdSales: number, perStoreWtd: object, stores: Array, statusByPc?: object }) → string` — nightly text; Saturday (weekday 6, date-only parse) adds Top 5.

- [ ] **Step 1: Write the failing test**

Create `src/pulse-sms.test.mjs`:

```js
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { fmtUSD, topStoresByWtd, buildPulseSms } from './pulse-sms.mjs';

const STORES = [
  { pc: '100', name: 'County Line' },
  { pc: '200', name: '8200' },
  { pc: '300', name: 'Warrington' },
  { pc: '400', name: 'Lansdowne' },
  { pc: '500', name: 'Elkins' },
  { pc: '600', name: 'Willits' },
];

describe('fmtUSD', () => {
  test('comma-grouped, 2 decimals', () => {
    assert.strictEqual(fmtUSD(124530.47), '$124,530.47');
  });
  test('whole number gets .00', () => {
    assert.strictEqual(fmtUSD(40000), '$40,000.00');
  });
  test('zero / nullish', () => {
    assert.strictEqual(fmtUSD(0), '$0.00');
    assert.strictEqual(fmtUSD(null), '$0.00');
  });
});

describe('topStoresByWtd', () => {
  const wtd = { '100': 52300, '200': 49100, '300': 47800, '400': 45200, '500': 44900, '600': 60000 };
  test('sorts desc, limits to n, maps names', () => {
    const top = topStoresByWtd(wtd, STORES, {}, 5);
    assert.deepStrictEqual(top.map(s => s.name), ['Willits', 'County Line', '8200', 'Warrington', 'Lansdowne']);
    assert.strictEqual(top.length, 5);
    assert.strictEqual(top[0].wtd, 60000);
  });
  test('excludes non-operational stores', () => {
    const top = topStoresByWtd(wtd, STORES, { '600': 'Temp Closed' }, 5);
    assert.ok(!top.some(s => s.name === 'Willits'));
    assert.strictEqual(top[0].name, 'County Line');
  });
  test('fewer than n available', () => {
    const top = topStoresByWtd({ '100': 10, '200': 5 }, STORES, {}, 5);
    assert.strictEqual(top.length, 2);
  });
});

describe('buildPulseSms', () => {
  const base = { todaySales: 124530.47, wtdSales: 842100.19, perStoreWtd: {}, stores: STORES, statusByPc: {} };
  test('nightly (Fri 2026-09-11): 3 lines + closing, no Top 5', () => {
    const msg = buildPulseSms({ ...base, busDt: '2026-09-11' });
    assert.strictEqual(msg,
      'PCG Pulse Daily Update (Fri 9/11)\n' +
      "Today's Sales: $124,530.47\n" +
      'WTD Sales: $842,100.19\n' +
      'Have a Good Night');
  });
  test('Saturday (2026-09-12): adds Top 5 before closing', () => {
    const perStoreWtd = { '100': 52300, '200': 49100, '300': 47800, '400': 45200, '500': 44900 };
    const msg = buildPulseSms({ ...base, busDt: '2026-09-12', wtdSales: 990400.55, perStoreWtd });
    assert.strictEqual(msg,
      'PCG Pulse Daily Update (Sat 9/12)\n' +
      "Today's Sales: $124,530.47\n" +
      'WTD Sales: $990,400.55\n' +
      'Top 5:\n' +
      '1) County Line $52,300.00\n' +
      '2) 8200 $49,100.00\n' +
      '3) Warrington $47,800.00\n' +
      '4) Lansdowne $45,200.00\n' +
      '5) Elkins $44,900.00\n' +
      'Have a Good Night');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `./pulse-sms.mjs`.

- [ ] **Step 3: Write the implementation**

Create `src/pulse-sms.mjs`:

```js
// src/pulse-sms.mjs
// Pure builder for the nightly PCG Pulse SMS. No I/O — unit-tested.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "$1,234.56" — comma-grouped, always 2 decimals. */
export function fmtUSD(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Parse "YYYY-MM-DD" as a date-only value (no timezone drift). */
function parseBusDt(busDt) {
  const [y, m, d] = String(busDt).split('-').map(Number);
  return { m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

/**
 * Top N stores by WTD net sales, operational only, mapped to display names.
 * @param {{[pc:string]: number}} perStoreWtd
 * @param {Array<{pc:string,name:string}>} stores
 * @param {{[pc:string]: string}} statusByPc  pc -> status; missing = treated as operational
 * @param {number} n
 */
export function topStoresByWtd(perStoreWtd, stores, statusByPc = {}, n = 5) {
  const nameByPc = {};
  for (const s of stores) nameByPc[String(s.pc)] = s.name;
  return Object.entries(perStoreWtd)
    .filter(([pc]) => !statusByPc[pc] || statusByPc[pc] === 'Open')
    .map(([pc, wtd]) => ({ name: nameByPc[String(pc)] || String(pc), wtd: Number(wtd) || 0 }))
    .sort((a, b) => b.wtd - a.wtd)
    .slice(0, n);
}

/**
 * Build the nightly SMS text. Saturday (busDt weekday === 6) adds a Top 5 by WTD.
 * @param {{ busDt:string, todaySales:number, wtdSales:number, perStoreWtd:object, stores:Array, statusByPc?:object }} args
 */
export function buildPulseSms({ busDt, todaySales, wtdSales, perStoreWtd, stores, statusByPc = {} }) {
  const { m, d, dow } = parseBusDt(busDt);
  const lines = [
    `PCG Pulse Daily Update (${DOW[dow]} ${m}/${d})`,
    `Today's Sales: ${fmtUSD(todaySales)}`,
    `WTD Sales: ${fmtUSD(wtdSales)}`,
  ];
  if (dow === 6) {
    lines.push('Top 5:');
    topStoresByWtd(perStoreWtd, stores, statusByPc, 5)
      .forEach((s, i) => lines.push(`${i + 1}) ${s.name} ${fmtUSD(s.wtd)}`));
  }
  lines.push('Have a Good Night');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — all `pulse-sms` cases green. (A pre-existing unrelated failure `ndcp-lib/store-map.test.js` may remain; confirm no NEW failures.)

- [ ] **Step 5: Commit**

```bash
git add src/pulse-sms.mjs src/pulse-sms.test.mjs
git commit -m "feat(pulse-sms): pure SMS builder + tests"
```

---

## Task 2: Wire SMS into `pulse-notify.mjs`

**Files:**
- Modify: `netlify/functions/pulse-notify.mjs`

**Interfaces:**
- Consumes: `buildPulseSms` from `../../src/pulse-sms.mjs`.
- Produces: nightly SMS to `config.smsRecipients` (default `['+12154903936','+12679340658']`) after the email; and a `{ testSms:true, testTo }` request mode returning `{ ok, busDt, message, sms }`.

- [ ] **Step 1: Add the import**

At the top of `netlify/functions/pulse-notify.mjs`, after the existing `import { recordHealth } from './health-lib/record-health.mjs';` line, add:

```js
import { buildPulseSms } from '../../src/pulse-sms.mjs';
```

- [ ] **Step 2: Add the inline Textbelt `sendSms` helper**

Add this near the other module-level helpers (e.g. just after the `fmtNum` definition):

```js
// Best-effort SMS via Textbelt (same provider/contract as sms.mjs). Never throws.
async function sendSms(numbers, message) {
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
```

- [ ] **Step 3: Parse the request body for the test flags**

In the handler, immediately after the line `const isManual = request.method === 'POST' && request.headers.get('x-pcg-invocation') !== 'scheduled';`, add:

```js
  let body = {};
  if (request.method === 'POST') { try { body = await request.json(); } catch {} }
  const testSms = !!body.testSms;
  const testTo = body.testTo;
```

(`isManual` is header-derived, so a manual/test POST still bypasses the once-a-day guard and the disabled-config check — correct for testing.)

- [ ] **Step 4: Accumulate per-store WTD in the existing week loop**

Replace the existing WTD block (from `const weekDates = getWeekDates(busDt);` through the end of its `for (const date of weekDates) { … }` loop) with:

```js
    // 3. Calculate WTD (network) + per-store WTD (for Saturday Top 5) in one pass.
    const weekDates = getWeekDates(busDt);
    let wtd = { netSales: 0, guests: 0, voids: 0, discounts: 0, forecast: 0 };
    const perStoreWtd = {};
    for (const date of weekDates) {
      const dayRes = (date === busDt) ? dailyResults : await fetchAllStores(date);
      const dayAgg = (date === busDt) ? daily : aggResults(dayRes);
      wtd.netSales  += dayAgg.netSales;
      wtd.guests    += dayAgg.guests;
      wtd.voids     += dayAgg.voids;
      wtd.discounts += dayAgg.discounts;
      wtd.forecast  += dayAgg.forecast;
      for (const [pc, r] of Object.entries(dayRes)) {
        if (r.status === 'ok') perStoreWtd[pc] = (perStoreWtd[pc] || 0) + r.data.netSales;
      }
    }
    console.log(`WTD: $${wtd.netSales.toFixed(2)} over ${weekDates.length} days`);
```

- [ ] **Step 5: Build the SMS and add the test-mode short-circuit**

After the `const storeStatuses = await loadStoreStatuses(store);` line and its `wtd.days = weekDates.length;` / `buildSummary(...)` call (i.e. after step "5. Build notification content"), and BEFORE "6. Send push notifications", insert:

```js
    // Build the nightly SMS text (Saturday adds Top 5 by WTD).
    const smsMessage = buildPulseSms({
      busDt,
      todaySales: daily.netSales,
      wtdSales: wtd.netSales,
      perStoreWtd,
      stores: STORES,
      statusByPc: storeStatuses,
    });

    // Test mode: send ONLY the SMS to the requested number; no email/push, no guard write.
    if (testSms) {
      let sms = { sent: 0, results: [] };
      try { sms = await sendSms(testTo ? [testTo] : [], smsMessage); } catch (e) { sms = { sent: 0, error: e.message }; }
      return new Response(JSON.stringify({ ok: true, testSms: true, busDt, message: smsMessage, sms }), { status: 200, headers });
    }
```

- [ ] **Step 6: Send the nightly SMS after the email (best-effort)**

Immediately after the existing email block (`await sendEmail(emailTo, …); console.log('Email sent to:', emailTo);`) and before `const result = { … }`, insert:

```js
    // 7b. Send SMS to configured recipients — best-effort, never blocks the email/result.
    const smsTo = config.smsRecipients || ['+12154903936', '+12679340658'];
    let smsResult = { sent: 0, results: [] };
    try { smsResult = await sendSms(smsTo, smsMessage); console.log('SMS result:', smsResult); }
    catch (e) { console.warn('SMS send failed (non-blocking):', e.message); }
```

Then add an `sms` field to the `result` object (so it's recorded in the run log). Change the `result` object to include:

```js
      sms: { sent: smsResult.sent, to: smsTo },
```

(add that line alongside the existing `email: { to: emailTo },` line inside `const result = { … }`).

- [ ] **Step 7: Verify it parses and the pure module still passes**

Run: `node --check netlify/functions/pulse-notify.mjs`
Expected: exit 0.

Run: `npm test`
Expected: PASS — `pulse-sms` tests still green, no NEW failures. _(No unit test covers the cron's I/O; it's verified by `node --check` here and live via the Task 3 test button.)_

- [ ] **Step 8: Commit**

```bash
git add netlify/functions/pulse-notify.mjs
git commit -m "feat(pulse-notify): send nightly Pulse SMS + testSms mode"
```

---

## Task 3: Config UI — SMS recipients + test button (`app.jsx`)

**Files:**
- Modify: `app.jsx` (the `PulseDailyPanel` component — locate by grepping `function PulseDailyPanel`; do NOT edit the dead `{false && …}` duplicate that follows it)
- Regenerate: `app.js` (via `npm run build`)

**Interfaces:**
- Consumes: the `pulse-notify` `{ testSms:true, testTo }` mode (Task 2); `pcg_pulse_notify_config` via the existing storage load/save (unauthenticated, plain `Content-Type` fetch — match the existing calls exactly).

- [ ] **Step 1: Add state hooks**

In `PulseDailyPanel`, after the existing `const [pulseEmails, setPulseEmails] = React.useState("mike@peoplecapitalgroup.com");` add:

```jsx
  const [pulseSms, setPulseSms] = React.useState("+12154903936, +12679340658");
  const [pulseTestTo, setPulseTestTo] = React.useState("+12154903936");
  const [pulseSmsStatus, setPulseSmsStatus] = React.useState(null);
  const [pulseSmsPreview, setPulseSmsPreview] = React.useState("");
```

- [ ] **Step 2: Load `smsRecipients` from config**

In the init-once loader, after `setPulseEmails((cfg.emailRecipients || []).join(', '));` add:

```jsx
            if (cfg.smsRecipients && cfg.smsRecipients.length) setPulseSms(cfg.smsRecipients.join(', '));
```

- [ ] **Step 3: Save `smsRecipients`**

In `savePulseConfig`, change the `cfg` object to include `smsRecipients`. Replace the `const cfg = { … }` line with:

```jsx
      const cfg = { enabled: pulseEnabled, emailRecipients: pulseEmails.split(',').map(e => e.trim()).filter(Boolean), smsRecipients: pulseSms.split(',').map(s => s.trim()).filter(Boolean), time: pulseTime, updatedAt: new Date().toISOString(), updatedBy: user?.name };
```

- [ ] **Step 4: Add the test-SMS handler**

Add this function next to the existing `triggerPulseNow`:

```jsx
  const sendTestPulseSms = async () => {
    setPulseSmsStatus("sending"); setPulseSmsPreview("");
    try {
      const res = await fetch('/.netlify/functions/pulse-notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testSms: true, testTo: pulseTestTo.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setPulseSmsPreview(data.message || "");
        const sent = data.sms && data.sms.sent > 0;
        setPulseSmsStatus(sent ? "ok" : "fail");
        showAlert(sent ? "success" : "error", sent ? "Test SMS sent" : ("Not sent: " + ((data.sms && data.sms.results && data.sms.results[0] && data.sms.results[0].error) || "check number/quota")));
      } else { setPulseSmsStatus("fail"); showAlert("error", "Test failed: " + (data.error || res.status)); }
    } catch (e) { setPulseSmsStatus("fail"); showAlert("error", "Error: " + e.message); }
    setTimeout(() => setPulseSmsStatus(null), 6000);
  };
```

- [ ] **Step 5: Add the SMS-recipients field, test-to input, button, and preview**

In the panel's JSX, near the email-recipients input and the "⚡ Run Pulse Now" button, add (match the surrounding inline-style/`inp(th)`/`btn(th)` conventions):

```jsx
      <label style={{ display: "block", fontSize: "0.75rem", color: th.muted, margin: "0.75rem 0 0.25rem" }}>SMS Recipients (comma-separated)</label>
      <input style={inp(th)} value={pulseSms} onChange={e => setPulseSms(e.target.value)} placeholder="+12154903936, +12679340658" />

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <input style={{ ...inp(th), flex: 1 }} value={pulseTestTo} onChange={e => setPulseTestTo(e.target.value)} placeholder="+12154903936" />
        <button onClick={sendTestPulseSms} disabled={pulseSmsStatus === "sending"} style={btn(th, { padding: "0.5rem 0.75rem", fontSize: "0.8rem", opacity: pulseSmsStatus === "sending" ? 0.6 : 1 })}>
          {pulseSmsStatus === "sending" ? "⏳ Fetching…" : pulseSmsStatus === "ok" ? "✅ Sent!" : pulseSmsStatus === "fail" ? "❌ Failed" : "📱 Send Test Pulse SMS (last day)"}
        </button>
      </div>
      {pulseSmsPreview ? <pre style={{ ...card(th), padding: "0.6rem", marginTop: "0.5rem", fontSize: "0.75rem", whiteSpace: "pre-wrap", color: th.text }}>{pulseSmsPreview}</pre> : null}
```

- [ ] **Step 6: Bump `APP_VERSION`**

Find `const APP_VERSION =` and set it to one patch above the current `origin/main` value (verify current first — e.g. if live is `v20.77`, set `v20.78`).

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: esbuild writes `app.js`, exit 0, no errors.

- [ ] **Step 8: Verify the wiring made the bundle**

Run: `grep -c "Send Test Pulse SMS" app.js`
Expected: ≥ 1.

- [ ] **Step 9: Commit**

```bash
git add app.jsx app.js
git commit -m "feat(pulse): SMS recipients field + test-SMS button in Pulse config"
```

---

## Manual Verification (after deploy)

1. As `mike.bahm`, open the Pulse config panel. Confirm the **SMS Recipients** field shows the two numbers (or your saved list), and **Save** persists them.
2. Put your number in the test-to box → **📱 Send Test Pulse SMS (last day)**. Confirm: you receive a text, and the on-screen **preview** matches it.
3. If the latest business day is a Saturday, confirm the text includes `Top 5:` with 5 stores by WTD; otherwise confirm the 3-line nightly format ending in `Have a Good Night`.
4. Confirm the nightly run still sends the email (unchanged) and now also texts `config.smsRecipients`. (Either wait for the 10pm run, or use "⚡ Run Pulse Now" which now also sends the SMS to the configured list.)
5. Textbelt quota: `curl -s -X POST <site>/.netlify/functions/sms -d '{"action":"quota"}'` — confirm quota is decrementing / sufficient.

## Deploy

Follow the Global Constraints deploy-safety sequence exactly: reconcile with `origin/main`, rebuild, `npm test`, commit, **un-piped** `git push origin main` (confirm fast-forward), `npx netlify deploy --prod`, verify live version + Ahmed's work intact.

---

## Self-Review

**1. Spec coverage:**
- Nightly SMS (today's + WTD, with cents, `Have a Good Night`) piggybacked on `pulse-notify` after the email → Task 2. ✅
- Saturday Top-5 by WTD, per-store WTD with no extra API calls (accumulated in the existing loop) → Task 2 step 4 + Task 1 `topStoresByWtd`. ✅
- `config.smsRecipients` default Mike+Krunal, editable in config page → Task 2 (default) + Task 3 (field/load/save). ✅
- Test button sends latest-day SMS to a typed number (default Mike's), previews the text → Task 2 (`testSms` mode) + Task 3 (button/handler/preview). ✅
- Textbelt sender, best-effort, never blocks email → Task 2 steps 2 & 6. ✅
- Operational-store filter for Top 5 (avoids listing temp-closed like 345986) → Task 1 `topStoresByWtd` + `statusByPc` from `loadStoreStatuses`. ✅
- Deploy reconciles with Ahmed's main; no masked push → Global Constraints + Deploy. ✅

**2. Placeholder scan:** No TBD/vague steps — every code step has complete code; the only deferred value is `APP_VERSION` (bump relative to live at deploy time, which can't be hardcoded because Ahmed keeps advancing it — instruction is explicit). ✅

**3. Type consistency:** `buildPulseSms({busDt, todaySales, wtdSales, perStoreWtd, stores, statusByPc})` is called in Task 2 step 5 with exactly those keys (`todaySales: daily.netSales`, `wtdSales: wtd.netSales`, `stores: STORES`, `statusByPc: storeStatuses`). `perStoreWtd` shape `{pc:number}` produced in step 4 matches what `topStoresByWtd` consumes. `sendSms(numbers, message) → {sent, results}` used consistently in test mode and nightly. Config key `smsRecipients` consistent across Task 2 default and Task 3 load/save. ✅
