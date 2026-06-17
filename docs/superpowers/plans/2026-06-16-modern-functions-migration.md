# Plan: Migrate all Netlify Functions off Lambda compatibility mode

**Date:** 2026-06-16
**Branch:** `chore/modern-functions-migration` (off `main` @ v15.73)
**Status:** Plan only — execute in a focused session with branch-deploy verification before any prod deploy.

## Why
- **Unblocks prod deploys.** New functions can't be created while the site is in Lambda compatibility mode and total env vars exceed AWS Lambda's **4 KB** cap (mainly `GOOGLE_SERVICE_ACCOUNT_KEY`). The limit only lifts once **every** function is on the modern runtime — it's all-or-nothing.
- **Deadline.** Netlify stops accepting compat-mode deploys **2027-07-01**.

## Scope
**54 handler-style functions** in `netlify/functions/*.js`. Shared libs (`analyst-lib/`, `deal-lib/`, `ndcp-lib/`, `auth-lib/`) are pure modules — **no change** unless they import the handler shape. Categories:
- **Proxies:** pulse, paycor, geocode, drive-time, philly-data, philly-zoning
- **Data/API:** storage, db, db-migrate, food-cost, kb-search, kb-manage, kb-embed, kb-sync(+bg), reconciliation(+cron), ndcp, ndcp-backfill, ndcp-sync-cron, deals, deal-docs, par-preview, pulse-notify, reports-backup
- **Auth (high-risk):** portal-auth, deal-auth, trusted-devices, trusted-devices-reset
- **Comms:** notify, email-send, sms, push
- **AI:** analyst, analyst-cron(+bg), analyst-report-background, mcp, daily-feed
- **Scheduled (19, see netlify.toml) + background (8, `*-background.js`)** — trickiest; schedule + background semantics differ on the modern runtime.

## Transformation pattern (per function)
**Old (Lambda compat):**
```js
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const body = JSON.parse(event.body || '{}');
  const q = event.queryStringParameters || {};
  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
```
**New (modern):**
```js
export default async (request, context) => {
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers });
  const body = await request.json().catch(() => ({}));
  const q = Object.fromEntries(new URL(request.url).searchParams);
  return new Response(JSON.stringify(result), { status: 200, headers });
};
```
Mapping cheatsheet: `event.httpMethod`→`request.method`; `event.body`→`await request.text()/json()`; `event.queryStringParameters`→`new URL(request.url).searchParams`; `event.headers.x`→`request.headers.get('x')`; `{statusCode,headers,body}`→`new Response(body,{status,headers})`. `process.env` still works (no 4 KB cap on modern runtime).

## Open items to VERIFY first (don't assume)
1. **Scheduled functions:** confirm whether `netlify.toml [functions.x] schedule` is still honored on the modern runtime, or must move in-file to `export const config = { schedule: "…" }`. Plan assumes **move schedules in-code** + keep/clean toml.
2. **Background functions:** confirm modern equivalent of `*-background.js` (15-min) — likely `export const config = { type: 'background' }` or retained naming. Verify before touching the 8.
3. **`mcp.js`:** confirm MCP HTTP contract (status/headers/streaming) survives the Response rewrite.
4. **Reserved-key/env behavior** on modern runtime for the big service-account key.

## Execution order (batch + verify each on a branch deploy)
1. **Proxies** (6) → verify via `curl` (e.g. pulse 2025 date, geocode, drive-time).
2. **Data/API** (~18) → curl + UI smoke (storage read/write, food cost, kb search, reconciliation).
3. **Auth** (4) → login, 2FA trusted-device, deal-auth — test in UI carefully.
4. **Comms** (4) → trigger a test notify/email/sms/push.
5. **AI** (5) → analyst run, mcp tool call, daily-feed.
6. **Scheduled + background** (last) → migrate schedule/background config; manually trigger each cron; confirm next-run registration.

After each batch: push branch → Netlify **branch deploy** → exercise that batch. Do NOT prod-deploy until ALL 54 are migrated and the branch deploy is fully green (and the 4 KB "create function" error is gone).

## Verification gate (before merge→prod)
- Branch deploy succeeds with **no** "environment variables exceed 4KB" error (proves all functions are modern).
- Smoke matrix passes: Pulse sales, labor cron (manual), analyst, auth/login, push, email, MCP, NDCP, reconciliation.
- `npm test` green; `APP_VERSION` bumped.
- Then PR → review → merge → `netlify deploy --prod`.

## Risks & rollback
- **Risk:** auth/session, scheduled-job registration, background timeouts, MCP contract. **Mitigation:** batch + branch-deploy verification; auth + crons migrated last and tested hardest.
- **Rollback:** all work on this branch; if the branch deploy misbehaves, don't merge — prod stays on compat mode (still functional, just can't add new functions) until fixed.

## Done criteria
All 54 functions modern; schedules/background re-wired & verified; branch deploy clean (4 KB error gone); smoke matrix green; merged; prod deploy of v15.73+ succeeds and the previously-blocked new functions (competitor-cron, par-preview, pulse-item-backfill-background, drive-time) are live.
