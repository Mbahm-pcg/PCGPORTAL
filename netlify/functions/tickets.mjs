// PCG Portal — Maintenance Tickets, backed by Neon Postgres.
// Replaces the single `pcg_tickets_v1` Netlify Blob (which held the whole ticket
// array, cached in browser localStorage) with normalized rows:
//   • maint_tickets          — one row per ticket
//   • maint_ticket_comments  — the ticket's activity log (1 ticket → N comments)
//   • maint_ticket_expenses  — logged expenses (1 ticket → N expenses)
// Reported issues and attachment metadata stay as JSONB on the ticket row
// (attachments hold inline dataUrls today, same as the old blob — media handling
// is unchanged by this migration). Expense receipts remain separate blobs,
// referenced by receipt_key.
//
// Actions (POST { action, ... }):
//   list           → { ok, tickets:[…] }   reconstructed client-shaped array
//   sync  {tickets}→ { ok, count }         upsert the whole array (one txn; never deletes)
//   delete {id}    → { ok }                delete one ticket (+ its comments/expenses)
//
// The frontend's cloudSave/cloudLoad('pcg_tickets_v1') are routed here, so the
// rest of the app keeps using the same array interface with no other changes.
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS maint_tickets (
    id              bigint PRIMARY KEY,
    number          text,
    title           text NOT NULL DEFAULT '',
    description     text,
    notes           text,
    status          text NOT NULL DEFAULT 'Open',
    priority        text DEFAULT 'Medium',
    category        text,
    store_pc        text,
    store_name      text,
    address         text,
    due_date        text,
    ticket_owner    text,
    created_by      text,
    selected_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
    attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
    expenses        jsonb NOT NULL DEFAULT '[]'::jsonb,
    started_by      text,
    started_at      timestamptz,
    closed_by       text,
    closed_at       timestamptz,
    meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now()
  )`;
  // PK is composite (ticket_id, id), NOT id alone: comment ids are client
  // Date.now() values that are only unique within a ticket, so a global PK would
  // let two same-millisecond comments on different tickets collide and overwrite.
  await sql`CREATE TABLE IF NOT EXISTS maint_ticket_comments (
    id          bigint NOT NULL,
    ticket_id   bigint NOT NULL,
    author      text,
    initials    text,
    type        text DEFAULT 'comment',
    text        text,
    created_at  timestamptz DEFAULT now(),
    PRIMARY KEY (ticket_id, id)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_mtc_ticket ON maint_ticket_comments(ticket_id)`;
  // Expenses are a child of a ticket (1 ticket → N expenses). Expense ids are
  // strings ("exp_<ts>_<rand>"), so the PK is text, not bigint.
  await sql`CREATE TABLE IF NOT EXISTS maint_ticket_expenses (
    id                   text PRIMARY KEY,
    ticket_id            bigint NOT NULL,
    no_expense           boolean DEFAULT false,
    description          text,
    amount               numeric,
    category             text,
    added_by             text,
    submitted_by_user_id text,
    added_at             timestamptz,
    receipt_key          text,
    approval_status      text,
    approved_by          text,
    approved_at          timestamptz,
    meta                 jsonb NOT NULL DEFAULT '{}'::jsonb
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_mte_ticket ON maint_ticket_expenses(ticket_id)`;

  // Migrate older deploys: maint_ticket_comments was first created with a single-
  // column PK (id). CREATE TABLE IF NOT EXISTS won't alter it, so upgrade it to
  // the composite (ticket_id, id) PK here. Best-effort — the comment insert uses
  // ON CONFLICT DO NOTHING so it works even if this migration is skipped.
  try {
    const pk = await sql`
      SELECT a.attname AS col
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
      WHERE t.relname = 'maint_ticket_comments' AND c.contype = 'p'`;
    const cols = pk.map((r) => r.col);
    if (cols.length && !(cols.includes('ticket_id') && cols.includes('id'))) {
      await sql`ALTER TABLE maint_ticket_comments DROP CONSTRAINT IF EXISTS maint_ticket_comments_pkey`;
      await sql`ALTER TABLE maint_ticket_comments ADD CONSTRAINT maint_ticket_comments_pkey PRIMARY KEY (ticket_id, id)`;
    }
  } catch (e) { console.warn('[tickets] comment PK migration skipped:', e.message); }
  _ready = true;
}

// Columns we map explicitly; everything else on the ticket object is preserved
// in the `meta` JSONB so no field is silently lost across the round-trip.
const KNOWN = new Set([
  'id', 'number', 'title', 'description', 'notes', 'status', 'priority', 'category',
  'storePC', 'storeName', 'address', 'dueDate', 'ticketOwner', 'createdBy',
  'selectedIssues', 'attachments', 'expenses', 'startedBy', 'startedAt',
  'closedBy', 'closedAt', 'createdAt', 'updatedAt', 'comments',
]);

const toBigInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const ts = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// Expense columns we map explicitly; anything else is preserved in `meta`.
const EXPENSE_KNOWN = new Set([
  'id', 'noExpense', 'description', 'amount', 'category', 'addedBy',
  'submittedByUserId', 'addedAt', 'receiptKey', 'approvalStatus', 'approvedBy', 'approvedAt',
]);

// Expense DB row → client-shaped expense object.
function rowToExpense(r) {
  return {
    ...(r.meta || {}),
    id: r.id,
    noExpense: r.no_expense || undefined,
    description: r.description ?? undefined,
    amount: r.amount ?? undefined,
    category: r.category ?? undefined,
    addedBy: r.added_by ?? undefined,
    submittedByUserId: r.submitted_by_user_id ?? undefined,
    addedAt: r.added_at ? new Date(r.added_at).toISOString() : undefined,
    receiptKey: r.receipt_key ?? undefined,
    approvalStatus: r.approval_status ?? undefined,
    approvedBy: r.approved_by ?? undefined,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : undefined,
  };
}

// DB row (+ its comments + expenses) → client-shaped ticket object.
function rowToTicket(r, comments, expenses) {
  return {
    ...(r.meta || {}),
    id: Number(r.id),
    number: r.number || undefined,
    title: r.title || '',
    description: r.description ?? undefined,
    notes: r.notes ?? undefined,
    status: r.status || 'Open',
    priority: r.priority || 'Medium',
    category: r.category ?? undefined,
    storePC: r.store_pc ?? undefined,
    storeName: r.store_name ?? undefined,
    address: r.address ?? undefined,
    dueDate: r.due_date ?? undefined,
    ticketOwner: r.ticket_owner ?? undefined,
    createdBy: r.created_by ?? undefined,
    selectedIssues: r.selected_issues || [],
    attachments: r.attachments || [],
    expenses: expenses || [],
    startedBy: r.started_by ?? undefined,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
    closedBy: r.closed_by ?? undefined,
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : undefined,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
    comments,
  };
}

// Build the (unawaited) SQL statements that upsert one client ticket plus its
// comments and expenses. Returned as an array so a whole batch can run inside a
// single `sql.transaction([...])` — one HTTP round-trip, atomically — instead of
// hundreds of sequential awaits (which blew the 26s timeout as ticket volume grew).
function ticketStatements(t) {
  const sql = db();
  const id = toBigInt(t.id);
  if (id == null) return [];
  const stmts = [];
  const meta = {};
  for (const k of Object.keys(t || {})) if (!KNOWN.has(k)) meta[k] = t[k];
  stmts.push(sql`
    INSERT INTO maint_tickets (
      id, number, title, description, notes, status, priority, category,
      store_pc, store_name, address, due_date, ticket_owner, created_by,
      selected_issues, attachments, expenses, started_by, started_at,
      closed_by, closed_at, meta, created_at, updated_at
    ) VALUES (
      ${id}, ${t.number || null}, ${t.title || ''}, ${t.description ?? null}, ${t.notes ?? null},
      ${t.status || 'Open'}, ${t.priority || 'Medium'}, ${t.category ?? null},
      ${t.storePC ?? null}, ${t.storeName ?? null}, ${t.address ?? null}, ${t.dueDate ?? null},
      ${t.ticketOwner ?? null}, ${t.createdBy ?? null},
      ${JSON.stringify(t.selectedIssues || [])}::jsonb,
      ${JSON.stringify(t.attachments || [])}::jsonb,
      '[]'::jsonb,
      ${t.startedBy ?? null}, ${ts(t.startedAt)}, ${t.closedBy ?? null}, ${ts(t.closedAt)},
      ${JSON.stringify(meta)}::jsonb, ${ts(t.createdAt) || new Date().toISOString()},
      ${ts(t.updatedAt) || new Date().toISOString()}
    )
    ON CONFLICT (id) DO UPDATE SET
      number = EXCLUDED.number, title = EXCLUDED.title, description = EXCLUDED.description,
      notes = EXCLUDED.notes, status = EXCLUDED.status, priority = EXCLUDED.priority,
      category = EXCLUDED.category, store_pc = EXCLUDED.store_pc, store_name = EXCLUDED.store_name,
      address = EXCLUDED.address, due_date = EXCLUDED.due_date, ticket_owner = EXCLUDED.ticket_owner,
      created_by = EXCLUDED.created_by, selected_issues = EXCLUDED.selected_issues,
      attachments = EXCLUDED.attachments, expenses = EXCLUDED.expenses,
      started_by = EXCLUDED.started_by, started_at = EXCLUDED.started_at,
      closed_by = EXCLUDED.closed_by, closed_at = EXCLUDED.closed_at,
      meta = EXCLUDED.meta, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`);

  // Comments are append-only in the UI — insert any we haven't seen.
  const comments = Array.isArray(t.comments) ? t.comments : [];
  for (const c of comments) {
    const cid = toBigInt(c?.id);
    if (cid == null) continue;
    // Comments are append-only (never edited after creation), so DO NOTHING is
    // correct — and it works against ANY existing PK shape, so a sync can't 500
    // even if the PK migration above hasn't run yet.
    stmts.push(sql`
      INSERT INTO maint_ticket_comments (id, ticket_id, author, initials, type, text, created_at)
      VALUES (${cid}, ${id}, ${c.author ?? null}, ${c.initials ?? null}, ${c.type || 'comment'},
              ${c.text ?? null}, ${ts(c.createdAt) || new Date().toISOString()})
      ON CONFLICT DO NOTHING`);
  }

  // Expenses → child table. Added once then updated on approve/reject, so upsert
  // by id (no delete-missing — a sync can come from a stale/partial client copy,
  // same reasoning as the ticket-level sync above; individual expense deletion
  // goes through the explicit `deleteExpense` action instead).
  const expenses = Array.isArray(t.expenses) ? t.expenses : [];
  for (const e of expenses) {
    const eid = e?.id != null ? String(e.id) : null;
    if (!eid) continue;
    const emeta = {};
    for (const k of Object.keys(e)) if (!EXPENSE_KNOWN.has(k)) emeta[k] = e[k];
    stmts.push(sql`
      INSERT INTO maint_ticket_expenses (
        id, ticket_id, no_expense, description, amount, category, added_by,
        submitted_by_user_id, added_at, receipt_key, approval_status, approved_by, approved_at, meta
      ) VALUES (
        ${eid}, ${id}, ${!!e.noExpense}, ${e.description ?? null}, ${num(e.amount)}, ${e.category ?? null},
        ${e.addedBy ?? null}, ${e.submittedByUserId != null ? String(e.submittedByUserId) : null},
        ${ts(e.addedAt)}, ${e.receiptKey ?? null}, ${e.approvalStatus ?? null}, ${e.approvedBy ?? null},
        ${ts(e.approvedAt)}, ${JSON.stringify(emeta)}::jsonb
      )
      ON CONFLICT (id) DO UPDATE SET
        ticket_id = EXCLUDED.ticket_id, no_expense = EXCLUDED.no_expense,
        description = EXCLUDED.description, amount = EXCLUDED.amount, category = EXCLUDED.category,
        added_by = EXCLUDED.added_by, submitted_by_user_id = EXCLUDED.submitted_by_user_id,
        added_at = EXCLUDED.added_at, receipt_key = EXCLUDED.receipt_key,
        approval_status = EXCLUDED.approval_status, approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at, meta = EXCLUDED.meta`);
  }
  return stmts;
}

async function listTickets() {
  const sql = db();
  const rows = await sql`SELECT * FROM maint_tickets ORDER BY created_at DESC`;
  const comments = await sql`SELECT * FROM maint_ticket_comments ORDER BY created_at ASC`;
  const expenses = await sql`SELECT * FROM maint_ticket_expenses ORDER BY added_at ASC`;
  const commentsByTicket = new Map();
  for (const c of comments) {
    const k = String(c.ticket_id);
    if (!commentsByTicket.has(k)) commentsByTicket.set(k, []);
    commentsByTicket.get(k).push({
      id: Number(c.id), author: c.author ?? undefined, initials: c.initials ?? undefined,
      type: c.type || 'comment', text: c.text ?? undefined,
      createdAt: c.created_at ? new Date(c.created_at).toISOString() : undefined,
    });
  }
  const expensesByTicket = new Map();
  for (const e of expenses) {
    const k = String(e.ticket_id);
    if (!expensesByTicket.has(k)) expensesByTicket.set(k, []);
    expensesByTicket.get(k).push(rowToExpense(e));
  }
  return rows.map((r) => rowToTicket(r, commentsByTicket.get(String(r.id)) || [], expensesByTicket.get(String(r.id)) || []));
}

// One-time migration: pull the legacy whole-array blob and import it. Runs only
// when the table is empty so it never clobbers DB-authoritative data.
async function importLegacyIfEmpty() {
  const sql = db();
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM maint_tickets`;
  if (c > 0) return false;
  let legacy = null;
  try {
    const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const wrapped = await store.get('pcg_tickets_v1', { type: 'json' });
    legacy = wrapped?.data;
  } catch { /* no legacy blob */ }
  if (!Array.isArray(legacy) || legacy.length === 0) return false;
  // Import atomically so a single bad ticket can't leave a half-migrated table
  // (which would then read as non-empty and skip the rest forever).
  const stmts = legacy.flatMap(ticketStatements);
  if (stmts.length) await sql.transaction(stmts);
  return true;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (!action) return json(400, { error: 'Missing action' });

  try {
    await ensureTables();

    if (action === 'list') {
      await importLegacyIfEmpty();
      return json(200, { ok: true, tickets: await listTickets() });
    }

    if (action === 'sync') {
      // Upsert-only: no delete-missing. A stale/partial writer (e.g. the mobile
      // view's localStorage-backed copy) must never be able to wipe tickets it
      // simply hasn't loaded — deletions go through the explicit `delete` action.
      const tickets = Array.isArray(payload.tickets) ? payload.tickets : [];
      const sql = db();

      // A ticket can only become Closed with a short (1-50 word) completion note
      // attached — the Tickets UI enforces this client-side, but that's only a
      // modal gate; anything hitting this endpoint directly (another client, a
      // script, a future automation) must be blocked here too, or the rule is
      // meaningless. Reject the Closed transition (fall back to the ticket's
      // current DB status) rather than failing the whole sync, so unrelated
      // changes in the same batch (comments, expenses, other tickets) still save.
      const invalidCloseIds = tickets
        .filter(t => t?.status === 'Closed')
        .filter(t => {
          const note = typeof t.completionNote === 'string' ? t.completionNote.trim() : '';
          const words = note ? note.split(/\s+/).filter(Boolean).length : 0;
          return words === 0 || words > 50;
        })
        .map(t => toBigInt(t.id))
        .filter(id => id != null);

      let existingStatus = new Map();
      if (invalidCloseIds.length) {
        const rows = await sql`SELECT id, status FROM maint_tickets WHERE id = ANY(${invalidCloseIds})`;
        existingStatus = new Map(rows.map(r => [Number(r.id), r.status]));
      }

      const patched = invalidCloseIds.length
        ? tickets.map(t => {
            const id = toBigInt(t.id);
            if (id != null && invalidCloseIds.includes(id)) {
              return { ...t, status: existingStatus.get(id) || 'Open', closedBy: null, closedAt: null, completionNote: null };
            }
            return t;
          })
        : tickets;

      const stmts = patched.flatMap(ticketStatements);
      if (stmts.length) await sql.transaction(stmts);
      return json(200, { ok: true, count: tickets.length, ...(invalidCloseIds.length ? { rejectedCloseCount: invalidCloseIds.length } : {}) });
    }

    if (action === 'delete') {
      const id = toBigInt(payload.id);
      if (id == null) return json(400, { error: 'Missing id' });
      const sql = db();
      await sql.transaction([
        sql`DELETE FROM maint_ticket_expenses WHERE ticket_id = ${id}`,
        sql`DELETE FROM maint_ticket_comments WHERE ticket_id = ${id}`,
        sql`DELETE FROM maint_tickets WHERE id = ${id}`,
      ]);
      return json(200, { ok: true });
    }

    // Explicit single-expense delete (exec/IT only, gated client-side). Mirrors the
    // ticket-level `delete` action's reasoning: sync is upsert-only precisely so a
    // stale/partial writer can never wipe data it hasn't loaded, so an intentional
    // expense removal must be a targeted delete, not inferred from array-diffing.
    if (action === 'deleteExpense') {
      const ticketId = toBigInt(payload.ticketId);
      const expenseId = payload.expenseId != null ? String(payload.expenseId) : null;
      if (ticketId == null || !expenseId) return json(400, { error: 'ticketId and expenseId required' });
      const sql = db();
      await sql`DELETE FROM maint_ticket_expenses WHERE id = ${expenseId} AND ticket_id = ${ticketId}`;
      return json(200, { ok: true });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('tickets.mjs error:', err);
    return json(500, { error: err.message });
  }
};
