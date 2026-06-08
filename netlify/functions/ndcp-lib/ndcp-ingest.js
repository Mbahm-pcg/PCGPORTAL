// ndcp-ingest.js — shared Gmail-message → ndcp_orders persistence.
// Used by ndcp-backfill.js (on-demand, batched) and ndcp-sync-cron.js (scheduled,
// incremental). Keeps the table schema + upsert in one place so the two callers
// can't drift apart. The HTML parsing lives in ndcp-parse.js.
const { parseNdcpOrder } = require('./ndcp-parse');

function decodeBase64(str) {
  if (!str) return '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// Prefer the HTML part (NDCP orders are HTML); fall back to text/plain or nested parts.
function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/html' && payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.body?.data && !payload.parts) return decodeBase64(payload.body.data);
  if (payload.parts) {
    const html = payload.parts.find((p) => p.mimeType === 'text/html');
    if (html?.body?.data) return decodeBase64(html.body.data);
    const text = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (text?.body?.data) return decodeBase64(text.body.data);
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

function toISO(dateHeader) {
  const t = Date.parse(dateHeader);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

async function ensureTable(db) {
  await db`
    CREATE TABLE IF NOT EXISTS ndcp_orders (
      id SERIAL PRIMARY KEY,
      message_id TEXT UNIQUE NOT NULL,
      order_number TEXT,
      email_type TEXT,
      subject TEXT,
      email_from TEXT,
      email_date TIMESTAMPTZ,
      account TEXT,
      store_name TEXT,
      ship_to JSONB,
      bill_to JSONB,
      order_type TEXT,
      ship_via TEXT,
      warehouse TEXT,
      terms TEXT,
      created_by TEXT,
      date_created TEXT,
      date_ordered TEXT,
      date_shipped TEXT,
      item_subtotal NUMERIC,
      tax NUMERIC,
      freight NUMERIC,
      discount NUMERIC,
      total_order NUMERIC,
      balance_due NUMERIC,
      category_subtotals JSONB,
      line_items JSONB,
      item_count INT,
      raw_html TEXT,
      ingested_at TIMESTAMPTZ DEFAULT now()
    )`;
  await db`CREATE INDEX IF NOT EXISTS ndcp_orders_order_number_idx ON ndcp_orders(order_number)`;
  await db`CREATE INDEX IF NOT EXISTS ndcp_orders_email_date_idx ON ndcp_orders(email_date)`;
}

// Parse one Gmail message payload and upsert it. Returns { stored, orderNumber, order }.
// Rows without an order number (non-order NDCP mail) are skipped, not stored.
async function upsertMessage(db, msg) {
  const headers = msg.payload?.headers || [];
  const meta = {
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    date: toISO(getHeader(headers, 'Date')),
    messageId: msg.id,
  };
  const html = extractBody(msg.payload);
  const o = parseNdcpOrder(html, meta);
  if (!o.orderNumber) return { stored: false, orderNumber: null, order: o };

  await db`
    INSERT INTO ndcp_orders (
      message_id, order_number, email_type, subject, email_from, email_date,
      account, store_name, ship_to, bill_to, order_type, ship_via, warehouse, terms, created_by,
      date_created, date_ordered, date_shipped,
      item_subtotal, tax, freight, discount, total_order, balance_due,
      category_subtotals, line_items, item_count, raw_html
    ) VALUES (
      ${o.messageId}, ${o.orderNumber}, ${o.emailType}, ${o.subject}, ${o.emailFrom}, ${o.emailDate},
      ${o.account}, ${o.storeName}, ${JSON.stringify(o.shipTo)}::jsonb, ${JSON.stringify(o.billTo)}::jsonb,
      ${o.orderType}, ${o.shipVia}, ${o.warehouse}, ${o.terms}, ${o.createdBy},
      ${o.dates.created}, ${o.dates.ordered}, ${o.dates.shipped},
      ${o.totals.itemSubtotal}, ${o.totals.tax}, ${o.totals.freight}, ${o.totals.beverageDiscount},
      ${o.totals.totalOrder}, ${o.totals.balanceDue},
      ${JSON.stringify(o.categorySubtotals)}::jsonb, ${JSON.stringify(o.lineItems)}::jsonb,
      ${o.itemCount}, ${html}
    )
    ON CONFLICT (message_id) DO UPDATE SET
      order_number = EXCLUDED.order_number, email_type = EXCLUDED.email_type, subject = EXCLUDED.subject,
      email_date = EXCLUDED.email_date, account = EXCLUDED.account, store_name = EXCLUDED.store_name,
      ship_to = EXCLUDED.ship_to, bill_to = EXCLUDED.bill_to, order_type = EXCLUDED.order_type,
      ship_via = EXCLUDED.ship_via, warehouse = EXCLUDED.warehouse, terms = EXCLUDED.terms,
      created_by = EXCLUDED.created_by, date_created = EXCLUDED.date_created, date_ordered = EXCLUDED.date_ordered,
      date_shipped = EXCLUDED.date_shipped, item_subtotal = EXCLUDED.item_subtotal, tax = EXCLUDED.tax,
      freight = EXCLUDED.freight, discount = EXCLUDED.discount, total_order = EXCLUDED.total_order,
      balance_due = EXCLUDED.balance_due, category_subtotals = EXCLUDED.category_subtotals,
      line_items = EXCLUDED.line_items, item_count = EXCLUDED.item_count, raw_html = EXCLUDED.raw_html`;
  return { stored: true, orderNumber: o.orderNumber, order: o };
}

module.exports = { extractBody, getHeader, toISO, ensureTable, upsertMessage };
