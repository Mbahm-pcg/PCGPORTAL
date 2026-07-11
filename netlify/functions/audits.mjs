// audits.mjs — Field Operations Audit module API. Pattern: tickets.mjs.
//
// Tables (self-created via ensureTables(), documented in db/schema.ts):
//   audit_templates — versioned checklist templates (seeded with TEMPLATE_V1)
//   audits          — one row per store audit (draft → submitted → optionally unlocked back to draft)
//   audit_caps      — Corrective Action Plan rows, one per failed checklist item at submit time
//
// Actions (POST { action, ... } to /.netlify/functions/audits, auth via pcg_session
// cookie / Bearer — requireActiveUser same as other .mjs functions):
//   template  → { ok, template }
//   list      { storePC? } → { ok, audits:[…] }              role-scoped
//   get       { id } → { ok, audit, items, caps }             role-scoped
//   saveDraft { id?, storePC, results, notes, photos } → { ok, id }     CAN_AUDIT
//   submit    { id, lat, lng } → { ok, audit, capsCreated }    CAN_AUDIT
//   unlock    { id } → { ok }                                  CAN_UNLOCK
//   capUpdate { id, to, note?, photoKeys?, ownerUserId?, deadline? } → { ok, cap }
//   dashboard → { ok, latestByStore, trend, coverage, repeats, capBoard }  full/dm
import { neon } from '@neondatabase/serverless';
// Direct ESM named imports of these CommonJS libs — same pattern as tasks.mjs /
// portal-auth.mjs (`import { requireActiveUser } from './auth-lib/require-user.js'`).
// Node's CJS/ESM interop (cjs-module-lexer) resolves named imports from
// `module.exports = { ... }` just fine. createRequire(import.meta.url) was tried
// first per the task brief, but Netlify Dev's function bundler doesn't trace the
// dynamic `require()` call's target file into the deployed bundle (verified via
// `netlify dev` + curl — 500 "Cannot find module './auth-lib/require-user'"), so
// it only works locally with the source tree in place, not once bundled/deployed.
import { requireActiveUser } from './auth-lib/require-user.js';
import { TEMPLATE_V1, validateTemplate } from './audit-lib/template.js';
import { computeScore, bandFor } from './audit-lib/scoring.js';
import { canTransition, defaultDeadline, isOverdue } from './audit-lib/caps.js';

const cors = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });
let _sql = null; const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

const FULL_VIEW = new Set(['auditor', 'executive', 'it', 'office_staff']);
const CAN_AUDIT = new Set(['auditor', 'executive', 'it']); // exec/it can audit in a pinch
const CAN_UNLOCK = new Set(['executive', 'it']);

// pc → { district, mgr, email } for all 45 stores. Copied from app.jsx's
// STORES_SEED (search `const STORES_SEED`) rather than imported, because the
// frontend bundle isn't importable from a Netlify Function. See CLAUDE.md
// "Common Gotchas" #9 (duplicated store config, e.g. also in labor-cron.js,
// schedule-alerts.js, ndcp-lib/store-map.js) — keep this list in sync if
// stores/districts/managers change.
const AUDIT_STORES = [
  { pc: '339616', district: 1, mgr: 'Clarence Jackson', email: '339616@rgi.life' },
  { pc: '340794', district: 1, mgr: 'Siani Lopez', email: '340794@peoplecapitalgroup.com' },
  { pc: '351099', district: 2, mgr: 'Sefali Patel', email: '351099@rgi.life' },
  { pc: '351259', district: 2, mgr: null, email: '351259@rgi.life' },
  { pc: '302642', district: 2, mgr: 'Muska Mahboobi', email: '302642@rgi.life' },
  { pc: '352894', district: 2, mgr: 'MD Obaid', email: '352894@rgi.life' },
  { pc: '341350', district: 2, mgr: 'Sara Elhagar', email: '341350@peoplecapitalgroup.com' },
  { pc: '337839', district: 2, mgr: 'Kirtida Singh', email: '337839@peoplecapitalgroup.com' },
  { pc: '330338', district: 3, mgr: 'Satpal Kaur', email: '330338@rgi.life' },
  { pc: '337063', district: 3, mgr: 'Mosammat Akhtar', email: '337063@rgi.life' },
  { pc: '343832', district: 3, mgr: 'Mahfuja Tajrin', email: '343832@rgi.life' },
  { pc: '304669', district: 3, mgr: 'Ijaz Ali', email: '304669@rgi.life' },
  { pc: '355146', district: 3, mgr: 'Moslima Akhter', email: '355146@rgi.life' },
  { pc: '300496', district: 3, mgr: 'Mosammat Akter', email: '300496@rgi.life' },
  { pc: '304863', district: 3, mgr: 'Mahmuda Akter', email: '304863@peoplecapitalgroup.com' },
  { pc: '354561', district: 3, mgr: 'Thai Banh', email: '354561@peoplecapitalgroup.com' },
  { pc: '332393', district: 3, mgr: 'Rajiv Kumar', email: '332393@peoplecapitalgroup.com' },
  { pc: '341167', district: 4, mgr: 'Norberto Rodriguez', email: '341167@rgi.life' },
  { pc: '340870', district: 4, mgr: 'Paulina Sierra', email: '340870@rgi.life' },
  { pc: '335981', district: 4, mgr: 'Chris Brown', email: '335981@rgi.life' },
  { pc: '353150', district: 4, mgr: 'Edmonds Brandy', email: '353150@rgi.life' },
  { pc: '351050', district: 4, mgr: 'Torres Katiuska', email: '351050@rgi.life' },
  { pc: '345985', district: 4, mgr: 'Jessica Garcia', email: '345985@peoplecapitalgroup.com' },
  { pc: '356374', district: 5, mgr: 'Radha Rao', email: '356374@rgi.life' },
  { pc: '353843', district: 5, mgr: 'Syncere Myer', email: '353843@rgi.life' },
  { pc: '353047', district: 5, mgr: 'Joseph Allen', email: '353047@rgi.life' },
  { pc: '340538', district: 5, mgr: 'Vinit Patel', email: '340538@rgi.life' },
  { pc: '343079', district: 6, mgr: null, email: '343079@rgi.life' },
  { pc: '342144', district: 6, mgr: null, email: '342144@rgi.life' },
  { pc: '364295', district: 6, mgr: null, email: '364295@peoplecapitalgroup.com' },
  { pc: '365361', district: 7, mgr: 'Ashley DiNardo', email: '365361@poeplecapitalgroup.com' },
  { pc: '310382', district: 7, mgr: 'Safiya Eshag', email: '310382@rgi.life' },
  { pc: '332941', district: 7, mgr: 'Franyi Leiva', email: '332941@rgi.life' },
  { pc: '343497', district: 7, mgr: 'Olivia Lilley', email: '343497@rgi.life' },
  { pc: '302446', district: 7, mgr: 'Nurani Chowdhury', email: '302446@peoplecapitalgroup.com' },
  { pc: '337079', district: 7, mgr: 'Andrea Robison', email: '337079@rgi.life' },
  { pc: '345986', district: 7, mgr: null, email: '345986@rgi.life' },
  { pc: '364412', district: 7, mgr: 'Tejal Soni', email: '364412@peoplecapitalgroup.com' },
  { pc: '345489', district: 7, mgr: 'Iqbal Komal', email: '345489@peoplecapitalgroup.com' },
  { pc: '336372', district: 7, mgr: 'Dilara Begum', email: '336372@rgi.life' },
  { pc: '358933', district: 8, mgr: 'Nitin Patel', email: '358933@peoplecapitalgroup.com' },
  { pc: '354865', district: 8, mgr: 'Kenny / Robin Fontano', email: '354865@rgi.life' },
  { pc: '353689', district: 8, mgr: 'Kenny (Kintan) Patel', email: '353689@rgi.life' },
  { pc: '342184', district: 8, mgr: 'Cheri Patel', email: '342184@rgi.life' },
  { pc: '356316', district: 8, mgr: 'Perry Patel', email: '356316@rgi.life' },
];

// itemId → text, flattened from TEMPLATE_V1 (Task 8: the `dashboard` action's
// chronic/systemic repeat-finding aggregates only had item ids on hand — the
// `results` JSONB blob stored per audit doesn't carry item text — so the
// leadership dashboard's repeat-finding lists couldn't label what was actually
// failing. Built once at module load since TEMPLATE_V1 is a static import.
const ITEM_TEXT_BY_ID = new Map();
for (const sec of TEMPLATE_V1.sections || []) {
  for (const it of sec.items || []) ITEM_TEXT_BY_ID.set(it.id, it.text);
}

let _ready = false;
async function ensureTables() {
  if (_ready) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS audit_templates (
    id          serial PRIMARY KEY,
    version     int NOT NULL,
    name        text NOT NULL,
    type        text,
    sections    jsonb NOT NULL,
    active      boolean NOT NULL DEFAULT true,
    created_at  timestamptz DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS audits (
    id                  bigint PRIMARY KEY, -- client Date.now(), same convention as maint_tickets
    template_id         int,
    store_pc            text NOT NULL,
    auditor_user_id      int,
    auditor_name        text,
    status              text NOT NULL DEFAULT 'draft', -- draft | submitted
    started_at          timestamptz,
    submitted_at        timestamptz,
    submit_lat          real,
    submit_lng          real,
    score                real,
    section_scores       jsonb,
    capped_by_critical   boolean NOT NULL DEFAULT false,
    results              jsonb NOT NULL DEFAULT '{}'::jsonb,
    notes                text,
    unlocked_by          text,
    unlocked_at          timestamptz,
    created_at           timestamptz DEFAULT now(),
    updated_at           timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audits_store ON audits(store_pc)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audits_status ON audits(status)`;
  await sql`CREATE TABLE IF NOT EXISTS audit_caps (
    id                 text PRIMARY KEY, -- 'cap_<auditId>_<itemId>' — idempotent on submit retry
    audit_id           bigint NOT NULL,
    template_item_id   text NOT NULL,
    item_text          text,
    section_id         text,
    severity           text,
    store_pc           text,
    owner_user_id       int,
    owner_name         text,
    deadline           timestamptz,
    status             text NOT NULL DEFAULT 'open', -- open | owner_resolved | verified_closed | overdue
    owner_note         text,
    owner_photo_keys    jsonb NOT NULL DEFAULT '[]'::jsonb,
    resolved_at         timestamptz,
    verified_by         text,
    verified_at         timestamptz,
    escalated_at        timestamptz,
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_caps_store ON audit_caps(store_pc)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_caps_audit ON audit_caps(audit_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_caps_status ON audit_caps(status)`;

  // Seed the active template on first run (empty table only — never overwrites).
  const [{ c }] = await sql`SELECT count(*)::int AS c FROM audit_templates`;
  if (c === 0) {
    const errs = validateTemplate(TEMPLATE_V1);
    if (errs.length) console.warn('[audits] TEMPLATE_V1 validation warnings:', errs.join('; '));
    await sql`INSERT INTO audit_templates (version, name, type, sections, active)
      VALUES (${TEMPLATE_V1.version}, ${TEMPLATE_V1.name}, ${TEMPLATE_V1.type}, ${JSON.stringify(TEMPLATE_V1.sections)}::jsonb, true)`;
  }
  _ready = true;
}

// Role-scoped store visibility: returns { storePCs:[..] } | 'all' | 'none'.
function visibleStores(user) {
  if (FULL_VIEW.has(user.userType)) return 'all';
  if (user.userType === 'dm') {
    const storePCs = AUDIT_STORES.filter((s) => String(s.district) === String(user.district)).map((s) => s.pc);
    return { storePCs };
  }
  if (user.userType === 'manager') return { storePCs: [String(user.storePC || '')] };
  return 'none';
}

function storeInScope(scope, storePc) {
  if (scope === 'all') return true;
  if (scope === 'none') return false;
  return scope.storePCs.includes(String(storePc));
}

const toBigInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const ts = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

async function activeTemplateRow(sql) {
  const rows = await sql`SELECT * FROM audit_templates WHERE active = true ORDER BY id DESC LIMIT 1`;
  if (rows.length) return rows[0];
  // Defensive fallback — ensureTables() should always have seeded one.
  return { id: null, version: TEMPLATE_V1.version, name: TEMPLATE_V1.name, type: TEMPLATE_V1.type, sections: TEMPLATE_V1.sections };
}

function rowToListItem(r) {
  return {
    id: Number(r.id),
    storePC: r.store_pc,
    auditorName: r.auditor_name ?? undefined,
    status: r.status,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : undefined,
    score: r.score ?? undefined,
    band: r.score != null ? bandFor(r.score) : undefined,
    cappedByCritical: !!r.capped_by_critical,
  };
}

function rowToAudit(r) {
  return {
    id: Number(r.id),
    templateId: r.template_id ?? undefined,
    storePC: r.store_pc,
    auditorUserId: r.auditor_user_id ?? undefined,
    auditorName: r.auditor_name ?? undefined,
    status: r.status,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : undefined,
    submitLat: r.submit_lat ?? undefined,
    submitLng: r.submit_lng ?? undefined,
    score: r.score ?? undefined,
    band: r.score != null ? bandFor(r.score) : undefined,
    sectionScores: r.section_scores || undefined,
    cappedByCritical: !!r.capped_by_critical,
    results: r.results || {},
    notes: r.notes ?? undefined,
    unlockedBy: r.unlocked_by ?? undefined,
    unlockedAt: r.unlocked_at ? new Date(r.unlocked_at).toISOString() : undefined,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
  };
}

function rowToCap(r, nowMs = Date.now()) {
  const cap = {
    id: r.id,
    auditId: Number(r.audit_id),
    templateItemId: r.template_item_id,
    itemText: r.item_text ?? undefined,
    sectionId: r.section_id ?? undefined,
    severity: r.severity ?? undefined,
    storePC: r.store_pc ?? undefined,
    ownerUserId: r.owner_user_id ?? undefined,
    ownerName: r.owner_name ?? undefined,
    deadline: r.deadline ? new Date(r.deadline).toISOString() : undefined,
    status: r.status,
    ownerNote: r.owner_note ?? undefined,
    ownerPhotoKeys: r.owner_photo_keys || [],
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : undefined,
    verifiedBy: r.verified_by ?? undefined,
    verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : undefined,
    escalatedAt: r.escalated_at ? new Date(r.escalated_at).toISOString() : undefined,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
  };
  cap.isOverdue = isOverdue({ status: cap.status, deadline: cap.deadline }, nowMs);
  return cap;
}

// Map the audit's stored jsonb results ({ [itemId]: { result, severity?, note?,
// photoKeys? } } plus a reserved `_photos` key for audit-level photos, see
// saveDraft) down to the plain { [itemId]: 'pass'|'fail'|'na' } shape scoring.js
// expects. Non-item keys (like `_photos`) are naturally skipped since they
// don't have a `.result` field and aren't in the template's item id set.
function resultsForScoring(results) {
  const out = {};
  for (const [itemId, v] of Object.entries(results || {})) {
    if (v && typeof v === 'object' && typeof v.result === 'string') out[itemId] = v.result;
  }
  return out;
}

export default async (req) => {
  // 204 must have a null body (not '') — an empty string still counts as "a body" to
  // Node's Response validation and throws for null-body statuses (204/205/304).
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'POST only' });

  try {
    // ensureTables/requireActiveUser live inside the try too (unlike the task-brief
    // skeleton, which left them outside): a DB hiccup here must still come back as a
    // clean { ok:false } JSON error, not an unhandled-exception 500 with a raw stack
    // trace — verified by smoke test against a deliberately-broken NEON_DATABASE_URL.
    const sql = db();
    await ensureTables();
    const event = { headers: Object.fromEntries(req.headers.entries()) };
    const user = await requireActiveUser(event, sql);
    if (!user) return json(401, { ok: false, error: 'auth required' });
    const body = await req.json().catch(() => ({}));

    switch (body.action) {
      case 'template': {
        const tpl = await activeTemplateRow(sql);
        return json(200, { ok: true, template: { id: tpl.id, version: tpl.version, name: tpl.name, type: tpl.type, sections: tpl.sections } });
      }

      case 'list': {
        const scope = visibleStores(user);
        if (scope === 'none') return json(200, { ok: true, audits: [] });
        const storePC = body.storePC != null ? String(body.storePC) : null;
        let rows;
        if (scope === 'all') {
          rows = storePC
            ? await sql`SELECT * FROM audits WHERE store_pc = ${storePC} ORDER BY created_at DESC`
            : await sql`SELECT * FROM audits ORDER BY created_at DESC`;
        } else {
          const pcs = storePC ? scope.storePCs.filter((p) => p === storePC) : scope.storePCs;
          rows = pcs.length ? await sql`SELECT * FROM audits WHERE store_pc = ANY(${pcs}) ORDER BY created_at DESC` : [];
        }
        return json(200, { ok: true, audits: rows.map(rowToListItem) });
      }

      case 'get': {
        const id = toBigInt(body.id);
        if (id == null) return json(400, { ok: false, error: 'id required' });
        const rows = await sql`SELECT * FROM audits WHERE id = ${id}`;
        if (!rows.length) return json(404, { ok: false, error: 'not found' });
        const row = rows[0];
        const scope = visibleStores(user);
        if (!storeInScope(scope, row.store_pc)) return json(403, { ok: false, error: 'forbidden' });

        const tplRow = row.template_id ? (await sql`SELECT * FROM audit_templates WHERE id = ${row.template_id}`)[0] : null;
        const sections = tplRow?.sections || TEMPLATE_V1.sections;
        const results = row.results || {};
        const items = sections.flatMap((s) => s.items.map((i) => ({
          id: i.id,
          sectionId: s.id,
          sectionName: s.name,
          text: i.text,
          points: i.points,
          critical: i.critical,
          guidance: i.guidance,
          result: results[i.id]?.result ?? null,
          severity: results[i.id]?.severity ?? null,
          note: results[i.id]?.note ?? null,
          photoKeys: results[i.id]?.photoKeys || [],
        })));
        const capRows = await sql`SELECT * FROM audit_caps WHERE audit_id = ${id} ORDER BY created_at ASC`;
        return json(200, { ok: true, audit: rowToAudit(row), items, caps: capRows.map((r) => rowToCap(r)) });
      }

      case 'saveDraft': {
        if (!CAN_AUDIT.has(user.userType)) return json(403, { ok: false, error: 'forbidden' });
        const storePC = String(body.storePC || '');
        if (!storePC) return json(400, { ok: false, error: 'storePC required' });
        const id = body.id != null ? toBigInt(body.id) : Date.now();
        if (id == null) return json(400, { ok: false, error: 'invalid id' });

        const existing = await sql`SELECT status FROM audits WHERE id = ${id}`;
        if (existing.length && existing[0].status !== 'draft') {
          return json(409, { ok: false, error: 'audit is locked (already submitted)' });
        }

        // `results` is { [itemId]: { result, severity?, note?, photoKeys? } }. `photos`
        // (audit-level, not tied to one item) is stashed under a reserved `_photos` key
        // in the same jsonb column — there's no dedicated table column for it, and
        // scoring/CAP creation only ever look at keys that carry a `.result` string, so
        // this reserved key is transparently ignored everywhere else.
        const results = (body.results && typeof body.results === 'object') ? { ...body.results } : {};
        if (Array.isArray(body.photos) && body.photos.length) results._photos = body.photos;
        const notes = body.notes ?? null;
        const tpl = await activeTemplateRow(sql);

        await sql`
          INSERT INTO audits (id, template_id, store_pc, auditor_user_id, auditor_name, status, started_at, results, notes, created_at, updated_at)
          VALUES (${id}, ${tpl.id}, ${storePC}, ${user.sub ?? null}, ${user.name || user.username || null}, 'draft', now(),
                  ${JSON.stringify(results)}::jsonb, ${notes}, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            store_pc = EXCLUDED.store_pc, results = EXCLUDED.results, notes = EXCLUDED.notes, updated_at = now()`;
        return json(200, { ok: true, id });
      }

      case 'submit': {
        if (!CAN_AUDIT.has(user.userType)) return json(403, { ok: false, error: 'forbidden' });
        const id = toBigInt(body.id);
        if (id == null) return json(400, { ok: false, error: 'id required' });
        const rows = await sql`SELECT * FROM audits WHERE id = ${id}`;
        if (!rows.length) return json(404, { ok: false, error: 'not found' });
        const row = rows[0];
        if (row.status !== 'draft') return json(409, { ok: false, error: 'audit already submitted' });

        const tplRow = row.template_id ? (await sql`SELECT * FROM audit_templates WHERE id = ${row.template_id}`)[0] : null;
        const template = { sections: tplRow?.sections || TEMPLATE_V1.sections };
        const results = row.results || {};
        const scoreResults = resultsForScoring(results);
        const { score, sectionScores, cappedByCritical } = computeScore(template, scoreResults);

        // Resolve the store manager as default CAP owner, if one is on file.
        const manager = await sql`SELECT id, name FROM users WHERE store_pc = ${row.store_pc} AND user_type = 'manager' AND active = true LIMIT 1`;
        const ownerUserId = manager.length ? manager[0].id : null;
        const ownerName = manager.length ? manager[0].name : null;

        const nowMs = Date.now();
        const capStmts = [];
        for (const section of template.sections) {
          for (const item of section.items) {
            const r = scoreResults[item.id] || 'fail'; // unanswered = fail, same as scoring.js
            if (r !== 'fail') continue;
            const capId = `cap_${id}_${item.id}`;
            const severity = results[item.id]?.severity || (item.critical ? 'critical' : 'high');
            const deadline = defaultDeadline(severity, nowMs);
            // ON CONFLICT DO NOTHING → idempotent if submit is retried (e.g. client
            // timeout + resend): a CAP already in progress is never reset.
            capStmts.push(sql`
              INSERT INTO audit_caps (id, audit_id, template_item_id, item_text, section_id, severity, store_pc, owner_user_id, owner_name, deadline, status, created_at, updated_at)
              VALUES (${capId}, ${id}, ${item.id}, ${item.text}, ${section.id}, ${severity}, ${row.store_pc}, ${ownerUserId}, ${ownerName}, ${deadline}, 'open', now(), now())
              ON CONFLICT (id) DO NOTHING`);
          }
        }

        const lat = num(body.lat);
        const lng = num(body.lng);
        const updateStmt = sql`
          UPDATE audits SET status = 'submitted', submitted_at = now(), submit_lat = ${lat}, submit_lng = ${lng},
            score = ${score}, section_scores = ${JSON.stringify(sectionScores)}::jsonb, capped_by_critical = ${cappedByCritical},
            updated_at = now()
          WHERE id = ${id}`;

        if (capStmts.length) await sql.transaction([updateStmt, ...capStmts]);
        else await updateStmt;

        const [updated] = await sql`SELECT * FROM audits WHERE id = ${id}`;
        return json(200, { ok: true, audit: rowToAudit(updated), capsCreated: capStmts.length });
      }

      case 'unlock': {
        if (!CAN_UNLOCK.has(user.userType)) return json(403, { ok: false, error: 'forbidden' });
        const id = toBigInt(body.id);
        if (id == null) return json(400, { ok: false, error: 'id required' });
        const rows = await sql`SELECT id, store_pc FROM audits WHERE id = ${id}`;
        if (!rows.length) return json(404, { ok: false, error: 'not found' });
        await sql`UPDATE audits SET status = 'draft', unlocked_by = ${user.name || user.username || null}, unlocked_at = now(), updated_at = now() WHERE id = ${id}`;
        // Record the unlock in audit_log (see analyst-audit.mjs logAudit for the
        // precedent) — logging failure must never fail the unlock itself.
        try {
          await sql`
            INSERT INTO audit_log (type, user_id, user_role, action, metadata)
            VALUES ('audit_unlock', ${user.sub ?? null}, ${user.userType ?? null}, 'audit_unlock',
                    ${JSON.stringify({ auditId: String(id), storePC: rows[0].store_pc })}::jsonb)
          `;
        } catch (e) { console.warn('audit_log insert (unlock) failed:', e.message); }
        return json(200, { ok: true });
      }

      case 'capUpdate': {
        const id = body.id != null ? String(body.id) : null;
        const to = body.to;
        if (!id || !to) return json(400, { ok: false, error: 'id and to required' });
        const rows = await sql`SELECT * FROM audit_caps WHERE id = ${id}`;
        if (!rows.length) return json(404, { ok: false, error: 'not found' });
        const cap = rows[0];

        const scope = visibleStores(user);
        if (!storeInScope(scope, cap.store_pc)) return json(403, { ok: false, error: 'forbidden' });

        const isOwner = cap.owner_user_id != null && user.sub != null && String(cap.owner_user_id) === String(user.sub);
        const isMetaOnly = to === cap.status; // e.g. an owner/deadline reassignment with no status change
        if (isMetaOnly) {
          if (!CAN_AUDIT.has(user.userType)) return json(403, { ok: false, error: 'forbidden' });
        } else if (!canTransition(user.userType, isOwner, cap.status, to)) {
          return json(403, { ok: false, error: 'transition not allowed' });
        }

        // Owner/deadline reassignment is auditor/executive/it only, per the brief,
        // regardless of whether this call is also doing a status transition.
        const wantsOwnerOrDeadlineEdit = body.ownerUserId !== undefined || body.deadline !== undefined;
        if (wantsOwnerOrDeadlineEdit && !CAN_AUDIT.has(user.userType)) {
          return json(403, { ok: false, error: 'forbidden' });
        }

        const nowIso = new Date().toISOString();
        const nextOwnerUserId = body.ownerUserId !== undefined ? (body.ownerUserId != null ? toBigInt(body.ownerUserId) : null) : cap.owner_user_id;
        const nextDeadline = body.deadline !== undefined ? ts(body.deadline) : cap.deadline;
        const note = body.note ?? null;
        const photoKeys = Array.isArray(body.photoKeys) ? body.photoKeys : null;

        let nextStatus = cap.status;
        let ownerNote = cap.owner_note;
        let ownerPhotoKeys = cap.owner_photo_keys || [];
        let resolvedAt = cap.resolved_at;
        let verifiedBy = cap.verified_by;
        let verifiedAt = cap.verified_at;

        if (!isMetaOnly) {
          nextStatus = to;
          if (to === 'owner_resolved') {
            ownerNote = note ?? ownerNote;
            if (photoKeys) ownerPhotoKeys = photoKeys;
            resolvedAt = nowIso;
          } else if (to === 'verified_closed') {
            verifiedBy = user.name || user.username || null;
            verifiedAt = nowIso;
          } else if (to === 'open') {
            // Verifier rejected the owner's fix — reopen and record why via note.
            ownerNote = note ?? ownerNote;
            resolvedAt = null;
          }
        }

        await sql`
          UPDATE audit_caps SET
            status = ${nextStatus}, owner_note = ${ownerNote}, owner_photo_keys = ${JSON.stringify(ownerPhotoKeys)}::jsonb,
            resolved_at = ${resolvedAt}, verified_by = ${verifiedBy}, verified_at = ${verifiedAt},
            owner_user_id = ${nextOwnerUserId}, deadline = ${nextDeadline}, updated_at = now()
          WHERE id = ${id}`;
        const [updated] = await sql`SELECT * FROM audit_caps WHERE id = ${id}`;
        return json(200, { ok: true, cap: rowToCap(updated) });
      }

      case 'dashboard': {
        const isFull = FULL_VIEW.has(user.userType);
        const isDm = user.userType === 'dm';
        if (!isFull && !isDm) return json(403, { ok: false, error: 'forbidden' });
        const pcs = isFull
          ? AUDIT_STORES.map((s) => s.pc)
          : AUDIT_STORES.filter((s) => String(s.district) === String(user.district)).map((s) => s.pc);
        if (!pcs.length) return json(200, { ok: true, latestByStore: {}, trend: [], portfolioTrend: null, coverage: { totalStores: 0, auditedStores: 0, pct: 0, missing: [] }, repeats: { chronic: {}, systemic: [] }, capBoard: [], capSummary: { total: 0, open: 0, overdue: 0, byOwner: [], avgDaysToClose: null } });

        // latestByStore — most recent submitted audit per store.
        const latestRows = await sql`
          SELECT DISTINCT ON (store_pc) store_pc, id, auditor_name, submitted_at, score, capped_by_critical
          FROM audits WHERE store_pc = ANY(${pcs}) AND status = 'submitted'
          ORDER BY store_pc, submitted_at DESC`;
        const latestByStore = {};
        for (const r of latestRows) {
          latestByStore[r.store_pc] = {
            id: Number(r.id), auditorName: r.auditor_name ?? undefined,
            submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : undefined,
            score: r.score ?? undefined, band: r.score != null ? bandFor(r.score) : undefined,
            cappedByCritical: !!r.capped_by_critical,
          };
        }

        // trend — monthly average score, trailing 6 months, + a by-district
        // breakdown. `district` isn't a column on `audits` (only AUDIT_STORES
        // knows it), so this pulls raw rows and aggregates in JS rather than a
        // SQL GROUP BY — same reasoning as the chronic/systemic aggregation below.
        const pcToDistrict = new Map(AUDIT_STORES.map((s) => [s.pc, s.district]));
        const trendRawRows = await sql`
          SELECT store_pc, submitted_at, score FROM audits
          WHERE store_pc = ANY(${pcs}) AND status = 'submitted' AND submitted_at > now() - interval '6 months' AND score IS NOT NULL`;
        const trendByMonth = new Map(); // month -> { sum, n, byDistrict: Map<district, {sum,n}> }
        for (const r of trendRawRows) {
          const month = new Date(r.submitted_at).toISOString().slice(0, 7);
          if (!trendByMonth.has(month)) trendByMonth.set(month, { sum: 0, n: 0, byDistrict: new Map() });
          const m = trendByMonth.get(month);
          m.sum += Number(r.score); m.n += 1;
          const d = pcToDistrict.get(r.store_pc);
          if (d != null) {
            if (!m.byDistrict.has(d)) m.byDistrict.set(d, { sum: 0, n: 0 });
            const dm2 = m.byDistrict.get(d);
            dm2.sum += Number(r.score); dm2.n += 1;
          }
        }
        const trend = [...trendByMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, v]) => ({
          month, avgScore: Math.round((v.sum / v.n) * 10) / 10, count: v.n,
          byDistrict: Object.fromEntries([...v.byDistrict.entries()].map(([d, x]) => [d, Math.round((x.sum / x.n) * 10) / 10])),
        }));

        // portfolioTrend — network-wide monthly average, computed over ALL stores
        // regardless of the dm district filter, only when needed: a dm's own
        // `trend` above is already scoped to their district, so their Trend panel
        // needs a separate portfolio-average benchmark line (brief: "trend shows
        // their district + portfolio average"). A blended network number isn't a
        // cross-district comparison or a manager ranking, so it doesn't violate
        // the dm scoping rule. Full-view roles already get the whole network in
        // `trend`, so this is left null for them (frontend just reuses `trend`).
        let portfolioTrend = null;
        if (isDm) {
          const allPcs = AUDIT_STORES.map((s) => s.pc);
          const portRows = await sql`
            SELECT to_char(date_trunc('month', submitted_at), 'YYYY-MM') AS month,
                   avg(score)::numeric(10,1) AS avg_score, count(*)::int AS n
            FROM audits WHERE store_pc = ANY(${allPcs}) AND status = 'submitted' AND submitted_at > now() - interval '6 months' AND score IS NOT NULL
            GROUP BY 1 ORDER BY 1`;
          portfolioTrend = portRows.map((r) => ({ month: r.month, avgScore: r.avg_score != null ? Number(r.avg_score) : null, count: r.n }));
        }

        // coverage — how many of the visible stores have a submitted audit in the trailing 90 days.
        const covRows = await sql`
          SELECT DISTINCT store_pc FROM audits
          WHERE store_pc = ANY(${pcs}) AND status = 'submitted' AND submitted_at > now() - interval '90 days'`;
        const auditedSet = new Set(covRows.map((r) => r.store_pc));
        const coverage = {
          totalStores: pcs.length,
          auditedStores: auditedSet.size,
          pct: pcs.length ? Math.round((auditedSet.size / pcs.length) * 1000) / 10 : 0,
          missing: pcs.filter((p) => !auditedSet.has(p)),
        };

        // repeats — chronic (item failed ≥2 of a store's last 3 submitted audits) and
        // systemic (item failed at ≥5 distinct stores within the trailing 60 days).
        // Done in JS per the brief's note — 45 stores is small enough that this is
        // simpler and clearer than a window-function/lateral-join query.
        const recentRows = await sql`
          SELECT store_pc, id, submitted_at, results,
                 ROW_NUMBER() OVER (PARTITION BY store_pc ORDER BY submitted_at DESC) AS rn
          FROM audits WHERE store_pc = ANY(${pcs}) AND status = 'submitted'`;
        const last3ByStore = new Map();
        for (const r of recentRows) {
          if (r.rn > 3) continue;
          if (!last3ByStore.has(r.store_pc)) last3ByStore.set(r.store_pc, []);
          last3ByStore.get(r.store_pc).push(r);
        }
        const chronic = {};
        for (const [pc, storeRows] of last3ByStore) {
          const failCount = {};
          for (const row of storeRows) {
            for (const [itemId, v] of Object.entries(row.results || {})) {
              if (itemId === '_photos') continue;
              if (v && v.result === 'fail') failCount[itemId] = (failCount[itemId] || 0) + 1;
            }
          }
          const chronicItems = Object.entries(failCount).filter(([, n]) => n >= 2)
            .map(([itemId, n]) => ({ itemId, itemText: ITEM_TEXT_BY_ID.get(itemId) || itemId, failCount: n }));
          if (chronicItems.length) chronic[pc] = chronicItems;
        }

        const sixtyDayRows = await sql`
          SELECT store_pc, results FROM audits
          WHERE store_pc = ANY(${pcs}) AND status = 'submitted' AND submitted_at > now() - interval '60 days'`;
        const storesByItem = new Map();
        for (const row of sixtyDayRows) {
          for (const [itemId, v] of Object.entries(row.results || {})) {
            if (itemId === '_photos') continue;
            if (v && v.result === 'fail') {
              if (!storesByItem.has(itemId)) storesByItem.set(itemId, new Set());
              storesByItem.get(itemId).add(row.store_pc);
            }
          }
        }
        const systemic = [...storesByItem.entries()]
          .filter(([, set]) => set.size >= 5)
          .map(([itemId, set]) => ({ itemId, itemText: ITEM_TEXT_BY_ID.get(itemId) || itemId, storeCount: set.size }));

        // capBoard — open CAP work across the visible scope. Kept as a flat array
        // (the existing CAP Board view already consumes it that way — see
        // `CapBoard` in app.jsx). capSummary is additive: the aggregates the
        // leadership dashboard's CAP panel needs (open/overdue counts, top
        // owners, avg time-to-close) that a flat list of open/in-progress CAPs
        // can't answer on its own — avgDaysToClose in particular needs
        // verified_closed rows, which are deliberately excluded from capBoard.
        const capRows = await sql`
          SELECT * FROM audit_caps WHERE store_pc = ANY(${pcs}) AND status IN ('open', 'owner_resolved', 'overdue')
          ORDER BY deadline ASC NULLS LAST`;
        const capBoard = capRows.map((r) => rowToCap(r));

        const overdueCount = capBoard.filter((c) => c.isOverdue).length;
        const openCount = capBoard.length - overdueCount;
        const ownerCounts = new Map();
        for (const c of capBoard) {
          const key = c.ownerName || 'Unassigned';
          ownerCounts.set(key, (ownerCounts.get(key) || 0) + 1);
        }
        const byOwner = [...ownerCounts.entries()].map(([ownerName, openCaps]) => ({ ownerName, openCaps }))
          .sort((a, b) => b.openCaps - a.openCaps).slice(0, 10);

        const closedRows = await sql`
          SELECT created_at, verified_at FROM audit_caps
          WHERE store_pc = ANY(${pcs}) AND status = 'verified_closed' AND verified_at IS NOT NULL AND created_at IS NOT NULL`;
        let avgDaysToClose = null;
        if (closedRows.length) {
          const totalDays = closedRows.reduce((sum, r) => sum + (new Date(r.verified_at) - new Date(r.created_at)) / 86400000, 0);
          avgDaysToClose = Math.round((totalDays / closedRows.length) * 10) / 10;
        }
        const capSummary = { total: capBoard.length, open: openCount, overdue: overdueCount, byOwner, avgDaysToClose };

        return json(200, { ok: true, latestByStore, trend, portfolioTrend, coverage, repeats: { chronic, systemic }, capBoard, capSummary });
      }

      default:
        return json(400, { ok: false, error: 'unknown action' });
    }
  } catch (err) {
    console.error('audits.mjs error:', err);
    return json(500, { ok: false, error: err.message });
  }
};
