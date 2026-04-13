// PCG Portal — Paycor API Proxy
// Handles OAuth token management and proxies requests to the Paycor Public API.
// Credentials live in Netlify env vars (never exposed to the browser).

const https = require('https');

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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action } = payload;

  try {
    // ── Store initial tokens from the OAuth activation flow ──
    if (action === 'storeTokens') {
      const { accessToken, refreshToken, expiresIn } = payload;
      if (!accessToken || !refreshToken) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing accessToken or refreshToken' }) };
      }
      tokenCache = {
        accessToken,
        refreshToken,
        expiresAt: Date.now() + (expiresIn || 3600) * 1000,
      };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, message: 'Tokens stored successfully' }) };
    }

    // ── Check token status ──
    if (action === 'status') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          hasToken: !!tokenCache.accessToken,
          hasRefreshToken: !!tokenCache.refreshToken,
          expiresAt: tokenCache.expiresAt,
          isValid: tokenCache.accessToken && Date.now() < tokenCache.expiresAt,
          hasCredentials: !!(process.env.PAYCOR_CLIENT_ID && process.env.PAYCOR_CLIENT_SECRET && process.env.PAYCOR_SUBSCRIPTION_KEY),
        }),
      };
    }

    // ── Get the activation URL for OAuth flow ──
    if (action === 'activationUrl') {
      const clientId = process.env.PAYCOR_CLIENT_ID;
      const url = `https://hcm.paycor.com/appactivation/clientactivation?clientId=${clientId}`;
      return { statusCode: 200, headers, body: JSON.stringify({ url }) };
    }

    // ── Proxy: list legal entities for a tenant ──
    if (action === 'legalEntities') {
      const { tenantId } = payload;
      if (!tenantId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing tenantId' }) };
      const res = await callPaycor(`/tenants/${tenantId}/legalentities`);
      return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
    }

    // ── Proxy: list employees for a legal entity ──
    if (action === 'employees') {
      const { legalEntityId, continuationToken } = payload;
      if (!legalEntityId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing legalEntityId' }) };
      let path = `/legalentities/${legalEntityId}/employees?include=All`;
      if (continuationToken) path += `&continuationToken=${continuationToken}`;
      const res = await callPaycor(path);
      return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
    }

    // ── Proxy: employee pay rates ──
    if (action === 'payRates') {
      const { employeeId } = payload;
      if (!employeeId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing employeeId' }) };
      const res = await callPaycor(`/employees/${employeeId}/payrates`);
      return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
    }

    // ── Proxy: employee payroll hours ──
    if (action === 'payrollHours') {
      const { employeeId, legalEntityId } = payload;
      if (employeeId) {
        const res = await callPaycor(`/employees/${employeeId}/payrollhours`);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      if (legalEntityId) {
        const res = await callPaycor(`/legalentities/${legalEntityId}/payrollhours`);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing employeeId or legalEntityId' }) };
    }

    // ── Proxy: employee earnings ──
    if (action === 'earnings') {
      const { employeeId, legalEntityId } = payload;
      if (employeeId) {
        const res = await callPaycor(`/employees/${employeeId}/earnings`);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      if (legalEntityId) {
        const res = await callPaycor(`/legalentities/${legalEntityId}/earnings`);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing employeeId or legalEntityId' }) };
    }

    // ── Proxy: employee pay stubs ──
    if (action === 'payStubs') {
      const { employeeId } = payload;
      if (!employeeId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing employeeId' }) };
      const res = await callPaycor(`/employees/${employeeId}/paystubs`);
      return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
    }

    // ── Proxy: employee/location punches (time clock data) ──
    if (action === 'punches') {
      const { legalEntityId, employeeId, startDate, endDate } = payload;
      if (employeeId) {
        let path = `/employees/${employeeId}/timecard`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      if (legalEntityId) {
        let path = `/legalentities/${legalEntityId}/timecard`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing employeeId or legalEntityId' }) };
    }

    // ── Proxy: employee/location schedules ──
    if (action === 'schedules') {
      const { legalEntityId, employeeId, startDate, endDate } = payload;
      if (employeeId) {
        let path = `/employees/${employeeId}/schedules`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      if (legalEntityId) {
        let path = `/legalentities/${legalEntityId}/schedules`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing employeeId or legalEntityId' }) };
    }

    // ── Proxy: generic API call (for exploration) ──
    if (action === 'raw') {
      const { path, method } = payload;
      if (!path) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing path' }) };
      const res = await callPaycor(path, method || 'GET');
      return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
    }

    // ── Bulk: get labor summary for a legal entity ──
    // Fetches all employees + their pay rates + current hours
    if (action === 'laborSummary') {
      const { legalEntityId } = payload;
      if (!legalEntityId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing legalEntityId' }) };

      // Get all employees (paginate if needed)
      let allEmployees = [];
      let continuationToken = null;
      do {
        let path = `/legalentities/${legalEntityId}/employees?include=All`;
        if (continuationToken) path += `&continuationToken=${continuationToken}`;
        const empRes = await callPaycor(path);
        if (empRes.status !== 200) {
          return { statusCode: empRes.status, headers, body: JSON.stringify({ error: 'Failed to fetch employees', detail: empRes.data }) };
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

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          legalEntityId,
          totalEmployees: allEmployees.length,
          activeEmployees: activeEmployees.length,
          fetchedRates: laborData.length,
          employees: laborData,
        }),
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('Paycor function error:', err);
    return {
      statusCode: err.message?.startsWith('NO_TOKEN') ? 401 : 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
