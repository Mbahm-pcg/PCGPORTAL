// hexnode-lib/devices.mjs — Hexnode UEM client + device/GPS normalizer.
// Auth is the RAW API key in the Authorization header (NOT the "Mxadmauth"
// scheme the old dispatch spec assumed — that returns 401). Key lives in the
// Netlify env var `Hexnode_key`; domain is the rgi tenant.
import { getStore } from '@netlify/blobs';

const DOMAIN = process.env.HEXNODE_DOMAIN || 'rgi.hexnodemdm.com';
const BLOB_KEY = 'pcg_hexnode_devices_v1';

const authHeaders = () => ({ Authorization: process.env.Hexnode_key || '' });

function blobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

async function apiGet(path) {
  const res = await fetch(`https://${DOMAIN}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`hexnode ${path} → ${res.status}`);
  return res.json();
}

// Parse the store PC (6-digit Pulse Cloud #) from a device name like
// "300496 - Chester Ave". Returns null for un-renamed/personal devices.
function parsePc(name) {
  const m = (name || '').match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

/** Page through the full device list (Hexnode paginates via `next`). */
async function fetchDeviceList() {
  const all = [];
  let path = '/api/v1/devices/';
  // Guard against runaway pagination (96 devices today; cap well above).
  for (let page = 0; path && page < 30; page++) {
    const j = await apiGet(path);
    if (Array.isArray(j.results)) all.push(...j.results);
    if (!j.next) break;
    try { path = new URL(j.next).pathname + new URL(j.next).search; } catch { break; }
  }
  return all;
}

/** Run async fn over items with bounded concurrency. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

/**
 * Fetch every device + its GPS (one detail call per device for location, run
 * with bounded concurrency) and normalize. Returns { syncedAt, devices }.
 */
export async function fetchAllDevices({ concurrency = 8 } = {}) {
  const list = await fetchDeviceList();
  const devices = await pool(list, concurrency, async (d) => {
    let det = null;
    try { det = await apiGet(`/api/v1/devices/${d.id}/`); } catch { /* keep metadata, no GPS */ }
    const lat = det?.latitude ? Number(det.latitude) : null;
    const lng = det?.longitude ? Number(det.longitude) : null;
    return {
      id: d.id,
      name: d.device_name || '',
      pc: parsePc(d.device_name),
      model: d.model_name || '',
      os: d.os_name || '',
      osVersion: d.os_version || '',
      deviceType: d.device_type || '',
      compliant: d.compliant !== false,
      userName: d.user?.name || '',
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      locName: (det?.last_location || '').trim() || null,
      locTime: det?.last_location_time || null,
      trackingDisabled: !!det?.location_tracking_disabled,
      trackingInterval: det?.location_tracking_interval ?? null,
      lastReported: d.last_reported || det?.lastreported || null,
    };
  });
  return { syncedAt: new Date().toISOString(), devices };
}

export async function loadCachedDevices() {
  try {
    const raw = await blobStore().get(BLOB_KEY, { type: 'json' });
    if (!raw) return null;
    return raw.data !== undefined ? raw.data : raw; // unwrap {savedAt,data}
  } catch { return null; }
}

export async function saveCachedDevices(payload) {
  await blobStore().setJSON(BLOB_KEY, { savedAt: new Date().toISOString(), data: payload });
}
