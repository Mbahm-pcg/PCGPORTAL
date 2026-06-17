// ndcp-backfill.js — one-time / on-demand import of National DCP supply-order emails.
// Impersonates the NDCP mailbox via the existing Google service account (domain-wide
// delegation, gmail.readonly), pages through ALL `from:natdcp.com` mail, parses each
// order out of the HTML body, and upserts into the Neon `ndcp_orders` table.
//
// Safe to re-run: rows are keyed by Gmail message_id (ON CONFLICT DO UPDATE), so a
// second run refreshes parses without creating duplicates.
//
// Trigger (manual):
//   curl -X POST https://pcg-ops.netlify.app/.netlify/functions/ndcp-backfill \
//        -H "Authorization: Bearer $PCG_MCP_SECRET"
// Optional JSON body: { "query": "from:natdcp.com", "max": 1000 }

const crypto = require('crypto');
const { google } = require('googleapis');
const { sql } = require('./_shared/db');
const { ensureTable, upsertMessage } = require('./ndcp-lib/ndcp-ingest');

// Constant-time bearer-token check (avoids leaking length/early-exit timing).
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  const cors = { 'Content-Type': 'application/json' };
  const reply = (code, obj) => ({ statusCode: code, headers: cors, body: JSON.stringify(obj) });

  // Auth: dedicated secret (NDCP_BACKFILL_SECRET), Functions-scoped in Netlify.
  // Fail CLOSED — this handler reads a mailbox and writes the DB, so it must never
  // run unauthenticated or unconfigured.
  const SECRET = process.env.NDCP_BACKFILL_SECRET;
  if (!SECRET) return reply(500, { error: 'NDCP_BACKFILL_SECRET not configured' });
  const raw = (event.headers?.authorization || event.headers?.Authorization || '');
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  if (!tokenMatches(token, SECRET)) return reply(401, { error: 'unauthorized' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const query = body.query || 'from:natdcp.com';
  // Per-call batch size — kept modest so the expensive messages.get loop stays
  // under the 26s manual-invoke timeout. The caller loops until remaining = 0.
  const max = Math.min(Number(body.max) || 40, 200);

  // Read-only summary of what's been ingested (no Gmail call needed).
  if (body.action === 'summary') {
    try {
      const db = sql();
      const [c] = await db`
        SELECT count(*)::int AS rows, count(DISTINCT order_number)::int AS orders,
               count(DISTINCT store_name)::int AS stores,
               min(email_date)::date AS first_date, max(email_date)::date AS last_date
        FROM ndcp_orders`;
      const byType = await db`SELECT email_type, count(*)::int AS n FROM ndcp_orders GROUP BY email_type ORDER BY n DESC`;
      const byStore = await db`SELECT store_name, count(*)::int AS n FROM ndcp_orders GROUP BY store_name ORDER BY n DESC`;
      return reply(200, { ok: true, summary: c, byType, byStore });
    } catch (e) { return reply(500, { error: e.message }); }
  }

  const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  // The NDCP orders are delivered to reports@; default there, but allow override.
  const MAILBOX = process.env.NDCP_MAILBOX || 'reports@peoplecapitalgroup.com';
  if (!SERVICE_ACCOUNT_KEY) return reply(500, { error: 'GOOGLE_SERVICE_ACCOUNT_KEY not configured' });

  let credentials;
  try { credentials = JSON.parse(SERVICE_ACCOUNT_KEY); }
  catch { return reply(500, { error: 'Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON' }); }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: MAILBOX,
  });
  const gmail = google.gmail({ version: 'v1', auth });

  try {
    const db = sql();
    await ensureTable(db);

    // Page through EVERY matching message id (listing is cheap). Hard cap guards
    // against runaway loops.
    const HARD_CAP = 5000;
    const ids = [];
    let pageToken;
    do {
      const res = await gmail.users.messages.list({ userId: MAILBOX, q: query, maxResults: 100, pageToken });
      (res.data.messages || []).forEach((m) => ids.push(m.id));
      pageToken = res.data.nextPageToken;
    } while (pageToken && ids.length < HARD_CAP);

    // Resume support: skip ids already stored, then process only a batch this call.
    // message_id is the unique key, so it doubles as a progress cursor.
    const existingRows = await db`SELECT message_id FROM ndcp_orders`;
    const existing = new Set(existingRows.map((r) => r.message_id));
    const todo = ids.filter((id) => !existing.has(id));
    const batch = todo.slice(0, max);

    let parsed = 0, stored = 0, skipped = 0;
    const samples = [];
    for (const id of batch) {
      try {
        const msgRes = await gmail.users.messages.get({ userId: MAILBOX, id, format: 'full' });
        const r = await upsertMessage(db, msgRes.data);
        if (!r.stored) { skipped++; continue; }
        parsed++; stored++;
        if (samples.length < 10) {
          const o = r.order;
          samples.push({ order: o.orderNumber, type: o.emailType, store: o.storeName,
            date: o.dates.ordered, total: o.totals.totalOrder, items: o.itemCount, subject: o.subject });
        }
      } catch (e) {
        skipped++;
        console.warn(`[ndcp-backfill] message ${id} failed: ${e.message}`);
      }
    }

    // remaining = matching emails still not attempted after this batch.
    const remaining = Math.max(0, todo.length - batch.length);
    return reply(200, {
      ok: true, mailbox: MAILBOX, query,
      totalFound: ids.length, alreadyStored: existing.size,
      batch: batch.length, parsed, stored, skipped, remaining, samples,
    });
  } catch (e) {
    console.error('[ndcp-backfill] error:', e.message);
    return reply(500, { error: e.message });
  }
};
