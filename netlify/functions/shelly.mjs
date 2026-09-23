// netlify/functions/shelly.mjs — Shelly Cloud device-status proxy.
// SHELLY_SERVER/SHELLY_KEY stay server-side only, never reach the browser (same reason
// pulse.js/paycor.js proxy their APIs instead of calling them from the client).
//
// Auto-discovers every device on the account via /device/all_status (verified 2026-09-23
// against the real account) instead of querying one hardcoded device id — adding a new
// Shelly sensor (up to the plan's cap) makes it show up here with NO code change; this
// file never needs to know a device id in advance.
//
// A single device can report MULTIPLE temperature probes (confirmed real: the current
// test device has both "temperature:200" and "temperature:201" — verified 2026-09-23,
// not assumed) — every vcomps entry starting with "temperature:" is read, not just the
// first, so a second probe on the same unit isn't silently dropped.
//
// fetchAllShellyDevices() is exported (same pattern as labor-cron.mjs exporting STORES/
// callPaycor) so shelly-temp-lib/run.mjs reuses this exact, already-verified fetch+parse
// logic instead of duplicating it — one source of truth for what a Shelly reading looks
// like, used by both the display widget and the alerting automation.
export async function fetchAllShellyDevices() {
  const server = process.env.SHELLY_SERVER;
  const key = process.env.SHELLY_KEY;
  if (!server || !key) throw new Error('Shelly not configured (SHELLY_SERVER/SHELLY_KEY missing)');

  const body = new URLSearchParams({ auth_key: key });
  const res = await fetch(`${server}/device/all_status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.isok) throw new Error(`Shelly API error (status ${res.status})`);

  const devicesRaw = json.data?.devices_status || {};
  return Object.entries(devicesRaw).map(([deviceId, status]) => {
    const tempKeys = (status.vcomps || []).filter(k => typeof k === 'string' && k.startsWith('temperature:'));
    const sensors = tempKeys
      .map(k => status[k])
      .filter(t => t && typeof t.tF === 'number')
      .map(t => ({ sensorId: String(t.id), tempF: t.tF, tempC: t.tC }));
    return {
      deviceId,
      // all_status doesn't carry the same top-level online flag /device/status did —
      // cloud.connected is the closest real signal this endpoint gives per device.
      // Untested against an actually-offline device (only had one online one to verify
      // against) — treat as best-effort, not a guarantee.
      online: status.cloud?.connected !== false,
      lastUpdated: status.ts ? new Date(status.ts * 1000).toISOString() : null,
      sensors,
    };
  });
}

export default async (request) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  try {
    const devices = await fetchAllShellyDevices();
    return new Response(JSON.stringify({ devices }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};
