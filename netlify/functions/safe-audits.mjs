// safe-audits.mjs — Safe Audit (cash / petty-cash reconciliation) module API.
// Pattern: audits.mjs (Field Ops). This is NOT the pass/fail Field Ops audit — it's a
// denomination cash count reconciled against a per-store locked "expected petty cash".
//
// Tables (self-created via ensureTables(), documented in db/schema.ts):
//   safe_settings — per-store locked expected petty cash (store_pc PK). Set on a store's
//                   first audit submit; only executive/it may change it afterward.
//   safe_audits   — one row per safe audit (draft → submitted). id = client Date.now().
//
// Actions (POST { action, ... } to /.netlify/functions/safe-audits, auth via pcg_session
// cookie / Bearer — requireActiveUser, same as audits.mjs):
//   list           { storePC? } → { ok, audits:[…] }                     role-scoped
//   get            { id } → { ok, audit }                                 role-scoped
//   safeSetting    { storePC } → { ok, expected|null, locked, canEdit, setByName, setAt }
//   setSafeExpected{ storePC, expected } → { ok, expected }              exec/it only
//   saveDraft      { id?, storePC, ...fields } → { ok, id }              conduct roles only
//   submit         { id } → { ok, audit, alerted }                        conduct roles only
import { neon } from '@neondatabase/serverless';
import https from 'node:https';
import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
// Direct ESM named imports of these CommonJS libs — the same interop pattern audits.mjs
// and audit-cap-cron.mjs use (cjs-module-lexer resolves named imports from
// `module.exports = { ... }`; a static `import` survives Netlify's function bundler, whereas
// createRequire(import.meta.url) does not — see the long note in audits.mjs).
import { requireActiveUser } from './auth-lib/require-user.js';
import { computeCashTotals, computeVariance, shouldAlert, REASONS } from './audit-lib/safe-cash.js';

const cors = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });
let _sql = null; const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

// pc → { district } for store→district lookup on the shortage/counterfeit alert. Copied
// from audits.mjs's AUDIT_STORES (itself copied from app.jsx STORES_SEED) rather than
// imported — the frontend bundle isn't importable from a Netlify Function. See CLAUDE.md
// "Common Gotchas" #9 (duplicated store config, also in labor-cron.js, schedule-alerts.js,
// audits.mjs, ndcp-lib/store-map.js) — keep this list in sync if stores/districts change.
const AUDIT_STORES = [
  { pc: '339616', district: 1 }, { pc: '340794', district: 1 },
  { pc: '351099', district: 2 }, { pc: '351259', district: 2 }, { pc: '302642', district: 2 },
  { pc: '352894', district: 2 }, { pc: '341350', district: 2 }, { pc: '337839', district: 2 },
  { pc: '330338', district: 3 }, { pc: '337063', district: 3 }, { pc: '343832', district: 3 },
  { pc: '304669', district: 3 }, { pc: '355146', district: 3 }, { pc: '300496', district: 3 },
  { pc: '304863', district: 3 }, { pc: '354561', district: 3 }, { pc: '332393', district: 3 },
  { pc: '341167', district: 4 }, { pc: '340870', district: 4 }, { pc: '335981', district: 4 },
  { pc: '353150', district: 4 }, { pc: '351050', district: 4 }, { pc: '345985', district: 4 },
  { pc: '356374', district: 5 }, { pc: '353843', district: 5 }, { pc: '353047', district: 5 },
  { pc: '340538', district: 5 },
  { pc: '343079', district: 6 }, { pc: '342144', district: 6 }, { pc: '364295', district: 6 },
  { pc: '365361', district: 7 }, { pc: '310382', district: 7 }, { pc: '332941', district: 7 },
  { pc: '343497', district: 7 }, { pc: '302446', district: 7 }, { pc: '337079', district: 7 },
  { pc: '345986', district: 7 }, { pc: '364412', district: 7 }, { pc: '345489', district: 7 },
  { pc: '336372', district: 7 },
  { pc: '358933', district: 8 }, { pc: '354865', district: 8 }, { pc: '353689', district: 8 },
  { pc: '342184', district: 8 }, { pc: '356316', district: 8 },
];
const DISTRICT_BY_PC = new Map(AUDIT_STORES.map((s) => [s.pc, s.district]));

// ── Role helpers (server-enforced in every action) ────────────────────────────
// `grant` is the user's audits_access grant ('view' | 'full' | null), fetched fresh
// per-request by requireActiveUser so a grant/revoke takes effect immediately.
const CONDUCT_ROLES = new Set(['manager', 'dm', 'auditor', 'executive', 'it']);
const safeCanConduct = (userType, grant) => CONDUCT_ROLES.has(userType) || grant === 'full';
const safeCanView = (userType, grant) => safeCanConduct(userType, grant) || userType === 'office_staff' || !!grant;
const canEditExpected = (userType) => userType === 'executive' || userType === 'it';

// Role-scoped store visibility: 'all' | { storePCs:[..] } | 'none'.
// manager → own store; dm → their district's stores; auditor/exec/it/office_staff → all;
// any audits_access grant elevates to full-portfolio view (mirrors visibleStores() in audits.mjs).
function visibleStoresSafe(user) {
  const grant = user.auditsAccess;
  const hasGrant = grant === 'view' || grant === 'full';
  const ut = user.userType;
  if (ut === 'auditor' || ut === 'executive' || ut === 'it' || ut === 'office_staff' || hasGrant) return 'all';
  if (ut === 'dm') {
    // dm district-scoping (keyed on real userType). See CLAUDE.md "Common Gotchas" #9.
    const storePCs = AUDIT_STORES.filter((s) => String(s.district) === String(user.district)).map((s) => s.pc);
    return { storePCs };
  }
  if (ut === 'manager') return { storePCs: [String(user.storePC || '')] };
  return 'none';
}

function storeInScope(scope, storePc) {
  if (scope === 'all') return true;
  if (scope === 'none') return false;
  return scope.storePCs.includes(String(storePc));
}

const toBigInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const toBool = (v) => v === true || v === 'true' || v === 'yes' || v === 'Yes' || v === 1 || v === '1';
const iso = (v) => (v ? new Date(v).toISOString() : undefined);

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  const sql = db();
  // Belt-and-suspenders with users.mjs/audits.mjs — requireActiveUser() reads audits_access.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS audits_access text`;
  await sql`CREATE TABLE IF NOT EXISTS safe_settings (
    store_pc              text PRIMARY KEY,
    expected_petty_cash   numeric NOT NULL,
    set_by_user_id        int,
    set_by_name           text,
    set_at                timestamptz,
    updated_by_user_id    int,
    updated_by_name       text,
    updated_at            timestamptz
  )`;
  await sql`CREATE TABLE IF NOT EXISTS safe_audits (
    id                     bigint PRIMARY KEY, -- client Date.now(), same convention as audits/maint_tickets
    store_pc               text,
    store_name             text,
    auditor_user_id        int,
    auditor_name           text,
    auditor_role           text,
    status                 text NOT NULL DEFAULT 'draft', -- draft | submitted
    started_at             timestamptz,
    submitted_at           timestamptz,
    reason                 text,
    safe_code              text,
    code_last_changed      text,
    store_manager_name     text,
    district               int,
    expected_petty_cash    numeric,
    has_receipts           boolean,
    receipts_total         numeric,
    receipt_photo_keys     jsonb NOT NULL DEFAULT '[]'::jsonb,
    bill_counts            jsonb NOT NULL DEFAULT '{}'::jsonb,
    coin_counts            jsonb NOT NULL DEFAULT '{}'::jsonb,
    bills_total            numeric,
    coins_total            numeric,
    counted_total          numeric,
    accounted_total        numeric,
    variance               numeric,
    variance_status        text,
    has_counterfeit        boolean,
    counterfeit_total      numeric,
    counterfeit_photo_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    conductor_sig_key      text,
    manager_sig_key        text,
    manager_ack_name       text,
    notes                  text,
    created_at             timestamptz DEFAULT now(),
    updated_at             timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_safe_audits_store ON safe_audits(store_pc)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_safe_audits_status ON safe_audits(status)`;
  _ready = true;
}

// ── Notification helpers — copied verbatim from audit-cap-cron.mjs (Resend email over raw
// https + web-push against pcg_push_subscriptions_v1). Do NOT invent new email/push infra.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const key = process.env.RESEND_API_KEY;
    if (!key || !to.length) return resolve(false);
    const payload = JSON.stringify({ from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>', to, subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false));
    req.write(payload); req.end();
  });
}

// Best-effort web push to the given user-ids. Never throws; prunes expired subscriptions.
async function sendPush(pushIds, title, body, tag) {
  if (!pushIds.length) return { sent: 0, expired: 0 };
  const vpub = process.env.VAPID_PUBLIC_KEY, vpriv = process.env.VAPID_PRIVATE_KEY;
  if (!vpub || !vpriv) return { sent: 0, expired: 0 };
  let store, subs = {};
  try {
    store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const w = await store.get('pcg_push_subscriptions_v1', { type: 'json' });
    subs = (w && w.data) ? w.data : {};
  } catch { return { sent: 0, expired: 0 }; }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`, vpub, vpriv);
  } catch { return { sent: 0, expired: 0 }; }
  const payload = JSON.stringify({ title, body: body || '', icon: '/apple-touch-icon.png', url: '/', tag: tag || undefined });
  let sent = 0; const expired = [];
  for (const uid of pushIds) {
    for (const sub of (subs[String(uid)] || [])) {
      try { await webpush.sendNotification(sub, payload); sent++; }
      catch (err) {
        if (err && (err.statusCode === 410 || err.statusCode === 404)) expired.push({ uid: String(uid), endpoint: sub.endpoint });
      }
    }
  }
  if (expired.length && store) {
    try {
      for (const { uid, endpoint } of expired) {
        if (subs[uid]) { subs[uid] = subs[uid].filter((s) => s.endpoint !== endpoint); if (!subs[uid].length) delete subs[uid]; }
      }
      await store.setJSON('pcg_push_subscriptions_v1', { savedAt: new Date().toISOString(), data: subs });
    } catch {}
  }
  return { sent, expired: expired.length };
}

const fmtMoney = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function rowToListItem(r) {
  return {
    id: Number(r.id),
    storePC: r.store_pc,
    storeName: r.store_name ?? undefined,
    auditorName: r.auditor_name ?? undefined,
    submittedAt: iso(r.submitted_at),
    expected: num(r.expected_petty_cash),
    countedTotal: num(r.counted_total),
    variance: num(r.variance),
    varianceStatus: r.variance_status ?? undefined,
    hasCounterfeit: !!r.has_counterfeit,
    status: r.status,
  };
}

function rowToAudit(r) {
  return {
    id: Number(r.id),
    storePC: r.store_pc,
    storeName: r.store_name ?? undefined,
    auditorUserId: r.auditor_user_id ?? undefined,
    auditorName: r.auditor_name ?? undefined,
    auditorRole: r.auditor_role ?? undefined,
    status: r.status,
    startedAt: iso(r.started_at),
    submittedAt: iso(r.submitted_at),
    reason: r.reason ?? undefined,
    safeCode: r.safe_code ?? undefined,
    codeLastChanged: r.code_last_changed ?? undefined,
    storeManagerName: r.store_manager_name ?? undefined,
    district: r.district ?? undefined,
    expectedPettyCash: num(r.expected_petty_cash),
    hasReceipts: !!r.has_receipts,
    receiptsTotal: num(r.receipts_total),
    receiptPhotoKeys: r.receipt_photo_keys || [],
    billCounts: r.bill_counts || {},
    coinCounts: r.coin_counts || {},
    billsTotal: num(r.bills_total),
    coinsTotal: num(r.coins_total),
    countedTotal: num(r.counted_total),
    accountedTotal: num(r.accounted_total),
    variance: num(r.variance),
    varianceStatus: r.variance_status ?? undefined,
    hasCounterfeit: !!r.has_counterfeit,
    counterfeitTotal: num(r.counterfeit_total),
    counterfeitPhotoKeys: r.counterfeit_photo_keys || [],
    conductorSigKey: r.conductor_sig_key ?? undefined,
    managerSigKey: r.manager_sig_key ?? undefined,
    managerAckName: r.manager_ack_name ?? undefined,
    notes: r.notes ?? undefined,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export default async (req) => {
  // 204 must have a null body (empty string still counts as a body for null-body statuses).
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });

  try {
    // ensureTables/requireActiveUser inside the try so a DB hiccup returns clean JSON, not a 500 stack.
    const sql = db();
    await ensureTables();
    const event = { headers: Object.fromEntries(req.headers.entries()) };
    const user = await requireActiveUser(event, sql);
    if (!user) return json(401, { ok: false, error: 'auth required' });
    const grant = user.auditsAccess;
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
      case 'list': {
        if (!safeCanView(user.userType, grant)) return json(403, { ok: false, error: 'forbidden' });
        const scope = visibleStoresSafe(user);
        if (scope === 'none') return json(200, { ok: true, audits: [] });
        const storePC = body.storePC != null ? String(body.storePC) : null;
        let rows;
        if (scope === 'all') {
          rows = storePC
            ? await sql`SELECT * FROM safe_audits WHERE store_pc = ${storePC} ORDER BY created_at DESC`
            : await sql`SELECT * FROM safe_audits ORDER BY created_at DESC`;
        } else {
          const pcs = storePC ? scope.storePCs.filter((p) => p === storePC) : scope.storePCs;
          rows = pcs.length ? await sql`SELECT * FROM safe_audits WHERE store_pc = ANY(${pcs}) ORDER BY created_at DESC` : [];
        }
        return json(200, { ok: true, audits: rows.map(rowToListItem) });
      }

      case 'get': {
        if (!safeCanView(user.userType, grant)) return json(403, { ok: false, error: 'forbidden' });
        const id = toBigInt(body.id);
        if (id == null) return json(400, { ok: false, error: 'id required' });
        const rows = await sql`SELECT * FROM safe_audits WHERE id = ${id}`;
        if (!rows.length) return json(404, { ok: false, error: 'not found' });
        const row = rows[0];
        if (!storeInScope(visibleStoresSafe(user), row.store_pc)) return json(403, { ok: false, error: 'forbidden' });
        return json(200, { ok: true, audit: rowToAudit(row) });
      }

      case 'safeSetting': {
        if (!safeCanView(user.userType, grant)) return json(403, { ok: false, error: 'forbidden' });
        const storePC = String(body.storePC || '');
        if (!storePC) return json(400, { ok: false, error: 'storePC required' });
        const rows = await sql`SELECT * FROM safe_settings WHERE store_pc = ${storePC}`;
        const s = rows[0];
        return json(200, {
          ok: true,
          expected: s ? num(s.expected_petty_cash) : null,
          locked: !!s,
          canEdit: canEditExpected(user.userType),
          setByName: s?.set_by_name ?? null,
          setAt: s?.set_at ? new Date(s.set_at).toISOString() : null,
        });
      }

      case 'setSafeExpected': {
        // The "edit later" path — executive/it only (A8). A non-exec/it client cannot
        // change a store's locked expected even by crafting the request.
        if (!canEditExpected(user.userType)) return json(403, { ok: false, error: 'forbidden' });
        const storePC = String(body.storePC || '');
        if (!storePC) return json(400, { ok: false, error: 'storePC required' });
        const expected = num(body.expected);
        if (expected == null) return json(400, { ok: false, error: 'expected (numeric) required' });
        const name = user.name || user.username || null;
        await sql`
          INSERT INTO safe_settings (store_pc, expected_petty_cash, set_by_user_id, set_by_name, set_at, updated_by_user_id, updated_by_name, updated_at)
          VALUES (${storePC}, ${expected}, ${user.sub ?? null}, ${name}, now(), ${user.sub ?? null}, ${name}, now())
          ON CONFLICT (store_pc) DO UPDATE SET
            expected_petty_cash = EXCLUDED.expected_petty_cash,
            updated_by_user_id = ${user.sub ?? null}, updated_by_name = ${name}, updated_at = now()`;
        return json(200, { ok: true, expected });
      }

      case 'saveDraft': {
        if (!safeCanConduct(user.userType, grant)) return json(403, { ok: false, error: 'forbidden' });
        const storePC = String(body.storePC || '');
        if (!storePC) return json(400, { ok: false, error: 'storePC required' });
        // Store-scope check: a manager/dm can't craft a draft for a store outside their scope.
        if (!storeInScope(visibleStoresSafe(user), storePC)) return json(403, { ok: false, error: 'forbidden' });

        const id = body.id != null ? toBigInt(body.id) : Date.now();
        if (id == null) return json(400, { ok: false, error: 'invalid id' });

        const existing = await sql`SELECT status FROM safe_audits WHERE id = ${id}`;
        if (existing.length && existing[0].status !== 'draft') {
          return json(409, { ok: false, error: 'audit is locked (already submitted)' });
        }

        const reason = body.reason != null && body.reason !== '' ? String(body.reason) : null;
        if (reason != null && !REASONS.includes(reason)) return json(400, { ok: false, error: 'invalid reason' });

        // Resolve expected: when a locked setting exists AND caller isn't exec/it, ignore any
        // client-supplied expected and use the locked value. A first-audit draft may carry the
        // entered expected (not yet locked — locking happens at submit).
        const lockRows = await sql`SELECT expected_petty_cash FROM safe_settings WHERE store_pc = ${storePC}`;
        const locked = lockRows.length > 0;
        let expected;
        if (locked && !canEditExpected(user.userType)) {
          expected = num(lockRows[0].expected_petty_cash);
        } else {
          expected = num(body.expectedPettyCash ?? body.expected);
        }

        const billCounts = (body.billCounts && typeof body.billCounts === 'object') ? body.billCounts : {};
        const coinCounts = (body.coinCounts && typeof body.coinCounts === 'object') ? body.coinCounts : {};
        const receiptPhotoKeys = Array.isArray(body.receiptPhotoKeys) ? body.receiptPhotoKeys : [];
        const counterfeitPhotoKeys = Array.isArray(body.counterfeitPhotoKeys) ? body.counterfeitPhotoKeys : [];
        const hasReceipts = toBool(body.hasReceipts);
        const hasCounterfeit = toBool(body.hasCounterfeit);
        const receiptsTotal = hasReceipts ? num(body.receiptsTotal) : null;
        const counterfeitTotal = hasCounterfeit ? num(body.counterfeitTotal) : null;

        // Convenience totals for the list/report (server recomputes authoritatively on submit).
        const { billsTotal, coinsTotal, countedTotal } = computeCashTotals(billCounts, coinCounts);
        let variance = null, varianceStatus = null, accountedTotal = null;
        if (expected != null) {
          const v = computeVariance({ countedTotal, receiptsTotal: receiptsTotal || 0, expected });
          variance = v.variance; varianceStatus = v.status; accountedTotal = v.accountedTotal;
        }

        const name = user.name || user.username || null;
        await sql`
          INSERT INTO safe_audits (
            id, store_pc, store_name, auditor_user_id, auditor_name, auditor_role, status, started_at,
            reason, safe_code, code_last_changed, store_manager_name, district, expected_petty_cash,
            has_receipts, receipts_total, receipt_photo_keys, bill_counts, coin_counts,
            bills_total, coins_total, counted_total, accounted_total, variance, variance_status,
            has_counterfeit, counterfeit_total, counterfeit_photo_keys,
            conductor_sig_key, manager_sig_key, manager_ack_name, notes, created_at, updated_at)
          VALUES (
            ${id}, ${storePC}, ${body.storeName ?? null}, ${user.sub ?? null}, ${name}, ${user.userType ?? null}, 'draft', now(),
            ${reason}, ${body.safeCode ?? null}, ${body.codeLastChanged ?? null}, ${body.storeManagerName ?? null}, ${num(body.district)}, ${expected},
            ${hasReceipts}, ${receiptsTotal}, ${JSON.stringify(receiptPhotoKeys)}::jsonb, ${JSON.stringify(billCounts)}::jsonb, ${JSON.stringify(coinCounts)}::jsonb,
            ${billsTotal}, ${coinsTotal}, ${countedTotal}, ${accountedTotal}, ${variance}, ${varianceStatus},
            ${hasCounterfeit}, ${counterfeitTotal}, ${JSON.stringify(counterfeitPhotoKeys)}::jsonb,
            ${body.conductorSigKey ?? null}, ${body.managerSigKey ?? null}, ${body.managerAckName ?? null}, ${body.notes ?? null}, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            store_pc = EXCLUDED.store_pc, store_name = EXCLUDED.store_name,
            reason = EXCLUDED.reason, safe_code = EXCLUDED.safe_code, code_last_changed = EXCLUDED.code_last_changed,
            store_manager_name = EXCLUDED.store_manager_name, district = EXCLUDED.district, expected_petty_cash = EXCLUDED.expected_petty_cash,
            has_receipts = EXCLUDED.has_receipts, receipts_total = EXCLUDED.receipts_total, receipt_photo_keys = EXCLUDED.receipt_photo_keys,
            bill_counts = EXCLUDED.bill_counts, coin_counts = EXCLUDED.coin_counts,
            bills_total = EXCLUDED.bills_total, coins_total = EXCLUDED.coins_total, counted_total = EXCLUDED.counted_total,
            accounted_total = EXCLUDED.accounted_total, variance = EXCLUDED.variance, variance_status = EXCLUDED.variance_status,
            has_counterfeit = EXCLUDED.has_counterfeit, counterfeit_total = EXCLUDED.counterfeit_total, counterfeit_photo_keys = EXCLUDED.counterfeit_photo_keys,
            conductor_sig_key = EXCLUDED.conductor_sig_key, manager_sig_key = EXCLUDED.manager_sig_key,
            manager_ack_name = EXCLUDED.manager_ack_name, notes = EXCLUDED.notes, updated_at = now()`;
        return json(200, { ok: true, id: Number(id) });
      }

      case 'submit': {
        if (!safeCanConduct(user.userType, grant)) return json(403, { ok: false, error: 'forbidden' });
        const id = toBigInt(body.id);
        if (id == null) return json(400, { ok: false, error: 'id required' });
        const rows = await sql`SELECT * FROM safe_audits WHERE id = ${id}`;
        if (!rows.length) return json(404, { ok: false, error: 'not found' });
        const row = rows[0];
        if (row.status !== 'draft') return json(409, { ok: false, error: 'audit already submitted' });
        const storePC = String(row.store_pc || '');
        if (!storeInScope(visibleStoresSafe(user), storePC)) return json(403, { ok: false, error: 'forbidden' });
        if (row.reason != null && !REASONS.includes(row.reason)) return json(400, { ok: false, error: 'invalid reason' });

        // Resolve the AUTHORITATIVE expected (A8): if a setting exists, use it (locked value).
        // Otherwise this is the store's first submit — seed safe_settings from the draft's entered
        // amount via ON CONFLICT DO NOTHING (race-safe), then re-read. Never trust client math.
        const name = user.name || user.username || null;
        const settingRows = await sql`SELECT expected_petty_cash FROM safe_settings WHERE store_pc = ${storePC}`;
        let expected;
        if (settingRows.length) {
          expected = num(settingRows[0].expected_petty_cash);
        } else {
          const seed = num(row.expected_petty_cash);
          if (seed == null) return json(400, { ok: false, error: 'expected petty cash required (first audit for this store)' });
          await sql`
            INSERT INTO safe_settings (store_pc, expected_petty_cash, set_by_user_id, set_by_name, set_at)
            VALUES (${storePC}, ${seed}, ${user.sub ?? null}, ${name}, now())
            ON CONFLICT (store_pc) DO NOTHING`;
          const reread = await sql`SELECT expected_petty_cash FROM safe_settings WHERE store_pc = ${storePC}`;
          expected = num(reread[0]?.expected_petty_cash);
        }

        // Recompute cash totals + variance SERVER-SIDE with the same lib.
        const { billsTotal, coinsTotal, countedTotal } = computeCashTotals(row.bill_counts || {}, row.coin_counts || {});
        const receiptsTotal = row.has_receipts ? (num(row.receipts_total) || 0) : 0;
        const { accountedTotal, variance, status: varianceStatus } = computeVariance({ countedTotal, receiptsTotal, expected });
        const hasCounterfeit = !!row.has_counterfeit;

        await sql`
          UPDATE safe_audits SET
            status = 'submitted', submitted_at = now(), expected_petty_cash = ${expected},
            bills_total = ${billsTotal}, coins_total = ${coinsTotal}, counted_total = ${countedTotal},
            accounted_total = ${accountedTotal}, variance = ${variance}, variance_status = ${varianceStatus},
            updated_at = now()
          WHERE id = ${id}`;
        const [updated] = await sql`SELECT * FROM safe_audits WHERE id = ${id}`;

        // A4 shortage/counterfeit notification — guarded behind shouldAlert(). Recipients: the
        // store's district DM(s) + all executive users. Sent inline (few recipients, well under 26s).
        let alerted = false;
        if (shouldAlert({ variance, hasCounterfeit })) {
          alerted = true;
          try {
            const district = DISTRICT_BY_PC.get(storePC) ?? (row.district != null ? Number(row.district) : null);
            const dms = district != null
              ? await sql`SELECT id, email FROM users WHERE user_type = 'dm' AND active = true AND district = ${district}`
              : [];
            const vps = await sql`SELECT id, email FROM users WHERE user_type = 'executive' AND active = true`;
            const recipients = [...dms, ...vps];
            const emails = [...new Set(recipients.map((u) => u.email).filter(Boolean))];
            const pushIds = [...new Set(recipients.map((u) => String(u.id)))];

            const storeLabel = row.store_name ? `${row.store_name} (${storePC})` : storePC;
            const flags = [];
            if (variance <= -5) flags.push(`shortage of ${fmtMoney(Math.abs(variance))}`);
            if (hasCounterfeit) flags.push(`counterfeit cash reported (${fmtMoney(row.counterfeit_total || 0)})`);
            const subject = `Safe Audit alert — ${storeLabel}: ${flags.join(' + ')}`;
            const html = `
              <h2 style="font-family:Arial">Safe Audit discrepancy — ${esc(storeLabel)}</h2>
              <p style="font-family:Arial;color:#555">A submitted safe audit requires attention:</p>
              <table style="border-collapse:collapse;font-family:Arial;font-size:13px">
                <tr><td style="padding:4px 10px"><b>Auditor</b></td><td style="padding:4px 10px">${esc(row.auditor_name || '')}</td></tr>
                <tr><td style="padding:4px 10px"><b>Expected</b></td><td style="padding:4px 10px">${esc(fmtMoney(expected))}</td></tr>
                <tr><td style="padding:4px 10px"><b>Accounted</b></td><td style="padding:4px 10px">${esc(fmtMoney(accountedTotal))}</td></tr>
                <tr><td style="padding:4px 10px"><b>Variance</b></td><td style="padding:4px 10px;color:${variance < 0 ? '#ef4444' : '#111'}">${esc(fmtMoney(variance))} (${esc(varianceStatus)})</td></tr>
                <tr><td style="padding:4px 10px"><b>Counterfeit</b></td><td style="padding:4px 10px">${hasCounterfeit ? esc(fmtMoney(row.counterfeit_total || 0)) : 'none'}</td></tr>
              </table>`;
            if (emails.length) {
              try { await sendEmail(emails, subject, html); }
              catch (e) { console.warn('[safe-audits] alert email failed:', e.message); }
            }
            if (pushIds.length) {
              try { await sendPush(pushIds, 'Safe Audit alert', `${storeLabel}: ${flags.join(' + ')}`, 'safe_audit_alert'); }
              catch (e) { console.warn('[safe-audits] alert push failed:', e.message); }
            }
          } catch (e) {
            // Notification failure must never fail the submit itself (row is already saved).
            console.warn('[safe-audits] alert dispatch failed:', e.message);
          }
        }

        return json(200, { ok: true, audit: rowToAudit(updated), alerted });
      }

      default:
        return json(400, { ok: false, error: 'unknown action' });
    }
  } catch (err) {
    console.error('safe-audits.mjs error:', err);
    return json(500, { ok: false, error: err.message });
  }
};
