// hexnode-sync-cron-background.mjs — scheduled (netlify.toml) device+GPS sync.
// The `-background` suffix gives a 15-min timeout: Hexnode's per-device detail
// API is slow and rate-limits high concurrency, so the full ~96-device pull
// (~35s at concurrency 8) won't fit the 26s sync-function budget. Caches to
// pcg_hexnode_devices_v1 so the portal's Devices view reads instantly.
import { fetchAllDevices, saveCachedDevices } from './hexnode-lib/devices.mjs';

export default async () => {
  try {
    const payload = await fetchAllDevices({ concurrency: 8 });
    await saveCachedDevices(payload);
    const withGps = payload.devices.filter(d => d.lat != null && d.lng != null).length;
    console.log(`hexnode-sync: cached ${payload.devices.length} devices (${withGps} with GPS)`);
    return new Response(`ok: ${payload.devices.length} devices`, { status: 200 });
  } catch (e) {
    console.error('hexnode-sync failed:', e.message);
    return new Response(`error: ${e.message}`, { status: 500 });
  }
};
