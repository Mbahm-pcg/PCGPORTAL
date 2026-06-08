// NDCP order-email parser.
// National DCP's portal (natdcp.com) emails each supply order as structured HTML
// right in the body — no PDF. This module turns that HTML into a clean order object:
// header, store/account, totals, per-category subtotals, and every line item.
//
// Pure functions only (no I/O) so it can be unit-tested against real samples and
// reused by both the backfill and the live sync.

// ── Quoted-printable decode ────────────────────────────────────────────────
// Gmail returns the raw part body, which for these emails is quoted-printable
// (`=3D` for '=', soft line breaks as a trailing '='). Decode defensively: on
// already-decoded HTML this is a near no-op (a stray '=' is rarely followed by
// two hex digits in real markup).
function qpDecode(s) {
  return String(s || '')
    .replace(/=\r?\n/g, '')                                            // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Strip tags + collapse whitespace + decode the handful of entities NDCP uses.
function cellText(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// "6,994.23" / " 458.10 " → number; blank/garbage → null.
function num(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[,$]/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

// All <tr>…</tr> inner-HTML blocks in a chunk of markup.
function rows(html) {
  return (String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []);
}

// Cell texts for a given tag (td|th) within one row.
function cells(rowHtml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(rowHtml)) !== null) out.push(cellText(m[1]));
  return out;
}

// Classify the email by its subject line. NDCP sends a fresh "New Order" plus
// later revisions; grouping by order number + ordering by date gives version history.
function classifyType(subject) {
  const s = String(subject || '').toLowerCase();
  if (/cancel/.test(s)) return 'cancel';
  if (/change|revis|updat|modif|correct/.test(s)) return 'revision';
  if (/new order|order detail|order confirm/.test(s)) return 'new';
  return 'unknown';
}

// ── Main parse ─────────────────────────────────────────────────────────────
// meta: { subject, from, date, messageId } — header fields from Gmail.
function parseNdcpOrder(rawBody, meta = {}) {
  const html = qpDecode(rawBody);

  // Split at the line-item table so the key/value scan below can't pick up
  // item rows (which also use rightAlign value cells).
  const splitAt = html.search(/Part 2: Item Details|Qty\s*Ordered/i);
  const head = splitAt >= 0 ? html.slice(0, splitAt) : html;
  const tail = splitAt >= 0 ? html.slice(splitAt) : '';

  // Order number + scheduled ship date from the <h4> header.
  const hdr = head.match(/Order\s*#:\s*([0-9]+)\s*scheduled ship\s*([0-9/]+)/i);
  const orderNumber = hdr ? hdr[1] : null;
  const headerShipDate = hdr ? hdr[2].trim() : null;

  // BILL TO / SHIP TO: the 3-column table (left value | spacer | right value).
  const btBlock = (head.match(/BILL TO[\s\S]*?<\/table>/i) || [''])[0];
  const billLeft = [], shipRight = [];
  for (const r of rows(btBlock)) {
    const c = cells(r, 'td');
    if (c.length >= 1 && c[0]) billLeft.push(c[0]);
    if (c.length >= 3 && c[2]) shipRight.push(c[2]);
  }
  const party = (arr) => ({
    account: arr[0] || null,
    name: arr[1] || null,
    lines: arr.slice(2),
  });
  const billTo = party(billLeft);
  const shipTo = party(shipRight);

  // Key/value scan over the header region: <td>KEY:</td><td …rightAlign…>VALUE</td>.
  // Covers Shipping Info, Order Summary, Dates, Misc, and the category subtotals.
  const kv = {};
  const categorySubtotals = [];
  // Key/value cells are leaf cells (plain text, no nested tags). Constrain both
  // captures to [^<]* so a match can't span nested tables and absorb the cell
  // structure into the "key" — NDCP lays the summary out in nested tables.
  const pairRe = /<td\b[^>]*>([^<]*?)<\/td>\s*<td\b[^>]*rightAlign[^>]*>([^<]*?)<\/td>/gi;
  let pm;
  while ((pm = pairRe.exec(head)) !== null) {
    const key = cellText(pm[1]);
    const val = cellText(pm[2]);
    const cat = key.match(/^(\d+)\s*-\s*(.+)$/); // e.g. "13 - Food Cost-Retail"
    if (cat) {
      categorySubtotals.push({ code: cat[1], label: cat[2].trim(), amount: num(val) });
    } else if (key) {
      kv[key.replace(/:$/, '').trim().toLowerCase()] = val;
    }
  }
  const g = (k) => kv[k] || null;

  const totals = {
    itemSubtotal: num(g('item subtotal')),
    setupFee: num(g('setup fee')),
    freight: num(g('freight')),
    tax: num(g('tax')),
    bottleDeposits: num(g('bottle deposits/handling fees')),
    beverageDiscount: num(g('ndcp beverage discount')),
    totalOrder: num(g('total order')),
    balanceDue: num(g('balance due')),
  };

  // Line items: walk the tail rows, tracking the current category header
  // (<th colspan="9">Coffee</th>); rows with exactly 9 <td> cells are items.
  const lineItems = [];
  let category = null;
  for (const r of rows(tail)) {
    const catHdr = r.match(/<th\b[^>]*colspan=["']?9["']?[^>]*>([\s\S]*?)<\/th>/i);
    if (catHdr) { category = cellText(catHdr[1]); continue; }
    const c = cells(r, 'td');
    if (c.length === 9) {
      lineItems.push({
        category,
        qtyOrdered: num(c[0]),
        qtyAvailable: num(c[1]),
        itemNumber: c[2] || null,
        desc: c[3] || null,
        uom: c[4] || null,
        div: c[5] || null,
        taxable: c[6] || null,
        price: num(c[7]),
        ext: num(c[8]),
      });
    }
  }

  return {
    orderNumber,
    emailType: classifyType(meta.subject),
    subject: meta.subject || null,
    emailFrom: meta.from || null,
    emailDate: meta.date || null,
    messageId: meta.messageId || null,
    account: shipTo.account || billTo.account || null,
    storeName: shipTo.name || billTo.name || null,
    billTo,
    shipTo,
    orderType: g('order type'),
    poNumber: g('po #') || g('po#'),
    shipVia: g('shipped via'),
    headerShipDate,
    dates: { created: g('created'), ordered: g('ordered'), shipped: g('shipped') },
    createdBy: g('created by'),
    warehouse: g('warehouse'),
    terms: g('terms'),
    categorySubtotals,
    totals,
    lineItems,
    itemCount: lineItems.length,
  };
}

module.exports = { parseNdcpOrder, qpDecode, classifyType, cellText, num };
