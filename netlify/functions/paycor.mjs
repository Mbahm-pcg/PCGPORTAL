// PCG Portal — Paycor API Proxy
// Handles OAuth token management and proxies requests to the Paycor Public API.
// Credentials live in Netlify env vars (never exposed to the browser).

import https from 'node:https';
import { getStore } from '@netlify/blobs';

const PAYCOR_API_HOST = 'apis.paycor.com';
const PAYCOR_AUTH_HOST = 'apis.paycor.com';
const TOKEN_ENDPOINT = '/sts/v1/common/token';

// In-memory token cache — L1, fastest path, but only visible within ONE warm
// Lambda instance. On cold start, seed the refresh token from the env var so
// we can immediately exchange it for a fresh access token.
let tokenCache = {
  accessToken: null,
  refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null,
  expiresAt: 0,
};

// Shared L2 cache across ALL instances, via Netlify Blobs — closes the real
// gap that in-memory-only caching can't: confirmed directly (2026-08-19),
// concurrent calls to Paycor from tips-report-cron-background.mjs spun up
// multiple separate cold Lambda instances, each with its own blank
// tokenCache, all racing to exchange the SAME single-use Paycor refresh
// token at once — only one won, the other ~40 of 46 stores failed with the
// same error. An in-memory mutex (like labor-cron.mjs's `refreshPromise`)
// only prevents a race WITHIN one instance's memory; it does nothing across
// separate instances, which is exactly how that incident happened.
//
// Deliberately NOT a distributed lock. A first draft used a Blobs-based
// mutex (acquire/wait/release with a staleness takeover) and it was
// adversarially reviewed before shipping (2026-08-20) — both reviewers
// independently found the same class of problem: the "lock is stale, take
// it over" path was a non-atomic check-then-act (two instances could both
// decide to take over and both proceed), lock release had no ownership
// check (a slow original holder could delete a DIFFERENT instance's
// legitimate takeover), and the wait timeout didn't even cover the refresh
// call's own timeout, so losers could give up and race the winner anyway —
// reproducing the exact bug the lock was built to prevent. Rather than
// patch a lock with three compounding races, this uses NO lock at all:
// Paycor's own single-use-refresh-token behavior is the real arbiter of
// "who wins" a concurrent refresh, and a loser's job is just to detect its
// own rejection and defer to whoever won (see getAccessToken) instead of
// coordinating who gets to try in the first place.
const TOKEN_CACHE_KEY = 'pcg_paycor_token_cache';

// Deliberately a SEPARATE named Blobs store from 'pcg-portal', not just a
// distinctly-named key within it. storage.mjs exposes generic save/load over
// the 'pcg-portal' store with NO authentication at all (confirmed — it has
// no auth check and Access-Control-Allow-Origin: '*', and is already known
// to be bot-scanned). A live Paycor access+refresh token sitting in that
// store under any key, however obscurely named, would be one unauthenticated
// POST away from a full credential leak — obscurity of a key name is not a
// real access control. A separate store name is unreachable through
// storage.mjs's hardcoded 'pcg-portal' regardless of key, closing this by
// construction rather than by hoping nobody guesses the key.
// consistency: 'strong' is load-bearing, not a nice-to-have — confirmed via
// audit (2026-08-20) that without it, Blobs' default eventually-consistent
// reads (up to 60s of edge-cache lag per the SDK) can serve a losing
// instance's post-failure fallback read a stale, pre-write snapshot, missing
// the very token the winning instance already published — directly
// defeating the "loser rechecks the shared cache" design this whole file's
// concurrency model depends on. Every other Blobs consumer in this codebase
// already passes this for the same read-your-writes reason; this store was
// the one place it had been omitted.
function getTokenBlobStore() {
  return getStore({ name: 'pcg-paycor-internal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

async function readSharedTokenCache() {
  try {
    return await getTokenBlobStore().get(TOKEN_CACHE_KEY, { type: 'json' });
  } catch (e) {
    console.warn('[paycor] Shared token cache read failed (falling back to a real refresh):', e.message);
    return null;
  }
}

async function writeSharedTokenCache(tokenData) {
  try {
    await getTokenBlobStore().setJSON(TOKEN_CACHE_KEY, tokenData);
  } catch (e) {
    // Non-fatal — this instance still has the token in its own memory and
    // can serve requests; it just won't have handed the fresh token to
    // other instances, so a few of them may end up refreshing too.
    console.warn('[paycor] Shared token cache write failed (continuing with in-memory only):', e.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// 20s timeout — comfortably under Netlify's ~26s sync-function ceiling, so a
// hung Paycor API rejects cleanly in time for the caller's own try/catch to
// handle it, instead of Netlify's platform killing the whole invocation and
// returning a raw 504 with no chance for our own error handling to run.
// Confirmed directly via Netlify function logs: a real Paycor outage caused
// 85+ consecutive ~30s hangs here, each surfacing as an unhandled 504/500
// with no useful error message and no chance to retry cleanly upstream.
function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname,
      port: 443,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Paycor API request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

// ── OAuth Token Management ───────────────────────────────────────────────────

// Does the actual HTTP exchange with Paycor's token endpoint. Takes the
// refresh token as a parameter (rather than always reading tokenCache
// directly) so the caller can choose the freshest known value — e.g. one
// just read from the shared cache, which may be newer than this instance's
// own in-memory copy if another instance refreshed first.
async function refreshTokenFromPaycor(clientId, clientSecret, subscriptionKey, refreshToken) {
  const formBody = [
    `grant_type=refresh_token`,
    `refresh_token=${encodeURIComponent(refreshToken)}`,
    `client_id=${encodeURIComponent(clientId)}`,
    `client_secret=${encodeURIComponent(clientSecret)}`,
  ].join('&');
  const tokenPath = `${TOKEN_ENDPOINT}?subscription-key=${subscriptionKey}`;

  const res = await new Promise((resolve, reject) => {
    const options = {
      hostname: PAYCOR_AUTH_HOST,
      port: 443,
      path: tokenPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
    };
    const req = https.request(options, (r) => {
      let raw = '';
      r.on('data', d => (raw += d));
      r.on('end', () => {
        try { resolve({ status: r.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: r.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Paycor token refresh timed out')));
    req.write(formBody);
    req.end();
  });

  if (res.status === 200 && res.data.access_token) {
    const fresh = {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token || refreshToken,
      expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000,
    };
    console.log('[paycor] Token refreshed successfully, expires in', res.data.expires_in, 's');
    return fresh;
  }
  console.warn('[paycor] Token refresh returned', res.status, JSON.stringify(res.data).slice(0, 300));
  return null;
}

const NO_TOKEN_MESSAGE = 'NO_TOKEN: No valid access token. The application needs to be activated via the Paycor OAuth flow first. Use the /activate endpoint to start.';

// `forceRefresh` skips the fast-path cache READS (both L1 and L2's
// accessToken) — used by callPaycor's 401-retry, since a 401 means the
// currently cached access token is known-bad and returning it again would
// just repeat the failure. It still reads the shared cache's refreshToken
// value below (not the accessToken), since another instance may have
// already rotated it — using a known-stale refresh token would fail
// pointlessly when a newer one is sitting right there.
async function getAccessToken(forceRefresh = false, knownBadAccessToken = null) {
  const clientId = process.env.PAYCOR_CLIENT_ID;
  const clientSecret = process.env.PAYCOR_CLIENT_SECRET;
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;

  if (!clientId || !clientSecret || !subscriptionKey) {
    throw new Error('Missing Paycor credentials in environment variables');
  }

  let shared = null;
  if (!forceRefresh) {
    // L1: in-memory — fastest, but only visible within this warm instance.
    if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) {
      return tokenCache.accessToken;
    }
    // L2: shared cache across all instances — covers the common case where
    // ANOTHER instance already refreshed recently, needing zero Paycor calls.
    // This alone eliminates the vast majority of the historical race: a
    // token lives up to an hour, so only right at expiry does anyone need to
    // actually refresh at all.
    shared = await readSharedTokenCache();
    if (shared?.accessToken && Date.now() < shared.expiresAt - 60000) {
      tokenCache = shared;
      return shared.accessToken;
    }
  } else {
    shared = await readSharedTokenCache();
  }

  const refreshTokenToUse = shared?.refreshToken || tokenCache.refreshToken;
  if (!refreshTokenToUse) throw new Error(NO_TOKEN_MESSAGE);

  // Same-instance de-duplication: confirmed via audit (2026-08-20) that a
  // batch of concurrent calls within ONE warm instance (e.g. laborSummary's
  // Promise.all over 10 employees) can fan out N concurrent getAccessToken()
  // calls before any of them yields past this point, each otherwise
  // independently consuming the same single-use refresh token. Sharing one
  // in-flight promise here is safe (unlike the cross-instance lock that was
  // scrapped above) — it's plain in-memory state with no persistence, no
  // takeover logic, and no separate release step to get wrong; it just
  // naturally clears via `finally` when the one real attempt settles.
  if (!refreshInFlight) {
    refreshInFlight = doRefresh(clientId, clientSecret, subscriptionKey, refreshTokenToUse, knownBadAccessToken).finally(() => { refreshInFlight = null; });
  }
  const result = await refreshInFlight;

  // Confirmed via re-audit (2026-08-21): the mutex above is a SINGLE shared
  // slot regardless of each caller's own knownBadAccessToken — a joining
  // caller can receive a result that was validated against a DIFFERENT (or
  // no) exclusion than its own, e.g. callPaycor's 401 handler synchronously
  // clears tokenCache.accessToken right before its forced retry, which a
  // concurrent sibling call can observe as an L1 miss and join this same
  // in-flight promise non-forced (knownBadAccessToken=null) — if that
  // sibling happens to be the one whose parameters actually created the
  // promise, its lenient (no-exclusion) fallback check would silently hand
  // the forced caller back the exact token it was trying to avoid. Always
  // independently re-validate the shared result against THIS caller's own
  // exclusion before trusting it, regardless of who initiated the shared
  // attempt or why.
  if (result !== knownBadAccessToken) return result;
  // It WAS the excluded token — the shared slot has already cleared (the
  // above await already ran its `finally`), so this is a fresh, dedicated
  // attempt with our own exclusion, not a second entry into the mutex.
  return doRefresh(clientId, clientSecret, subscriptionKey, refreshTokenToUse, knownBadAccessToken);
}

// Across DIFFERENT instances, no lock: if multiple instances reach this
// point at the same moment, they all attempt this refresh concurrently.
// Paycor's own single-use refresh-token semantics mean at most one of these
// calls can actually succeed — Paycor itself is the real arbiter of "who
// wins," not a hand-rolled distributed lock (see the comment above
// TOKEN_CACHE_KEY for why an earlier lock-based draft was scrapped after
// adversarial review). A loser's job is just to notice its own rejection
// and defer to whoever won.
let refreshInFlight = null;
async function doRefresh(clientId, clientSecret, subscriptionKey, refreshTokenToUse, knownBadAccessToken = null) {
  let fresh = null;
  try {
    fresh = await refreshTokenFromPaycor(clientId, clientSecret, subscriptionKey, refreshTokenToUse);
  } catch (e) {
    console.warn('[paycor] Refresh request failed:', e.message);
  }
  if (fresh) {
    tokenCache = fresh;
    await writeSharedTokenCache(fresh);
    return fresh.accessToken;
  }

  // Our own attempt didn't produce a token (exception, or Paycor rejected
  // it) — most likely because a concurrent instance already consumed the
  // single-use refresh token first. Check the shared cache once more before
  // giving up; the winner has very likely already published by now, since
  // our own failed round-trip just took real time. Confirmed via re-audit
  // (2026-08-20): must also reject a shared-cache read that's literally the
  // SAME token that just failed — a plain expiresAt check alone can't tell
  // "someone else already published a real fix" apart from "nobody has,
  // this is still the known-bad token," and a 401 (which is what makes a
  // caller pass knownBadAccessToken via forceRefresh) isn't necessarily a
  // simple time-based expiry, so the stale entry's expiresAt can still look
  // perfectly valid. Without this check, forceRefresh's whole contract
  // ("the currently cached token is known-bad, don't hand it back") could
  // be silently defeated exactly when it matters most — a genuinely dead
  // refresh token (e.g. the OAuth app was deactivated) with nobody anywhere
  // holding a real replacement yet.
  const shared2 = await readSharedTokenCache();
  if (shared2?.accessToken && shared2.accessToken !== knownBadAccessToken && Date.now() < shared2.expiresAt - 60000) {
    tokenCache = shared2;
    return shared2.accessToken;
  }
  throw new Error(NO_TOKEN_MESSAGE);
}

// ── Paycor API Call ──────────────────────────────────────────────────────────

async function callPaycor(path, method = 'GET', body = null) {
  const token = await getAccessToken();
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;

  const res = await httpsRequest(PAYCOR_API_HOST, `/v1${path}`, method, {
    Authorization: `Bearer ${token}`,
    'Ocp-Apim-Subscription-Key': subscriptionKey,
  }, body);

  // If we get 401, the token (in-memory OR shared) is stale — force an
  // actual refresh rather than re-reading the shared cache, which would
  // likely just hand back the same bad token to every instance hitting the
  // same 401 at once.
  if (res.status === 401) {
    tokenCache.accessToken = null;
    tokenCache.expiresAt = 0;
    const newToken = await getAccessToken(true, token);
    return await httpsRequest(PAYCOR_API_HOST, `/v1${path}`, method, {
      Authorization: `Bearer ${newToken}`,
      'Ocp-Apim-Subscription-Key': subscriptionKey,
    }, body);
  }

  return res;
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  let payload;
  try {
    payload = await request.json().catch(() => ({}));
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
  }

  const { action } = payload;

  try {
    // ── Store initial tokens from the OAuth activation flow ──
    if (action === 'storeTokens') {
      const { accessToken, refreshToken, expiresIn } = payload;
      if (!accessToken || !refreshToken) {
        return new Response(JSON.stringify({ error: 'Missing accessToken or refreshToken' }), { status: 400, headers });
      }
      // Not blocking an overwrite here even when the shared cache already
      // holds a still-valid token — a real, intentional manual re-activation
      // (e.g. enabling a new Data Access scope) is EXPECTED to replace a
      // technically-still-valid token, so refusing that would break the
      // primary legitimate use of this action. What audit (2026-08-20)
      // flagged is that this replacement was previously completely silent —
      // an out-of-order/duplicate activation call could revert the shared
      // cache to an already-rotated refresh token with zero trace to
      // diagnose it by. Logging what's being replaced turns a silent,
      // undiagnosable clobber into a visible one without blocking the
      // legitimate case.
      const previous = await readSharedTokenCache();
      if (previous?.accessToken) {
        console.warn(`[paycor] storeTokens replacing existing shared token (previous expiresAt=${new Date(previous.expiresAt).toISOString()}, still valid=${Date.now() < previous.expiresAt})`);
      }
      tokenCache = {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + (expiresIn || 3600) * 1000,
      };
      // Publish immediately to the shared cache — otherwise a fresh
      // activation would only be visible to whichever single instance
      // happened to handle this request, and every other instance would
      // still be blank until its own next refresh.
      await writeSharedTokenCache(tokenCache);
      return new Response(JSON.stringify({ ok: true, message: 'Tokens stored successfully' }), { status: 200, headers });
    }

    // ── Check token status ──
    if (action === 'status') {
      // Prefer whichever of {shared, local} is actually fresher (by
      // expiresAt), not just whichever happens to have a non-null
      // accessToken — a shared-cache WRITE can fail non-fatally after a
      // successful local refresh (see writeSharedTokenCache), which would
      // otherwise make status report a stale/invalid token even while this
      // instance is actively serving requests fine with a valid one.
      const shared = await readSharedTokenCache();
      const effective = shared && (shared.expiresAt || 0) >= (tokenCache.expiresAt || 0) ? shared : tokenCache;
      return new Response(JSON.stringify({
        hasToken: !!effective.accessToken,
        hasRefreshToken: !!effective.refreshToken,
        expiresAt: effective.expiresAt,
        isValid: !!(effective.accessToken && Date.now() < effective.expiresAt),
        hasCredentials: !!(process.env.PAYCOR_CLIENT_ID && process.env.PAYCOR_CLIENT_SECRET && process.env.PAYCOR_SUBSCRIPTION_KEY),
      }), { status: 200, headers });
    }

    // ── Get the activation URL for OAuth flow ──
    if (action === 'activationUrl') {
      const clientId = process.env.PAYCOR_CLIENT_ID;
      const url = `https://hcm.paycor.com/appactivation/clientactivation?clientId=${clientId}`;
      return new Response(JSON.stringify({ url }), { status: 200, headers });
    }

    // ── Proxy: list legal entities for a tenant ──
    if (action === 'legalEntities') {
      const { tenantId } = payload;
      if (!tenantId) return new Response(JSON.stringify({ error: 'Missing tenantId' }), { status: 400, headers });
      const res = await callPaycor(`/tenants/${tenantId}/legalentities`);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: list employees for a legal entity ──
    if (action === 'employees') {
      const { legalEntityId, continuationToken } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      let path = `/legalentities/${legalEntityId}/employees?include=All`;
      if (continuationToken) path += `&continuationToken=${continuationToken}`;
      const res = await callPaycor(path);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: employee pay rates ──
    if (action === 'payRates') {
      const { employeeId } = payload;
      if (!employeeId) return new Response(JSON.stringify({ error: 'Missing employeeId' }), { status: 400, headers });
      const res = await callPaycor(`/employees/${employeeId}/payrates`);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: employee payroll hours ──
    if (action === 'payrollHours') {
      const { employeeId, legalEntityId } = payload;
      if (employeeId) {
        const res = await callPaycor(`/employees/${employeeId}/payrollhours`);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      if (legalEntityId) {
        const res = await callPaycor(`/legalentities/${legalEntityId}/payrollhours`);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      return new Response(JSON.stringify({ error: 'Missing employeeId or legalEntityId' }), { status: 400, headers });
    }

    // ── Write: stage employee hours/earnings into Paycor's paygrid ──────────────
    // POST /v1/legalentities/{legalEntityId}/payrollhours?replaceData={bool}&appendData={bool}
    // Body: { integrationVendor, processId, importEmployees: [{ employeeNumber, importEarnings: [...] }] }
    // Per Paycor support (2026-08-20): this only STAGES data into the paygrid for
    // human review in Paycor's own UI — it does NOT submit payroll. A human still
    // has to review and hit submit there. The caller supplies its own processId
    // (a GUID) per submission; replaceData/appendData let a later call correct or
    // extend the same processId before the payrun finalizes, rather than creating
    // a duplicate stage. Matching key is employeeNumber (int32) — already captured
    // as the tips pipeline's `payrollId` field, so no separate lookup is needed.
    // Deliberately one call per legalEntityId (one per store), matching how the
    // tips pipeline already computes per-store, per-day shares — this naturally
    // handles terminations and mid-period store transfers with no special-case
    // logic here, since an employee simply has no hours at a store they weren't
    // actually working at on a given day.
    if (action === 'stagePayrollHours') {
      const { legalEntityId, processId, importEmployees, replaceData, appendData, integrationVendor = 'PCG Portal' } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      if (!processId) return new Response(JSON.stringify({ error: 'Missing processId' }), { status: 400, headers });
      if (!Array.isArray(importEmployees) || importEmployees.length === 0) return new Response(JSON.stringify({ error: 'Missing importEmployees array' }), { status: 400, headers });
      let path = `/legalentities/${legalEntityId}/payrollhours`;
      const params = [];
      if (replaceData != null) params.push(`replaceData=${!!replaceData}`);
      if (appendData != null) params.push(`appendData=${!!appendData}`);
      if (params.length) path += '?' + params.join('&');
      const res = await callPaycor(path, 'POST', { integrationVendor, processId, importEmployees });
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: employee earnings ──
    if (action === 'earnings') {
      const { employeeId, legalEntityId } = payload;
      if (employeeId) {
        const res = await callPaycor(`/employees/${employeeId}/earnings`);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      if (legalEntityId) {
        const res = await callPaycor(`/legalentities/${legalEntityId}/earnings`);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      return new Response(JSON.stringify({ error: 'Missing employeeId or legalEntityId' }), { status: 400, headers });
    }

    // ── Proxy: employee pay stubs ──
    if (action === 'payStubs') {
      const { employeeId } = payload;
      if (!employeeId) return new Response(JSON.stringify({ error: 'Missing employeeId' }), { status: 400, headers });
      const res = await callPaycor(`/employees/${employeeId}/paystubs`);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: employee/location punches (time clock data) ──
    if (action === 'punches') {
      const { legalEntityId, employeeId, startDate, endDate } = payload;
      if (employeeId) {
        let path = `/employees/${employeeId}/punches`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      if (legalEntityId) {
        let path = `/legalentities/${legalEntityId}/punches`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      return new Response(JSON.stringify({ error: 'Missing employeeId or legalEntityId' }), { status: 400, headers });
    }

    // ── Proxy: employee/location schedules (legacy/Perform Time) ──
    if (action === 'schedules') {
      const { legalEntityId, employeeId, startDate, endDate } = payload;
      if (employeeId) {
        let path = `/employees/${employeeId}/schedules`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      if (legalEntityId) {
        let path = `/legalentities/${legalEntityId}/schedules`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      return new Response(JSON.stringify({ error: 'Missing employeeId or legalEntityId' }), { status: 400, headers });
    }

    // ── Proxy: Paycor Scheduling shifts (newer system) ──
    if (action === 'schedulingShifts') {
      const { legalEntityId, shiftId, startDate, endDate } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      if (shiftId) {
        const res = await callPaycor(`/legalentities/${legalEntityId}/schedulingShifts/${shiftId}`);
        return new Response(JSON.stringify(res.data), { status: res.status, headers });
      }
      let path = `/legalentities/${legalEntityId}/schedulingShifts`;
      const params = [];
      if (startDate) params.push(`startDate=${startDate}`);
      if (endDate) params.push(`endDate=${endDate}`);
      if (params.length) path += '?' + params.join('&');
      const res = await callPaycor(path);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Write: create scheduling shift(s) ──────────────────────────────────────
    // POST /v1/legalentities/{legalEntityId}/schedulingShifts
    // Body: { ignoreWarnings: bool, shifts: [{ employeeId, scheduleGroupId, schedulingJobId,
    //          startDateTime, endDateTime, title?, notes?, ... }] }
    // Response includes shiftId + warningsOrErrors per shift (e.g. overlap warnings) —
    // ignoreWarnings:true makes those non-blocking rather than rejecting the request.
    if (action === 'createSchedulingShifts') {
      const { legalEntityId, shifts, ignoreWarnings = true } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      if (!Array.isArray(shifts) || shifts.length === 0) return new Response(JSON.stringify({ error: 'Missing shifts array' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/schedulingShifts`, 'POST', { ignoreWarnings, shifts });
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Write: update an existing scheduling shift ──────────────────────────────
    // PUT /v1/legalentities/{legalEntityId}/schedulingShifts/{shiftId}
    if (action === 'updateSchedulingShift') {
      const { legalEntityId, shiftId, shift, ignoreWarnings = true } = payload;
      if (!legalEntityId || !shiftId) return new Response(JSON.stringify({ error: 'Missing legalEntityId or shiftId' }), { status: 400, headers });
      if (!shift) return new Response(JSON.stringify({ error: 'Missing shift' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/schedulingShifts/${shiftId}`, 'PUT', { ignoreWarnings, ...shift });
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Write: delete a scheduling shift ────────────────────────────────────────
    // DELETE /v1/legalentities/{legalEntityId}/schedulingShifts/{shiftId}
    if (action === 'deleteSchedulingShift') {
      const { legalEntityId, shiftId } = payload;
      if (!legalEntityId || !shiftId) return new Response(JSON.stringify({ error: 'Missing legalEntityId or shiftId' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/schedulingShifts/${shiftId}`, 'DELETE');
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: pay groups for a legal entity (needed for stagePayrollHours' required payGroupId) ──
    if (action === 'payGroups') {
      const { legalEntityId } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/paygroups`);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: employee punches (newer endpoint, may include open punches) ──
    if (action === 'employeePunches') {
      const { employeeId, startDate, endDate } = payload;
      if (!employeeId) return new Response(JSON.stringify({ error: 'Missing employeeId' }), { status: 400, headers });
      let path = `/employees/${employeeId}/employeePunches`;
      const params = [];
      if (startDate) params.push(`startDate=${startDate}`);
      if (endDate) params.push(`endDate=${endDate}`);
      if (params.length) path += '?' + params.join('&');
      const res = await callPaycor(path);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: scheduling jobs for a legal entity ──
    if (action === 'schedulingJobs') {
      const { legalEntityId } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/SchedulingJobs`);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: schedule groups for a legal entity ──
    if (action === 'scheduleGroups') {
      const { legalEntityId } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });
      const res = await callPaycor(`/legalentities/${legalEntityId}/schedulegroups`);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Proxy: generic API call (for exploration) ──
    if (action === 'raw') {
      const { path, method, body } = payload;
      if (!path) return new Response(JSON.stringify({ error: 'Missing path' }), { status: 400, headers });
      const res = await callPaycor(path, method || 'GET', body || null);
      return new Response(JSON.stringify(res.data), { status: res.status, headers });
    }

    // ── Bulk: get labor summary for a legal entity ──
    // Fetches all employees + their pay rates + current hours
    if (action === 'laborSummary') {
      const { legalEntityId } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });

      // Get all employees (paginate if needed)
      let allEmployees = [];
      let continuationToken = null;
      do {
        let path = `/legalentities/${legalEntityId}/employees?include=All`;
        if (continuationToken) path += `&continuationToken=${continuationToken}`;
        const empRes = await callPaycor(path);
        if (empRes.status !== 200) {
          return new Response(JSON.stringify({ error: 'Failed to fetch employees', detail: empRes.data }), { status: empRes.status, headers });
        }
        const records = empRes.data?.records || empRes.data || [];
        allEmployees = allEmployees.concat(records);
        continuationToken = empRes.data?.continuationToken || null;
      } while (continuationToken);

      // Filter to ACTIVE employees only (statusData.status === 'Active')
      const activeEmployees = allEmployees.filter(emp => {
        const status = emp.statusData?.status || emp.status || '';
        return status === 'Active';
      });

      // For each active employee, get pay rate (batch in groups of 10)
      const laborData = [];
      for (let i = 0; i < activeEmployees.length; i += 10) {
        const batch = activeEmployees.slice(i, i + 10);
        const results = await Promise.all(batch.map(async (emp) => {
          try {
            const rateRes = await callPaycor(`/employees/${emp.id}/payrates`);
            const rates = rateRes.data?.records || rateRes.data || [];
            const primaryRate = rates[0]; // Most recent/primary rate

            return {
              employeeId: emp.id,
              firstName: emp.firstName,
              lastName: emp.lastName,
              status: emp.statusData?.status || 'Active',
              department: emp.department,
              jobTitle: emp.positionData?.jobTitle || emp.jobTitle || '',
              payRate: primaryRate?.payRate || primaryRate?.rate || null,
              payType: primaryRate?.payType || primaryRate?.type || null,
              annualPay: primaryRate?.annualPayRate || null,
              flsa: emp.statusData?.flsa || null,
            };
          } catch (e) {
            return {
              employeeId: emp.id,
              firstName: emp.firstName,
              lastName: emp.lastName,
              status: 'Active',
              error: e.message,
            };
          }
        }));
        laborData.push(...results);
      }

      return new Response(JSON.stringify({
        legalEntityId,
        totalEmployees: allEmployees.length,
        activeEmployees: activeEmployees.length,
        fetchedRates: laborData.length,
        employees: laborData,
      }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers });

  } catch (err) {
    console.error('Paycor function error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.message?.startsWith('NO_TOKEN') ? 401 : 500,
      headers,
    });
  }
};
