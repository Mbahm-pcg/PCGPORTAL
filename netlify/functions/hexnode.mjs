// hexnode.mjs — server-side proxy for Hexnode MDM device/GPS data.
// The browser calls THIS (never Hexnode directly) so the API key stays secret
// and CORS is bypassed. Mirrors the pulse.js / paycor.js proxy pattern.
//   action: 'list'    → return cached devices (instant; refreshed by the cron)
//   action: 'refresh' → fire the background sync (returns immediately; poll list)
// The heavy Hexnode pull (~35s, rate-limited) lives in the 15-min background
// function — never inline here, which has only a 26s budget.
import https from 'node:https';
import { loadCachedDevices } from './hexnode-lib/devices.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Fire-and-forget POST to the background sync worker.
function triggerSync() {
  return new Promise((resolve) => {
    const base = process.env.URL;
    if (!base) return resolve(false);
    try {
      const u = new URL(`${base}/.netlify/functions/hexnode-sync-cron-background`);
      const req = https.request(
        { hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } },
        (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); }
      );
      req.on('error', () => resolve(false));
      req.setTimeout(4000, () => { req.destroy(); resolve(false); });
      req.write('{}');
      req.end();
    } catch { resolve(false); }
  });
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  let body = {};
  try { body = await request.json(); } catch { /* default to list */ }
  const action = body.action || 'list';

  try {
    if (action === 'refresh') {
      await triggerSync();
      return new Response(JSON.stringify({ ok: true, triggered: true }), { status: 200, headers: cors });
    }

    const cached = await loadCachedDevices();
    // First run (cache empty): kick the background sync and tell the UI to wait.
    if (!cached || !Array.isArray(cached.devices) || !cached.devices.length) {
      await triggerSync();
      return new Response(JSON.stringify({ ok: true, warming: true, devices: [], syncedAt: null }), { status: 200, headers: cors });
    }
    return new Response(JSON.stringify({ ok: true, ...cached, source: 'cache' }), { status: 200, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 502, headers: cors });
  }
};
