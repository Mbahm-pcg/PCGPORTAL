// widget.mjs — compact, read-only Pulse feed for phone home-screen widgets
// (iOS Scriptable / Android KWGT). Returns today's network net sales + labor % from
// the cached pcg_labor_v1 blob (no live Pulse calls, so widgets refresh instantly).
// Auth: a shared ?token= secret (WIDGET_SECRET env). Keep it read-only + low-sensitivity.
import { getStore } from '@netlify/blobs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
  // Let the widget cache briefly; the underlying blob only refreshes a few times/day.
  'Cache-Control': 'public, max-age=300',
};
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: cors });

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const url = new URL(request.url);
  const token = url.searchParams.get('token') || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const secret = process.env.WIDGET_SECRET;
  if (!secret) return json(503, { error: 'widget not configured' });
  if (token !== secret) return json(401, { error: 'unauthorized' });

  try {
    const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const raw = await store.get('pcg_labor_v1', { type: 'json' });
    const labor = raw?.data || raw;
    const stores = labor?.stores || {};

    // Optional district scope: /widget?token=…&district=7 → just that district's stores.
    const district = url.searchParams.get('district');
    let netSales = 0, laborDollars = 0, openStores = 0, total = 0;
    for (const pc in stores) {
      const s = stores[pc];
      if (district && String(s.district) !== String(district)) continue;
      total++;
      const t = s.today || {};
      netSales += t.sales || 0;
      laborDollars += t.laborDollars || 0;
      if ((t.sales || 0) > 0) openStores++;
    }
    const laborPct = netSales > 0 ? Math.round((laborDollars / netSales) * 1000) / 10 : null;

    return json(200, {
      scope: district ? `District ${district}` : 'Network',
      busDt: labor?.busDt || null,
      asOf: labor?.lastUpdated || null,
      netSales: Math.round(netSales),
      laborPct,
      storesReporting: openStores,
      storeCount: total,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
