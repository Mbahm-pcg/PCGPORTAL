// PCG Portal — Business Expense Receipts (gas/food/tools/supplies/repairs/
// office/other), backed by Neon Postgres. Receipt photos are a separate small
// Netlify Blob per entry, referenced by receipt_key (same pattern as the
// existing maintenance-ticket expenses in tickets.mjs, but that feature is a
// per-ticket, VP-approved job-cost log — this is a flat, unapproved personal-
// receipt log open to every role). See
// docs/superpowers/specs/2026-09-07-business-expenses-design.md.
//
// Actions (POST { action, ... }), ALL requiring an active portal session:
//   create { storePc?, category, amount, note?, receiptBase64? } → { ok, expense }
//   list   { storePc?, district?, category?, dateFrom?, dateTo? } → { ok, expenses:[…] }
//     Non-admin callers (anything but executive/it/office_staff) are always
//     force-scoped server-side to their own submissions — see buildListScope.
//   delete { id } → { ok }
//     Allowed for the row's own submitter, or executive/it for any row.
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { STORE_BY_PC } from './ndcp-lib/store-map.js';
import { isValidCategory, resolveStoreFields, canDeleteExpense, buildListScope } from './expenses-lib/scope.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

function blobStore() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });
}

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS business_expenses (
    id                   text PRIMARY KEY,
    submitted_by_user_id integer NOT NULL,
    submitted_by_name    text NOT NULL,
    user_type            text NOT NULL,
    store_pc             text,
    store_name           text,
    district             integer,
    category             text NOT NULL,
    amount               numeric NOT NULL,
    note                 text,
    receipt_key          text,
    created_at           timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bexp_user ON business_expenses(submitted_by_user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bexp_store ON business_expenses(store_pc)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_bexp_created ON business_expenses(created_at)`;
  _ready = true;
}

function rowToExpense(r) {
  return {
    id: r.id,
    submittedByUserId: r.submitted_by_user_id,
    submittedByName: r.submitted_by_name,
    userType: r.user_type,
    storePc: r.store_pc,
    storeName: r.store_name,
    district: r.district,
    category: r.category,
    amount: r.amount != null ? Number(r.amount) : 0,
    note: r.note,
    receiptKey: r.receipt_key,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function genId() {
  return `bexp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (!action) return json(400, { error: 'Missing action' });

  // require-user.js's bearer() reads event.headers.authorization/.cookie as
  // plain object properties, but this is a fetch-style function whose
  // request.headers is a Headers object (no bracket access) — this shim
  // adapts it, same as system-health.mjs does.
  const eventShim = {
    headers: {
      authorization: request.headers.get('authorization') || '',
      cookie: request.headers.get('cookie') || '',
    },
  };

  try {
    const sql = db();
    await ensureTables();

    const claims = await requireActiveUser(eventShim, sql);
    if (!claims) return json(401, { error: 'Sign in required' });

    if (action === 'create') {
      const category = payload.category;
      if (!isValidCategory(category)) return json(400, { error: 'Invalid category' });
      const amount = Number(payload.amount);
      if (!Number.isFinite(amount) || amount <= 0) return json(400, { error: 'Amount must be a positive number' });

      const id = genId();
      const { storePc, storeName, district } = resolveStoreFields(payload.storePc, STORE_BY_PC);
      const submittedByName = claims.name || claims.username;

      let receiptKey = null;
      if (payload.receiptBase64) {
        receiptKey = `pcg_business_expense_receipt_${id}`;
        await blobStore().setJSON(receiptKey, {
          savedAt: new Date().toISOString(),
          data: { base64: payload.receiptBase64, addedBy: submittedByName, addedAt: new Date().toISOString() },
        });
      }

      const rows = await sql`
        INSERT INTO business_expenses (
          id, submitted_by_user_id, submitted_by_name, user_type,
          store_pc, store_name, district, category, amount, note, receipt_key
        ) VALUES (
          ${id}, ${claims.sub}, ${submittedByName}, ${claims.userType},
          ${storePc}, ${storeName}, ${district}, ${category}, ${amount}, ${payload.note || null}, ${receiptKey}
        ) RETURNING *`;
      return json(200, { ok: true, expense: rowToExpense(rows[0]) });
    }

    if (action === 'list') {
      const scope = buildListScope(claims, payload);
      const rows = scope.forceUserId != null
        ? await sql`
            SELECT * FROM business_expenses
            WHERE submitted_by_user_id = ${scope.forceUserId}
              AND (${scope.storePc}::text IS NULL OR store_pc = ${scope.storePc})
              AND (${scope.district}::int IS NULL OR district = ${scope.district})
              AND (${scope.category}::text IS NULL OR category = ${scope.category})
              AND (${scope.dateFrom}::timestamptz IS NULL OR created_at >= ${scope.dateFrom}::timestamptz)
              AND (${scope.dateTo}::timestamptz IS NULL OR created_at <= ${scope.dateTo}::timestamptz)
            ORDER BY created_at DESC LIMIT 2000`
        : await sql`
            SELECT * FROM business_expenses
            WHERE (${scope.storePc}::text IS NULL OR store_pc = ${scope.storePc})
              AND (${scope.district}::int IS NULL OR district = ${scope.district})
              AND (${scope.category}::text IS NULL OR category = ${scope.category})
              AND (${scope.dateFrom}::timestamptz IS NULL OR created_at >= ${scope.dateFrom}::timestamptz)
              AND (${scope.dateTo}::timestamptz IS NULL OR created_at <= ${scope.dateTo}::timestamptz)
            ORDER BY created_at DESC LIMIT 2000`;
      return json(200, { ok: true, expenses: rows.map(rowToExpense) });
    }

    if (action === 'delete') {
      const id = payload.id != null ? String(payload.id) : null;
      if (!id) return json(400, { error: 'Missing id' });
      const rows = await sql`SELECT * FROM business_expenses WHERE id = ${id}`;
      if (!rows.length) return json(404, { error: 'Not found' });
      if (!canDeleteExpense(rows[0], claims)) return json(403, { error: 'Not allowed to delete this entry' });
      if (rows[0].receipt_key) await blobStore().delete(rows[0].receipt_key).catch(() => {});
      await sql`DELETE FROM business_expenses WHERE id = ${id}`;
      return json(200, { ok: true });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('expenses.mjs error:', err);
    return json(500, { error: err.message });
  }
};
