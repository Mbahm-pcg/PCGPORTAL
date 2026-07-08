// PCG Pulse — Netlify Serverless Proxy
// Sits between the browser and pos-ra.dunkindonuts.com to avoid CORS

import https from 'node:https';

const APIS = {
  p227: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p227',
    xkey:   'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL',
    apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
  p228: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p228',
    xkey:   'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP',
    apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
};

// Reuse TLS connections across the parallel batch fan-out and across calls on
// a warm container — a fresh handshake per store would dominate latency.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 20 });

function callUpstream(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: cfg.host,
      port:     443,
      path:     `${cfg.path}/${endpoint}`,
      method:   'POST',
      agent:    keepAliveAgent,
      headers:  {
        'Content-Type':   'application/json',
        'x-api-key':      cfg.xkey,
        'Api-Key':        cfg.apikey,
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('upstream request timed out')));
    req.write(data);
    req.end();
  });
}

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });
  }

  let payload;
  try {
    payload = await request.json().catch(() => ({}));
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers });
  }

  // Batch mode: { endpoint, batch: [{ api, locRef }, ...], ...shared }
  // Fans out to the POS in parallel server-side so the browser makes one
  // round-trip for many stores. Returns { results: { [locRef]: { status, data } } }.
  if (Array.isArray(payload.batch)) {
    const { batch, endpoint: batchEndpoint, api: defaultApi, ...shared } = payload;
    if (!batchEndpoint) {
      return new Response(JSON.stringify({ error: 'Missing endpoint' }), { status: 400, headers });
    }
    if (batch.length === 0 || batch.length > 60) {
      return new Response(JSON.stringify({ error: 'batch must contain 1-60 entries' }), { status: 400, headers });
    }
    const entries = await Promise.all(batch.map(async ({ api: entryApi, locRef }) => {
      const entryCfg = APIS[entryApi || defaultApi];
      if (!entryCfg) return [locRef, { status: 400, data: { error: `Unknown api: ${entryApi || defaultApi}` } }];
      try {
        const r = await callUpstream(entryCfg, batchEndpoint, { ...shared, locRef });
        let data;
        try { data = JSON.parse(r.body); } catch { data = { error: 'Invalid upstream JSON', raw: String(r.body).slice(0, 200) }; }
        return [locRef, { status: r.status, data }];
      } catch (err) {
        return [locRef, { status: 502, data: { error: err.message } }];
      }
    }));
    return new Response(JSON.stringify({ results: Object.fromEntries(entries) }), { status: 200, headers });
  }

  // Expect: { api: 'p227'|'p228', endpoint: 'getOperationsDailyTotals', ...rest }
  const { api, endpoint, ...requestBody } = payload;
  const cfg = APIS[api];

  if (!cfg) {
    return new Response(JSON.stringify({ error: `Unknown api: ${api}` }), { status: 400, headers });
  }
  if (!endpoint) {
    return new Response(JSON.stringify({ error: 'Missing endpoint' }), { status: 400, headers });
  }

  try {
    const result = await callUpstream(cfg, endpoint, requestBody);
    return new Response(result.body, { status: result.status, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 502, headers });
  }
};
