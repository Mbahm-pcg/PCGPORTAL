// incident-reports.mjs — Workplace Incident Reports, backed by Neon Postgres.
// Insert-only: no update/delete action. prepared_by_user_id/prepared_by_name/
// report_date are always stamped server-side from the session on create —
// client-supplied values for those three fields are ignored, so "Report
// Prepared By" can never be spoofed to someone else's name.
import { neon } from '@neondatabase/serverless';
import { requireActiveUser } from './auth-lib/require-user.js';
import { canViewReport, filterVisibleReports } from '../../src/incident-report.mjs';

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
  await sql`CREATE TABLE IF NOT EXISTS incident_reports (
    id                  bigint PRIMARY KEY,
    report_date         text,
    prepared_by_user_id text NOT NULL,
    prepared_by_name    text NOT NULL,
    incident_date       text,
    incident_time       text,
    employee_name       text,
    employee_dob        text,
    employee_status     text,
    employee_address    text,
    employee_phone      text,
    employee_email      text,
    store_pc            text,
    store_name          text,
    address             text,
    operating_entity    text,
    incident_type       text,
    wc_claim            text,
    reported_injury     text,
    incident_summary    text,
    people              jsonb NOT NULL DEFAULT '[]'::jsonb,
    evidence            jsonb NOT NULL DEFAULT '[]'::jsonb,
    attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,
    meta                jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_incident_reports_prepared_by ON incident_reports(prepared_by_user_id)`;
  // Migrate a preview deploy's table (created before wc_carrier/wc_claim_number were
  // merged into one wc_claim field, and before the Subject Employee fields existed) —
  // no real report data exists yet, so this is a straight column add/swap, not a
  // data-preserving migration.
  await sql`ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS wc_claim text`;
  await sql`ALTER TABLE incident_reports DROP COLUMN IF EXISTS wc_carrier`;
  await sql`ALTER TABLE incident_reports DROP COLUMN IF EXISTS wc_claim_number`;
  await sql`ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS employee_name text`;
  await sql`ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS employee_dob text`;
  await sql`ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS employee_status text`;
  await sql`ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS employee_address text`;
  await sql`ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS employee_phone text`;
  await sql`ALTER TABLE incident_reports ADD COLUMN IF NOT EXISTS employee_email text`;
  _ready = true;
}

const toBigInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };

const KNOWN = new Set([
  'id', 'reportDate', 'preparedByUserId', 'preparedByName', 'incidentDate', 'incidentTime',
  'employeeName', 'employeeDob', 'employeeStatus', 'employeeAddress', 'employeePhone', 'employeeEmail',
  'storePC', 'storeName', 'address', 'operatingEntity', 'incidentType', 'wcClaim',
  'reportedInjury', 'incidentSummary', 'people', 'evidence', 'attachments', 'createdAt',
]);

function rowToReport(r) {
  return {
    ...(r.meta || {}),
    id: Number(r.id),
    reportDate: r.report_date ?? undefined,
    preparedByUserId: r.prepared_by_user_id ?? undefined,
    preparedByName: r.prepared_by_name ?? undefined,
    incidentDate: r.incident_date ?? undefined,
    incidentTime: r.incident_time ?? undefined,
    employeeName: r.employee_name ?? undefined,
    employeeDob: r.employee_dob ?? undefined,
    employeeStatus: r.employee_status ?? undefined,
    employeeAddress: r.employee_address ?? undefined,
    employeePhone: r.employee_phone ?? undefined,
    employeeEmail: r.employee_email ?? undefined,
    storePC: r.store_pc ?? undefined,
    storeName: r.store_name ?? undefined,
    address: r.address ?? undefined,
    operatingEntity: r.operating_entity ?? undefined,
    incidentType: r.incident_type ?? undefined,
    wcClaim: r.wc_claim ?? undefined,
    reportedInjury: r.reported_injury ?? undefined,
    incidentSummary: r.incident_summary ?? undefined,
    people: r.people || [],
    evidence: r.evidence || [],
    attachments: r.attachments || [],
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
  };
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
    const sql = db();
    const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql);
    if (!caller) return json(401, { error: 'Sign in required.' });

    if (action === 'create') {
      const t = payload.report || {};
      const id = toBigInt(t.id) ?? Date.now();
      const meta = {};
      for (const k of Object.keys(t)) if (!KNOWN.has(k)) meta[k] = t[k];
      await sql`
        INSERT INTO incident_reports (
          id, report_date, prepared_by_user_id, prepared_by_name, incident_date, incident_time,
          employee_name, employee_dob, employee_status, employee_address, employee_phone, employee_email,
          store_pc, store_name, address, operating_entity, incident_type, wc_claim,
          reported_injury, incident_summary, people, evidence, attachments, meta
        ) VALUES (
          ${id}, ${new Date().toISOString().slice(0, 10)}, ${String(caller.sub)}, ${caller.name || caller.username || 'Unknown'},
          ${t.incidentDate ?? null}, ${t.incidentTime ?? null},
          ${t.employeeName ?? null}, ${t.employeeDob ?? null}, ${t.employeeStatus ?? null},
          ${t.employeeAddress ?? null}, ${t.employeePhone ?? null}, ${t.employeeEmail ?? null},
          ${t.storePC ?? null}, ${t.storeName ?? null}, ${t.address ?? null}, ${t.operatingEntity ?? null},
          ${t.incidentType ?? null}, ${t.wcClaim ?? null},
          ${t.reportedInjury ?? null}, ${t.incidentSummary ?? null},
          ${JSON.stringify(t.people || [])}::jsonb, ${JSON.stringify(t.evidence || [])}::jsonb,
          ${JSON.stringify(t.attachments || [])}::jsonb, ${JSON.stringify(meta)}::jsonb
        )`;
      return json(200, { ok: true, id });
    }

    if (action === 'list') {
      const rows = await sql`SELECT * FROM incident_reports ORDER BY created_at DESC`;
      const all = rows.map(rowToReport);
      return json(200, { ok: true, reports: filterVisibleReports(all, caller) });
    }

    if (action === 'get') {
      const id = toBigInt(payload.id);
      if (id == null) return json(400, { error: 'Missing id' });
      const rows = await sql`SELECT * FROM incident_reports WHERE id = ${id}`;
      if (!rows.length) return json(404, { error: 'Not found' });
      const report = rowToReport(rows[0]);
      if (!canViewReport(report, caller)) return json(404, { error: 'Not found' });
      return json(200, { ok: true, report });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('incident-reports.mjs error:', err);
    return json(500, { error: err.message });
  }
};
