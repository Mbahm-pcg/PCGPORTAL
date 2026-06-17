# Modern Functions Migration — Locked Pattern & Findings

Execution notes for `2026-06-16-modern-functions-migration.md`. Read before touching any function.

## Verified findings (from the geocode spike + recon)

1. **Interim branch deploys are IMPOSSIBLE.** The site is in Lambda compatibility mode (a site-level state, kept on by *any* legacy `exports.handler` function). While in compat mode + env vars > 4KB, **every** deploy fails at function-creation with `environment variables exceed the 4KB limit`. So we cannot deploy-verify per batch — only **after all functions are modern** does the site flip off compat mode and the first deploy can succeed. → Per-batch verification is **local** via `netlify functions:serve`; one real branch deploy at the very end.
2. **`.mjs` packaging works** (geocode bundled + ran). We rename each migrated handler `.js`→`.mjs` so the CommonJS shared libs (`analyst-lib/`, `deal-lib/`, `ndcp-lib/`, `auth-lib/`, `_shared/`) stay untouched. Do **NOT** add `"type":"module"` to package.json — it would break every CJS lib.
3. **`db.js` was a phantom function** (no handler, top-level) → relocated to `_shared/db.js`. Subdirs are not treated as functions by Netlify. A no-handler CJS top-level file would have kept the site in compat mode forever.
4. **The plan's OPTIONS cheatsheet is wrong.** `new Response('', {status:204})` throws (204 is a null-body status). Must be `new Response(null, {status:204, headers})`.

## Locked transformation pattern (per function)

- Rename `foo.js` → `foo.mjs` (`git mv`).
- Imports: `import https from 'node:https'`; local libs **with extension**: `import { sql } from './_shared/db.js'`, `import { x } from './analyst-lib/y.js'`. ESM→CJS interop is fine (Netlify bundles with esbuild).
- Signature: `export default async (request, context) => { ... }`
- Method: `request.method` (was `event.httpMethod`)
- OPTIONS: `if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });`
- Body: `await request.json().catch(() => ({}))` or `await request.text()` (was `JSON.parse(event.body||'{}')`)
- Query: `const q = Object.fromEntries(new URL(request.url).searchParams)` (was `event.queryStringParameters`)
- Headers in: `request.headers.get('x')` (was `event.headers['x']` — note lowercase)
- Return: `new Response(JSON.stringify(result), { status, headers })` (was `{statusCode, headers, body}`)
- `process.env` unchanged. Preserve **all** existing logic, status codes, headers, and behavior exactly.

## Scheduled functions
- Remove the `[functions.NAME] schedule` block from `netlify.toml`.
- Add in-file: `export const config = { schedule: "CRON" };`
- The invocation is a POST; if the code needs it: `const { next_run } = await request.json().catch(()=>({}))`. Most crons ignore the body.

## Background functions (`*-background.js`)
- Rename `*-background.js` → `*-background.mjs` (the `-background` suffix still triggers background mode), OR add `export const config = { background: true }`. We keep the suffix AND add the config for clarity.
- Background returns 202 automatically; no response body reaches the caller.

## Sibling-handler wrappers (special)
These import another function's `handler` — which no longer exists on modern:
- `labor-cron-warmup` → `labor-cron`; `*-background` → its foreground sibling (analyst-cron, competitor-cron, kb-sync, labor-cron).
- Fix: the foreground fn `export default`s its handler; the wrapper does `import run from './sibling.mjs'; export default run;` (+ its own `export const config`). Verify the foreground default is callable with `(request, context)`.

## Verification per batch (local)
```
npx netlify functions:serve --port 9999   # legacy fns log "Lambda compatibility mode"; migrated ones don't
curl ... the migrated endpoints           # exercise real behavior, check status codes
node --check netlify/functions/<f>.mjs     # syntax
```
Final gate only: `npm test`, `npm run build`, bump `APP_VERSION`, one branch deploy (must be clean — no 4KB error), full smoke, then PR.
