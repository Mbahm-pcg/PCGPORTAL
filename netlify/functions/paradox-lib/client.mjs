// paradox-lib/client.mjs — the Paradox (Ally) public API client shared by the hire alerts
// and interview reminders (v22.45). Read-only GETs. Credentials: Netlify env Paradox_ID
// (Account ID) + Paradox_API (API Secret). Docs: https://readme.paradox.ai/
export const PARADOX_BASE = 'https://api.paradox.ai/api/v1/public';

// The token lasts 24h; reuse it while the function stays warm.
let _token = null, _tokenExp = 0;
async function token() {
  if (_token && Date.now() < _tokenExp - 300000) return _token;
  const id = (process.env.Paradox_ID || '').trim(), secret = (process.env.Paradox_API || '').trim();
  if (!id || !secret) throw new Error('Paradox_ID / Paradox_API not set');
  const r = await fetch(`${PARADOX_BASE}/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }) });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error(`Paradox auth failed (HTTP ${r.status})`);
  _token = j.access_token; _tokenExp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  return _token;
}

// GET a path (with query) → parsed JSON. Throws on any non-2xx (message carries the status).
export async function px(path) {
  const r = await fetch(`${PARADOX_BASE}${path}`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (r.status === 401) _token = null;
  if (!r.ok) { const e = new Error(`Paradox ${path.split('?')[0]} HTTP ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}

// Every page of GET /candidates for a query (limit 50 per page, capped at 1000 rows).
export async function pxCandidates(query) {
  const out = [];
  for (let offset = 0; offset < 1000; offset += 50) {
    const j = await px(`/candidates?limit=50&offset=${offset}&${query}`);
    const rows = Array.isArray(j?.candidates) ? j.candidates : [];
    out.push(...rows);
    if (rows.length < 50) break;
  }
  return out;
}

export async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}
