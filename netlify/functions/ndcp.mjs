// ndcp.mjs — read API for the NDCP Orders portal tab.
// Reads the ndcp_orders table (populated by ndcp-backfill / ndcp-sync-cron).
// Consistent with the portal's other read endpoints (pulse, storage), this is
// unauthenticated; tab visibility is gated client-side by role. No writes here.
//
// Actions:
//   list    → latest version of each distinct order (+ version count + original total)
//   detail  → every version of one order_number (full line items), oldest → newest
import { sql } from './_shared/db.mjs';
import { enrich } from './ndcp-lib/store-map.js';
import { summarize } from './ndcp-lib/summary.js';

// Restrict CORS to the portal's own origins (not '*'). Requests are same-origin
// in normal use; this just blocks cross-origin browser reads of order data.
const ALLOWED_ORIGINS = ['https://uop.peoplecapitalgroup.com', 'https://pcg-ops.netlify.app'];
function corsFor(request) {
  const origin = request.headers.get('origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
}

export default async (request) => {
  const cors = corsFor(request);
  const reply = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: cors });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  let body = {};
  try { body = await request.json(); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action || 'list';
  const db = sql();

  try {
    if (action === 'list') {
      const from = body.from ? new Date(body.from) : null; // ISO 'YYYY-MM-DD'
      const to   = body.to   ? new Date(body.to)   : null;
      const rows = await db`
        WITH latest AS (
          SELECT DISTINCT ON (order_number) *
          FROM ndcp_orders
          WHERE order_number IS NOT NULL
            AND (${from ? from.toISOString() : null}::timestamptz IS NULL OR email_date >= ${from ? from.toISOString() : null}::timestamptz)
            AND (${to ? to.toISOString() : null}::timestamptz IS NULL OR email_date <  (${to ? to.toISOString() : null}::timestamptz + interval '1 day'))
          ORDER BY order_number, email_date DESC NULLS LAST
        ),
        counts AS (
          SELECT order_number,
                 count(*)::int AS versions,
                 count(*) FILTER (WHERE email_type = 'revision')::int AS revisions,
                 (array_agg(total_order ORDER BY email_date ASC NULLS LAST))[1] AS orig_total
          FROM ndcp_orders WHERE order_number IS NOT NULL GROUP BY order_number
        )
        SELECT l.order_number, l.store_name, l.account, l.email_type, l.email_date,
               l.date_ordered, l.date_shipped, l.warehouse, l.terms,
               l.total_order, l.item_subtotal, l.tax, l.item_count, l.subject,
               l.category_subtotals,
               c.versions, c.revisions, c.orig_total
        FROM latest l JOIN counts c USING (order_number)
        ORDER BY l.email_date DESC NULLS LAST`;
      return reply(200, { orders: rows.map(enrich) });
    }

    if (action === 'summary') {
      const from = body.from ? new Date(body.from) : null;
      const to   = body.to   ? new Date(body.to)   : null;
      const rows = await db`
        SELECT DISTINCT ON (order_number) account, total_order, date_ordered, email_date
        FROM ndcp_orders
        WHERE order_number IS NOT NULL
          AND (${from ? from.toISOString() : null}::timestamptz IS NULL OR email_date >= ${from ? from.toISOString() : null}::timestamptz)
          AND (${to ? to.toISOString() : null}::timestamptz IS NULL OR email_date < (${to ? to.toISOString() : null}::timestamptz + interval '1 day'))
        ORDER BY order_number, email_date DESC NULLS LAST`;
      return reply(200, summarize(rows));
    }

    if (action === 'detail') {
      const orderNumber = String(body.order_number || '');
      if (!orderNumber) return reply(400, { error: 'order_number required' });
      const versions = await db`
        SELECT message_id, email_type, subject, email_from, email_date,
               date_created, date_ordered, date_shipped, created_by, warehouse, terms,
               account, store_name, ship_to,
               item_subtotal, tax, freight, discount, total_order, balance_due,
               category_subtotals, line_items, item_count
        FROM ndcp_orders
        WHERE order_number = ${orderNumber}
        ORDER BY email_date ASC NULLS LAST`;
      if (!versions.length) return reply(404, { error: 'not found' });
      return reply(200, { order_number: orderNumber, versions });
    }

    return reply(400, { error: 'unknown action' });
  } catch (e) {
    return reply(500, { error: 'server error' });
  }
};
