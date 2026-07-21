// PCG Portal — Paycor API Proxy
// Handles OAuth token management and proxies requests to the Paycor Public API.
// Credentials live in Netlify env vars (never exposed to the browser).

import https from 'node:https';

const PAYCOR_API_HOST = 'apis.paycor.com';
const PAYCOR_AUTH_HOST = 'apis.paycor.com';
const TOKEN_ENDPOINT = '/sts/v1/common/token';

// In-memory token cache (persists across warm Lambda invocations).
// On cold start, seed the refresh token from the env var so we can
// immediately exchange it for a fresh access token.
let tokenCache = {
  accessToken: null,
  refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null,
  expiresAt: 0,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    if (data) req.write(data);
    req.end();
  });
}

// ── OAuth Token Management ───────────────────────────────────────────────────

async function getAccessToken() {
  const clientId = process.env.PAYCOR_CLIENT_ID;
  const clientSecret = process.env.PAYCOR_CLIENT_SECRET;
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;

  if (!clientId || !clientSecret || !subscriptionKey) {
    throw new Error('Missing Paycor credentials in environment variables');
  }

  // Return cached token if still valid (with 60s buffer)
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.accessToken;
  }

  // If we have a refresh token, try refreshing.
  // Paycor requires form-urlencoded (NOT JSON) for the token endpoint.
  if (tokenCache.refreshToken) {
    try {
      const formBody = [
        `grant_type=refresh_token`,
        `refresh_token=${encodeURIComponent(tokenCache.refreshToken)}`,
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
        req.write(formBody);
        req.end();
      });

      if (res.status === 200 && res.data.access_token) {
        tokenCache = {
          accessToken: res.data.access_token,
          refreshToken: res.data.refresh_token || tokenCache.refreshToken,
          expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000,
        };
        // Persist new refresh token to env var via Netlify API (best-effort)
        console.log('[paycor] Token refreshed successfully, expires in', res.data.expires_in, 's');
        return tokenCache.accessToken;
      } else {
        console.warn('[paycor] Token refresh returned', res.status, JSON.stringify(res.data).slice(0, 300));
      }
    } catch (e) {
      console.warn('[paycor] Token refresh failed:', e.message);
    }
  }

  // No valid token and no refresh token — need initial auth.
  // For the initial OAuth flow, the client needs to go through the activation
  // process first. We'll return an error that explains this.
  throw new Error('NO_TOKEN: No valid access token. The application needs to be activated via the Paycor OAuth flow first. Use the /activate endpoint to start.');
}

// ── Paycor API Call ──────────────────────────────────────────────────────────

async function callPaycor(path, method = 'GET') {
  const token = await getAccessToken();
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;

  const res = await httpsRequest(PAYCOR_API_HOST, `/v1${path}`, method, {
    Authorization: `Bearer ${token}`,
    'Ocp-Apim-Subscription-Key': subscriptionKey,
  });

  // If we get 401, token might be stale — clear cache and retry once
  if (res.status === 401) {
    tokenCache.accessToken = null;
    tokenCache.expiresAt = 0;
    const newToken = await getAccessToken();
    return await httpsRequest(PAYCOR_API_HOST, `/v1${path}`, method, {
      Authorization: `Bearer ${newToken}`,
      'Ocp-Apim-Subscription-Key': subscriptionKey,
    });
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
      tokenCache = {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + (expiresIn || 3600) * 1000,
      };
      return new Response(JSON.stringify({ ok: true, message: 'Tokens stored successfully' }), { status: 200, headers });
    }

    // ── Check token status ──
    if (action === 'status') {
      return new Response(JSON.stringify({
        hasToken: !!tokenCache.accessToken,
        hasRefreshToken: !!tokenCache.refreshToken,
        expiresAt: tokenCache.expiresAt,
        isValid: tokenCache.accessToken && Date.now() < tokenCache.expiresAt,
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
      const { path, method } = payload;
      if (!path) return new Response(JSON.stringify({ error: 'Missing path' }), { status: 400, headers });
      const res = await callPaycor(path, method || 'GET');
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
