// tasks.mjs — Ops Task & Checklist system API (portal-native, Workpulse-independent).
// See docs/TASK_CHECKLIST_SYSTEM_PLAN.md.
//
// Phase 1: single-value completion per instance.
// Phase 2: task_template_items + task_template_equipment + task_instance_answers
//           (multi-item per-task completion, per-item ranges, equipment units).
// Phase 3: corrective_actions (auto-created when answer out of range).
//
// Actions
//   ── Manager / DM / Exec (consume) ──
//   list        {store_pc, date}
//   complete    {instance_id, value?, note?, by?, checklist?}   ← simple tasks (no items)
//   submit_answers {instance_id, answers[], by}                  ← multi-item tasks
//   reopen      {instance_id}
//   dashboard   {store_pc, date}
//   rollup      {date, district?}
//   list_corrective_actions {store_pc?, district?, status?}
//   resolve_ca  {ca_id, resolved_by}
//   ── Exec / IT (admin "Book Task") ──
//   admin_templates
//   admin_save_template  {template}
//   admin_get_locations  {template_id}
//   admin_set_locations  {template_id, store_pcs[]}
//   admin_toggle_active  {template_id, active}
//   admin_get_items      {template_id}
//   admin_save_items     {template_id, items[], equipment[]}
//   seed                 (idempotent catalog load)
//   seed_items           (seed sub-items from ITEMS_CATALOG)

import webpush from 'web-push';
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { resolveCaller, isExec } from './_shared/auth.mjs';
import { STORE_BY_PC } from './ndcp-lib/store-map.js';
import { CATALOG, SHIFT_WINDOWS, ITEMS_CATALOG } from './tasks-lib/catalog.js';
import { STORE_COORDS } from './analyst-lib/store-coords.mjs';

let _tableEnsured = false;

// ── Geofence: stamp a task completion with the submitter's location (opt-in,
// captured in-browser) and flag whether it's on-site vs the store's coords.
// Radius is generous — indoor/Wi-Fi GPS is coarse, and we only "flag" (never block).
const GEOFENCE_M = 250;
function haversineM(aLat, aLng, bLat, bLng) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}
// Returns {lat,lng,acc,dist,onsite} — all null when no coords were sent.
function geoFromBody(body, storePc) {
  if (body.lat == null || body.lng == null) return { lat: null, lng: null, acc: null, dist: null, onsite: null };
  const lat = +body.lat, lng = +body.lng;
  const acc = body.accuracy != null ? Math.round(+body.accuracy) : null;
  const sc = STORE_COORDS[String(storePc)];
  let dist = null, onsite = null;
  if (sc) { dist = haversineM(lat, lng, sc.lat, sc.lng); onsite = dist <= GEOFENCE_M; }
  return { lat, lng, acc, dist, onsite };
}

async function blobLoad(key) {
  const store = getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
  const result = await store.get(key, { type: 'json' });
  return (result && result.data) ? result.data : null;
}

async function sendPhotoPush(storePc, taskName, by) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const storeInfo = STORE_BY_PC[storePc];
  if (!storeInfo) return;
  const [users, subs] = await Promise.all([blobLoad('pcg_users_v1'), blobLoad('pcg_push_subscriptions_v1')]);
  const userList = Array.isArray(users) ? users : [];
  const subMap = (subs && typeof subs === 'object') ? subs : {};
  const dm = userList.find((u) => u.active !== false && u.userType === 'dm' && String(u.district) === String(storeInfo.district));
  if (!dm) return;
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  const pushPayload = JSON.stringify({
    title: `📷 Task Photo — ${storeInfo.name}`,
    body: `${taskName}${by ? ` · submitted by ${by}` : ''}`,
    icon: '/icon-192.png',
    url: 'https://pcg-ops.netlify.app',
    tag: `task-photo-${storePc}`,
  });
  for (const sub of (subMap[String(dm.id)] || [])) {
    await webpush.sendNotification(sub, pushPayload).catch(() => {});
  }
}

async function sendCAPush(storePc, cas) {
  if (!cas.length || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const storeInfo = STORE_BY_PC[storePc];
  if (!storeInfo) return;
  const [users, subs] = await Promise.all([blobLoad('pcg_users_v1'), blobLoad('pcg_push_subscriptions_v1')]);
  const userList = Array.isArray(users) ? users : [];
  const subMap = (subs && typeof subs === 'object') ? subs : {};
  const dm = userList.find((u) => u.active !== false && u.userType === 'dm' && String(u.district) === String(storeInfo.district));
  if (!dm) return;
  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  const title = `⚠ Corrective Action — ${storeInfo.name}`;
  const body = cas.length === 1
    ? `${cas[0].label}: ${cas[0].value}${cas[0].unit} out of range`
    : `${cas.length} readings out of range`;
  const pushPayload = JSON.stringify({ title, body, icon: '/icon-192.png', url: 'https://pcg-ops.netlify.app', tag: `ca-${storePc}` });
  for (const sub of (subMap[String(dm.id)] || [])) {
    await webpush.sendNotification(sub, pushPayload).catch(() => {});
  }
}

const ALLOWED_ORIGINS = ['https://uop.peoplecapitalgroup.com', 'https://pcg-ops.netlify.app'];
function corsFor(request) {
  const origin = request.headers.get('origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
}

// ── Date / time helpers (ET) ──
function etNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {}; for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute };
}
function dowOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}
function daysSinceEpoch(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function computeStatus(row, now) {
  if (row.status === 'completed') return 'completed';
  const isPast = row.business_date < now.date;
  if (isPast) return 'missed';
  if (row.business_date === now.date && row.shift_time) {
    const w = SHIFT_WINDOWS[row.shift_time];
    if (w && (now.hour > w.endHour || (now.hour === w.endHour && now.minute > w.endMin))) return 'overdue';
  }
  return 'open';
}

function tally(rows, now, keyFn) {
  const blank = () => ({ open: 0, overdue: 0, missed: 0, completed: 0, all: 0 });
  const withPct = (o) => ({ ...o, pct: o.all ? Math.round((o.completed / o.all) * 100) : 0 });
  const totals = blank();
  const groups = {};
  for (const r of rows) {
    const s = computeStatus(r, now);
    totals[s]++; totals.all++;
    if (keyFn) {
      const k = keyFn(r) || 'Other';
      if (!groups[k]) groups[k] = { key: k, ...blank() };
      groups[k][s]++; groups[k].all++;
    }
  }
  return { totals: withPct(totals), groups: Object.values(groups).map(withPct) };
}

async function ensureTable(db) {
  // ── Phase 1 tables ──
  await db`
    CREATE TABLE IF NOT EXISTS task_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      task_type TEXT DEFAULT 'shift',
      category TEXT,
      label TEXT,
      input_type TEXT DEFAULT 'checklist',
      frequency TEXT DEFAULT 'daily',
      shift_time TEXT,
      recur_days INT,
      target NUMERIC, min_val NUMERIC, max_val NUMERIC, unit TEXT,
      allow_signoff BOOL DEFAULT false,
      is_master BOOL DEFAULT false,
      active BOOL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS task_templates_name_idx ON task_templates(name)`;
  await db`
    CREATE TABLE IF NOT EXISTS task_template_locations (
      template_id INT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      store_pc TEXT NOT NULL,
      PRIMARY KEY (template_id, store_pc)
    )`;
  await db`
    CREATE TABLE IF NOT EXISTS task_instances (
      id SERIAL PRIMARY KEY,
      template_id INT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      store_pc TEXT NOT NULL,
      business_date DATE NOT NULL,
      shift_time TEXT,
      status TEXT DEFAULT 'open',
      value NUMERIC,
      note TEXT,
      checklist JSONB,
      completed_by TEXT, completed_at TIMESTAMPTZ,
      signed_off_by TEXT, signed_off_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (template_id, store_pc, business_date)
    )`;
  await db`CREATE INDEX IF NOT EXISTS task_instances_store_date_idx ON task_instances(store_pc, business_date)`;

  // ── Phase 2 tables ──
  await db`
    CREATE TABLE IF NOT EXISTS task_template_items (
      id SERIAL PRIMARY KEY,
      template_id INT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      sort_order INT DEFAULT 0,
      input_type TEXT DEFAULT 'bool',
      group_name TEXT,
      target NUMERIC, min_val NUMERIC, max_val NUMERIC, unit TEXT,
      requires_photo BOOL DEFAULT false
    )`;
  await db`CREATE INDEX IF NOT EXISTS tti_template_idx ON task_template_items(template_id)`;
  await db`
    CREATE TABLE IF NOT EXISTS task_template_equipment (
      id SERIAL PRIMARY KEY,
      template_id INT NOT NULL REFERENCES task_templates(id) ON DELETE CASCADE,
      unit_name TEXT NOT NULL,
      sort_order INT DEFAULT 0
    )`;
  await db`CREATE INDEX IF NOT EXISTS tte_template_idx ON task_template_equipment(template_id)`;
  await db`
    CREATE TABLE IF NOT EXISTS task_instance_answers (
      id SERIAL PRIMARY KEY,
      instance_id INT NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE,
      item_id INT NOT NULL REFERENCES task_template_items(id) ON DELETE CASCADE,
      equipment_id INT REFERENCES task_template_equipment(id) ON DELETE SET NULL,
      checked BOOL,
      value NUMERIC,
      note TEXT,
      in_range BOOL,
      by TEXT,
      at TIMESTAMPTZ DEFAULT now()
    )`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS tia_uq_no_equip ON task_instance_answers(instance_id, item_id) WHERE equipment_id IS NULL`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS tia_uq_with_equip ON task_instance_answers(instance_id, item_id, equipment_id) WHERE equipment_id IS NOT NULL`;
  await db`CREATE INDEX IF NOT EXISTS tia_instance_idx ON task_instance_answers(instance_id)`;

  // ── Phase 3 table ──
  await db`
    CREATE TABLE IF NOT EXISTS corrective_actions (
      id SERIAL PRIMARY KEY,
      instance_id INT REFERENCES task_instances(id) ON DELETE SET NULL,
      item_id INT REFERENCES task_template_items(id) ON DELETE SET NULL,
      store_pc TEXT NOT NULL,
      station TEXT,
      title TEXT NOT NULL,
      measured_value NUMERIC,
      target NUMERIC, min_val NUMERIC, max_val NUMERIC, unit TEXT,
      assignee TEXT,
      due_date DATE,
      status TEXT DEFAULT 'open',
      resolved_by TEXT, resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )`;
  await db`CREATE INDEX IF NOT EXISTS ca_store_status_idx ON corrective_actions(store_pc, status)`;
  // Partial unique indexes prevent duplicate CAs for the same instance+item, matching the pattern on task_instance_answers
  await db`CREATE UNIQUE INDEX IF NOT EXISTS ca_uq_no_station ON corrective_actions(instance_id, item_id) WHERE station IS NULL`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS ca_uq_with_station ON corrective_actions(instance_id, item_id, station) WHERE station IS NOT NULL`;
  // Phase 5: photo evidence on corrective actions + task instances
  await db`ALTER TABLE corrective_actions ADD COLUMN IF NOT EXISTS photo_url TEXT`;
  await db`ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS photo_url TEXT`;
  // Phase 6: opt-in geolocation stamp on completion (on-site verification)
  await db`ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS gps_lat NUMERIC`;
  await db`ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS gps_lng NUMERIC`;
  await db`ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS gps_accuracy NUMERIC`;
  await db`ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS gps_dist_m NUMERIC`;
  await db`ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS gps_onsite BOOL`;
}

async function generateInstances(db, storePcs, dateStr) {
  const pcs = (Array.isArray(storePcs) ? storePcs : [storePcs]).map(String);
  if (!pcs.length) return;
  const dow = dowOf(dateStr);
  const dayNum = daysSinceEpoch(dateStr);
  await db`
    INSERT INTO task_instances (template_id, store_pc, business_date, shift_time)
    SELECT t.id, l.store_pc, ${dateStr}::date, t.shift_time
    FROM task_templates t
    JOIN task_template_locations l ON l.template_id = t.id
    WHERE t.active = true AND l.store_pc = ANY(${pcs})
      AND (
        t.frequency = 'daily'
        OR (t.frequency = 'weekly'  AND ${dow} = 1)
        OR (t.frequency = 'general' AND t.recur_days IS NOT NULL AND t.recur_days > 0
            AND ${dayNum} >= floor(extract(epoch FROM t.created_at) / 86400)
            AND ((${dayNum} - floor(extract(epoch FROM t.created_at) / 86400))::int % t.recur_days) = 0)
      )
    ON CONFLICT (template_id, store_pc, business_date) DO NOTHING`;
}

// Server-side scope enforcement for read endpoints: a manager is locked to their own store,
// a DM to their district; exec/IT (or unresolved/server callers) get exactly what they requested.
function enforceScope(caller, requested) {
  if (!caller || isExec(caller.role)) return requested;
  if (caller.role === 'manager') return caller.storePC ? [caller.storePC] : [];
  if (caller.role === 'dm' && caller.district != null) {
    const dp = Object.values(STORE_BY_PC).filter((s) => s.district === caller.district).map((s) => String(s.pc));
    return requested.length ? requested.filter((p) => dp.includes(p)) : dp;
  }
  return requested;
}

export default async (request, context) => {
  const cors = corsFor(request);
  const reply = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: cors });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  let body = {};
  try { body = await request.json().catch(() => ({})); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action || 'list';
  const db = sql();

  try {
    if (!_tableEnsured) { await ensureTable(db); _tableEnsured = true; }
    const now = etNow();

    // ───────────────────────── consume ─────────────────────────

    if (action === 'list') {
      const storePc = String(body.store_pc || '');
      const date = String(body.date || now.date);
      if (!storePc) return reply(400, { error: 'store_pc required' });
      await generateInstances(db, storePc, date);

      const rows = await db`
        SELECT i.id, i.template_id, i.store_pc, i.business_date::text AS business_date,
               i.shift_time, i.status, i.value, i.note, i.checklist,
               i.completed_by, i.completed_at, i.signed_off_by, i.signed_off_at,
               (i.photo_url IS NOT NULL) AS has_photo,
               i.gps_onsite, i.gps_dist_m, (i.gps_lat IS NOT NULL) AS has_gps,
               t.name, t.category, t.label, t.input_type, t.task_type,
               t.target, t.min_val, t.max_val, t.unit, t.allow_signoff
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.store_pc = ${storePc} AND i.business_date = ${date}
        ORDER BY t.category, t.name`;

      // Fetch items, equipment, and answers for this store/date batch
      const templateIds = [...new Set(rows.map((r) => r.template_id))];
      const instanceIds = rows.map((r) => r.id);
      let allItems = [], allEquip = [], allAnswers = [];

      if (templateIds.length) {
        allItems = await db`SELECT * FROM task_template_items WHERE template_id = ANY(${templateIds}) ORDER BY template_id, sort_order`;
        allEquip = await db`SELECT * FROM task_template_equipment WHERE template_id = ANY(${templateIds}) ORDER BY template_id, sort_order`;
      }
      if (instanceIds.length) {
        allAnswers = await db`SELECT * FROM task_instance_answers WHERE instance_id = ANY(${instanceIds})`;
      }

      const itemsByTpl = {}, equipByTpl = {}, anssByInst = {};
      allItems.forEach((i) => { (itemsByTpl[i.template_id] = itemsByTpl[i.template_id] || []).push(i); });
      allEquip.forEach((e) => { (equipByTpl[e.template_id] = equipByTpl[e.template_id] || []).push(e); });
      allAnswers.forEach((a) => { (anssByInst[a.instance_id] = anssByInst[a.instance_id] || []).push(a); });

      const tasks = rows.map((r) => {
        const items = itemsByTpl[r.template_id] || [];
        const equipment = equipByTpl[r.template_id] || [];
        const answers = anssByInst[r.id] || [];
        const totalExpected = items.length > 0 ? items.length * Math.max(1, equipment.length) : 0;
        return {
          ...r, statusComputed: computeStatus(r, now),
          items, equipment, answers,
          items_count: totalExpected,
          answers_count: answers.length,
        };
      });

      const { totals } = tally(rows, now);
      return reply(200, { store_pc: storePc, date, counts: totals, tasks });
    }

    if (action === 'merchandising') {
      // Photo gallery of merchandising / donut-case proof photos, scoped to the
      // store_pcs the caller passes (frontend already role-scopes: exec=all,
      // DM=district, manager=own store). Paginated, newest first.
      const requested = (Array.isArray(body.store_pcs) ? body.store_pcs : []).map(String);
      // Server-side scope enforcement: a manager is locked to their own store, a DM to their
      // district — claimed store_pcs are intersected with what their real role allows. Exec/IT
      // (or unresolved/server callers) get exactly what they requested.
      const pcs = enforceScope(await resolveCaller(body.userId), requested);
      const page = Math.max(1, parseInt(body.page, 10) || 1);
      const pageSize = Math.min(24, Math.max(1, parseInt(body.page_size, 10) || 6));
      const offset = (page - 1) * pageSize;
      // Optional single-day filter (business_date) so photos from different days don't mix.
      // null = all dates.
      const date = body.date ? String(body.date) : null;
      if (!pcs.length) return reply(200, { photos: [], total: 0, page, page_size: pageSize, date });
      const countRows = await db`
        SELECT COUNT(*)::int AS n
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.photo_url IS NOT NULL AND i.store_pc = ANY(${pcs})
          AND (${date}::text IS NULL OR i.business_date = ${date}::date)
          AND (t.category ILIKE 'merchandising' OR t.name ILIKE '%merchandising%' OR t.name ILIKE '%donut%')`;
      const total = countRows[0]?.n || 0;
      const rows = await db`
        SELECT i.id, i.store_pc, i.business_date::text AS business_date, i.shift_time,
               i.completed_at, i.completed_by, i.photo_url, t.name, t.category
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.photo_url IS NOT NULL AND i.store_pc = ANY(${pcs})
          AND (${date}::text IS NULL OR i.business_date = ${date}::date)
          AND (t.category ILIKE 'merchandising' OR t.name ILIKE '%merchandising%' OR t.name ILIKE '%donut%')
        ORDER BY i.completed_at DESC NULLS LAST, i.business_date DESC, i.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`;
      const photos = rows.map((r) => ({
        id: r.id, store_pc: r.store_pc,
        store_name: STORE_BY_PC[r.store_pc]?.name || r.store_pc,
        district: STORE_BY_PC[r.store_pc]?.district ?? null,
        name: r.name, category: r.category, shift_time: r.shift_time,
        business_date: r.business_date, completed_at: r.completed_at, completed_by: r.completed_by,
        photo_url: r.photo_url,
      }));
      return reply(200, { photos, total, page, page_size: pageSize, date });
    }

    // ── Compliance & trend report: daily completion % over a date range ──
    if (action === 'trends') {
      const pcs = enforceScope(await resolveCaller(body.userId), (Array.isArray(body.store_pcs) ? body.store_pcs : []).map(String));
      const from = String(body.from || ''), to = String(body.to || '');
      if (!pcs.length || !from || !to) return reply(200, { days: [], summary: { all: 0, completed: 0, pct: 0 } });
      const dayRows = await db`
        SELECT i.business_date::text AS d,
               COUNT(*)::int AS all,
               COUNT(*) FILTER (WHERE i.status = 'completed')::int AS completed
        FROM task_instances i
        WHERE i.store_pc = ANY(${pcs}) AND i.business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY i.business_date ORDER BY i.business_date ASC`;
      const days = dayRows.map((r) => ({ date: r.d, all: r.all, completed: r.completed, pct: r.all ? Math.round((r.completed / r.all) * 100) : 0 }));
      const catRows = await db`
        SELECT t.category AS category,
               COUNT(*)::int AS all,
               COUNT(*) FILTER (WHERE i.status = 'completed')::int AS completed
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.store_pc = ANY(${pcs}) AND i.business_date BETWEEN ${from}::date AND ${to}::date
        GROUP BY t.category ORDER BY (COUNT(*) FILTER (WHERE i.status='completed')::float / NULLIF(COUNT(*),0)) ASC NULLS FIRST`;
      const categories = catRows.map((r) => ({ category: r.category || 'Other', all: r.all, completed: r.completed, pct: r.all ? Math.round((r.completed / r.all) * 100) : 0 }));
      const allT = days.reduce((s, d) => s + d.all, 0), compT = days.reduce((s, d) => s + d.completed, 0);
      return reply(200, { from, to, days, categories, summary: { all: allT, completed: compT, pct: allT ? Math.round((compT / allT) * 100) : 0 } });
    }

    // ── Task History: past completions/misses over a date range (paginated) ──
    if (action === 'history') {
      const pcs = enforceScope(await resolveCaller(body.userId), (Array.isArray(body.store_pcs) ? body.store_pcs : []).map(String));
      const from = String(body.from || ''), to = String(body.to || '');
      const statusFilter = body.status ? String(body.status) : 'all';
      const page = Math.max(1, parseInt(body.page, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(body.page_size, 10) || 30));
      const offset = (page - 1) * pageSize;
      if (!pcs.length || !from || !to) return reply(200, { rows: [], total: 0, page, page_size: pageSize });
      // Replicate computeStatus() in SQL so status filtering, total count, and pagination all
      // happen in the DB — otherwise an exec-scope range would pull every instance into memory on
      // each page. `pastShifts` = the shift windows already closed at the current ET time, so
      // today's not-yet-done tasks in those windows resolve to 'overdue' (mirrors computeStatus).
      const pastShifts = Object.keys(SHIFT_WINDOWS).filter((st) => {
        const w = SHIFT_WINDOWS[st];
        return now.hour > w.endHour || (now.hour === w.endHour && now.minute > w.endMin);
      });
      const out = await db`
        SELECT *, COUNT(*) OVER()::int AS _total FROM (
          SELECT i.id, i.store_pc, i.business_date::text AS business_date, i.shift_time,
                 i.completed_by, i.completed_at, t.name, t.category,
                 CASE
                   WHEN i.status = 'completed' THEN 'completed'
                   WHEN i.business_date < ${now.date}::date THEN 'missed'
                   WHEN i.business_date = ${now.date}::date AND i.shift_time = ANY(${pastShifts}::text[]) THEN 'overdue'
                   ELSE 'open'
                 END AS sc
          FROM task_instances i JOIN task_templates t ON t.id = i.template_id
          WHERE i.store_pc = ANY(${pcs}) AND i.business_date BETWEEN ${from}::date AND ${to}::date
        ) h
        WHERE (${statusFilter} = 'all' OR h.sc = ${statusFilter})
        ORDER BY h.business_date DESC, h.completed_at DESC NULLS LAST, h.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`;
      const total = out[0]?._total || 0;
      const rows = out.map((r) => ({
        id: r.id, store_pc: r.store_pc, store_name: STORE_BY_PC[r.store_pc]?.name || r.store_pc,
        district: STORE_BY_PC[r.store_pc]?.district ?? null,
        business_date: r.business_date, shift_time: r.shift_time, name: r.name, category: r.category,
        status: r.sc, completed_by: r.completed_by, completed_at: r.completed_at,
      }));
      return reply(200, { rows, total, page, page_size: pageSize });
    }

    // ── Temp Compliance log: numeric temp/quality readings with pass/fail over a range ──
    if (action === 'temp_log') {
      const pcs = enforceScope(await resolveCaller(body.userId), (Array.isArray(body.store_pcs) ? body.store_pcs : []).map(String));
      const from = String(body.from || ''), to = String(body.to || '');
      const page = Math.max(1, parseInt(body.page, 10) || 1);
      const pageSize = Math.min(200, Math.max(1, parseInt(body.page_size, 10) || 50));
      const offset = (page - 1) * pageSize;
      if (!pcs.length || !from || !to) return reply(200, { rows: [], total: 0, page, page_size: pageSize });
      const countRows = await db`
        SELECT COUNT(*)::int AS n
        FROM task_instance_answers a
        JOIN task_instances i ON i.id = a.instance_id
        JOIN task_template_items it ON it.id = a.item_id
        JOIN task_templates t ON t.id = i.template_id
        LEFT JOIN task_template_equipment e ON e.id = a.equipment_id
        WHERE i.store_pc = ANY(${pcs}) AND i.business_date BETWEEN ${from}::date AND ${to}::date
          AND a.value IS NOT NULL AND (it.min_val IS NOT NULL OR it.max_val IS NOT NULL)`;
      const total = countRows[0]?.n || 0;
      const rows = await db`
        SELECT i.store_pc, i.business_date::text AS business_date, a.at, a.value, a.in_range, a.by,
               t.category, COALESCE(t.label, t.name) AS task_name,
               it.label AS item_label, it.min_val, it.max_val, it.unit, e.unit_name AS equipment
        FROM task_instance_answers a
        JOIN task_instances i ON i.id = a.instance_id
        JOIN task_template_items it ON it.id = a.item_id
        JOIN task_templates t ON t.id = i.template_id
        LEFT JOIN task_template_equipment e ON e.id = a.equipment_id
        WHERE i.store_pc = ANY(${pcs}) AND i.business_date BETWEEN ${from}::date AND ${to}::date
          AND a.value IS NOT NULL AND (it.min_val IS NOT NULL OR it.max_val IS NOT NULL)
        ORDER BY a.at DESC NULLS LAST, i.business_date DESC
        LIMIT ${pageSize} OFFSET ${offset}`;
      const inRangeCount = rows.filter((r) => r.in_range === true).length;
      const mapped = rows.map((r) => ({
        store_pc: r.store_pc, store_name: STORE_BY_PC[r.store_pc]?.name || r.store_pc,
        district: STORE_BY_PC[r.store_pc]?.district ?? null,
        business_date: r.business_date, at: r.at, category: r.category, task_name: r.task_name,
        item_label: r.item_label, equipment: r.equipment,
        value: r.value != null ? Number(r.value) : null,
        min_val: r.min_val != null ? Number(r.min_val) : null,
        max_val: r.max_val != null ? Number(r.max_val) : null,
        unit: r.unit, in_range: r.in_range, by: r.by,
      }));
      return reply(200, { rows: mapped, total, page, page_size: pageSize, page_in_range: inRangeCount });
    }

    if (action === 'gps_audit') {
      // IT/Exec/DM review: completions flagged off-site, or missing location on a
      // store-day where location was otherwise active (i.e. one slipped through).
      // Stores that never enabled location aren't flagged (keeps it low-noise).
      const from = String(body.from || ''), to = String(body.to || '');
      const pcs = (Array.isArray(body.store_pcs) ? body.store_pcs : []).map(String);
      if (!from || !to) return reply(400, { error: 'from and to required' });
      if (!pcs.length) return reply(200, { exceptions: [], summary: { total: 0, withGps: 0, offsite: 0, noLocation: 0 }, from, to });
      const rows = await db`
        SELECT i.id, i.store_pc, i.business_date::text AS business_date, i.completed_at, i.completed_by,
               i.gps_onsite, i.gps_dist_m, i.gps_lat, i.gps_lng, (i.gps_lat IS NOT NULL) AS has_gps, t.name, t.category
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.status = 'completed' AND i.business_date BETWEEN ${from} AND ${to}
          AND i.store_pc = ANY(${pcs})
        ORDER BY i.completed_at DESC NULLS LAST`;
      const activeDay = new Set();
      for (const r of rows) if (r.has_gps) activeDay.add(r.store_pc + '|' + r.business_date);
      const exceptions = rows
        .filter(r => r.gps_onsite === false || (!r.has_gps && activeDay.has(r.store_pc + '|' + r.business_date)))
        .map(r => ({ id: r.id, store_pc: r.store_pc, date: r.business_date, at: r.completed_at, by: r.completed_by,
          name: r.name, category: r.category, dist_m: r.gps_dist_m,
          status: r.gps_onsite === false ? 'offsite' : 'no_location' }));
      // Map points: every completion that has coordinates (on-site + off-site).
      const points = rows.filter(r => r.gps_lat != null && r.gps_lng != null).map(r => ({
        id: r.id, store_pc: r.store_pc, date: r.business_date, by: r.completed_by, name: r.name,
        lat: Number(r.gps_lat), lng: Number(r.gps_lng), onsite: r.gps_onsite, dist_m: r.gps_dist_m,
      }));
      const summary = {
        total: rows.length,
        withGps: rows.filter(r => r.has_gps).length,
        onsite: rows.filter(r => r.gps_onsite === true).length,
        offsite: rows.filter(r => r.gps_onsite === false).length,
        // Has coords but no store-coords to geofence against → can't confirm on-site.
        unverified: rows.filter(r => r.has_gps && r.gps_onsite == null).length,
        noLocation: exceptions.filter(e => e.status === 'no_location').length,
      };
      return reply(200, { exceptions, points, summary, from, to });
    }

    if (action === 'audit_report') {
      // Health-inspector audit: one store, a date range, every completed task with
      // its checklist/temp answers (pass/fail), photo flag, GPS verdict, sign-off,
      // and any corrective actions. Assembly only — all data already captured.
      const storePc = String(body.store_pc || '');
      const to = String(body.to || '');
      let from = String(body.from || '');
      if (!storePc || !from || !to) return reply(400, { error: 'store_pc, from, to required' });
      // Clamp to a 366-day window (protect the 26s budget + payload size).
      const fromD = new Date(from + 'T00:00:00'), toD = new Date(to + 'T00:00:00');
      if (!isNaN(fromD) && !isNaN(toD) && (toD - fromD) > 366 * 86400000) {
        const c = new Date(toD.getTime() - 366 * 86400000);
        from = `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}-${String(c.getDate()).padStart(2, '0')}`;
      }

      const rows = await db`
        SELECT i.id, i.template_id, i.business_date::text AS business_date, i.value, i.note,
               i.completed_by, i.completed_at, i.signed_off_by, i.signed_off_at,
               (i.photo_url IS NOT NULL) AS has_photo,
               i.gps_onsite, i.gps_dist_m, (i.gps_lat IS NOT NULL) AS has_gps,
               t.name, t.category, t.input_type, t.unit, t.target, t.min_val, t.max_val
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.store_pc = ${storePc} AND i.business_date BETWEEN ${from} AND ${to} AND i.status = 'completed'
        ORDER BY i.business_date DESC, t.category, t.name`;

      const tplIds = [...new Set(rows.map(r => r.template_id))];
      const instIds = rows.map(r => r.id);
      let items = [], equip = [], answers = [], cas = [];
      if (tplIds.length) {
        items = await db`SELECT id, label, unit FROM task_template_items WHERE template_id = ANY(${tplIds})`;
        equip = await db`SELECT id, unit_name FROM task_template_equipment WHERE template_id = ANY(${tplIds})`;
      }
      if (instIds.length) {
        answers = await db`SELECT instance_id, item_id, equipment_id, checked, value, in_range, "by" AS answered_by, "at" AS answered_at FROM task_instance_answers WHERE instance_id = ANY(${instIds})`;
        cas = await db`SELECT instance_id, title, measured_value, unit, status, resolved_by FROM corrective_actions WHERE instance_id = ANY(${instIds})`;
      }
      const itemById = {}; items.forEach(i => { itemById[i.id] = i; });
      const equipById = {}; equip.forEach(e => { equipById[e.id] = e; });
      const ansByInst = {}; answers.forEach(a => { (ansByInst[a.instance_id] = ansByInst[a.instance_id] || []).push(a); });
      const caByInst = {}; cas.forEach(c => { (caByInst[c.instance_id] = caByInst[c.instance_id] || []).push(c); });

      const tasks = rows.map(r => ({
        id: r.id, date: r.business_date, name: r.name, category: r.category, input_type: r.input_type,
        value: r.value, note: r.note, unit: r.unit, target: r.target, min_val: r.min_val, max_val: r.max_val,
        by: r.completed_by, at: r.completed_at, signed_off_by: r.signed_off_by, signed_off_at: r.signed_off_at,
        has_photo: r.has_photo, gps_onsite: r.gps_onsite, gps_dist_m: r.gps_dist_m, has_gps: r.has_gps,
        answers: (ansByInst[r.id] || []).map(a => ({
          label: itemById[a.item_id]?.label || '', unit: itemById[a.item_id]?.unit || r.unit || '',
          equipment: a.equipment_id ? (equipById[a.equipment_id]?.unit_name || '') : '',
          checked: a.checked, value: a.value, in_range: a.in_range, by: a.answered_by,
        })),
        corrective: (caByInst[r.id] || []).map(c => ({ title: c.title, measured: c.measured_value, unit: c.unit, status: c.status, resolved_by: c.resolved_by })),
      }));

      const tempAns = answers.filter(a => a.in_range != null);
      const summary = {
        completions: rows.length,
        days: new Set(rows.map(r => r.business_date)).size,
        photos: rows.filter(r => r.has_photo).length,
        gpsVerified: rows.filter(r => r.has_gps).length,
        onsite: rows.filter(r => r.gps_onsite === true).length,
        offsite: rows.filter(r => r.gps_onsite === false).length,
        tempReadings: tempAns.length,
        tempPass: tempAns.filter(a => a.in_range === true).length,
        correctiveActions: cas.length,
      };
      return reply(200, { store_pc: storePc, from, to, tasks, summary });
    }

    if (action === 'complete') {
      // Simple completion for tasks without items (Phase 1 compat)
      const id = +body.instance_id;
      if (!id) return reply(400, { error: 'instance_id required' });
      const g = geoFromBody(body, body.store_pc);
      await db`
        UPDATE task_instances SET
          status = 'completed',
          value = ${body.value ?? null},
          note = ${body.note ?? null},
          checklist = ${body.checklist ? JSON.stringify(body.checklist) : null}::jsonb,
          completed_by = ${body.by ?? null},
          completed_at = now(),
          gps_lat = ${g.lat}, gps_lng = ${g.lng}, gps_accuracy = ${g.acc},
          gps_dist_m = ${g.dist}, gps_onsite = ${g.onsite}
        WHERE id = ${id}`;
      return reply(200, { ok: true, instance_id: id, onsite: g.onsite, dist_m: g.dist });
    }

    if (action === 'submit_answers') {
      const instanceId = +body.instance_id;
      const answers = Array.isArray(body.answers) ? body.answers : [];
      const by = body.by || null;
      if (!instanceId || !answers.length) return reply(400, { error: 'instance_id and answers required' });

      const instRows = await db`
        SELECT i.*, t.name AS task_name, t.input_type
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.id = ${instanceId}`;
      if (!instRows.length) return reply(404, { error: 'instance not found' });
      const inst = instRows[0];

      const items = await db`SELECT * FROM task_template_items WHERE template_id = ${inst.template_id} ORDER BY sort_order`;
      const itemMap = Object.fromEntries(items.map((it) => [it.id, it]));
      const equip = await db`SELECT * FROM task_template_equipment WHERE template_id = ${inst.template_id}`;
      const equipMap = Object.fromEntries(equip.map((e) => [e.id, e]));

      const casCreated = [];

      for (const ans of answers) {
        const item = itemMap[+ans.item_id];
        if (!item) continue;
        const equipId = ans.equipment_id ? +ans.equipment_id : null;
        const checked = ans.checked != null ? Boolean(ans.checked) : null;
        const value = ans.value != null && ans.value !== '' ? Number(ans.value) : null;
        const note = ans.note || null;

        // Per-item range check
        let inRange = null;
        if (item.min_val != null && item.max_val != null && value != null) {
          inRange = value >= Number(item.min_val) && value <= Number(item.max_val);
        }

        // DELETE + INSERT (avoids UNIQUE NULL complications)
        if (equipId !== null) {
          await db`DELETE FROM task_instance_answers WHERE instance_id = ${instanceId} AND item_id = ${item.id} AND equipment_id = ${equipId}`;
        } else {
          await db`DELETE FROM task_instance_answers WHERE instance_id = ${instanceId} AND item_id = ${item.id} AND equipment_id IS NULL`;
        }
        await db`
          INSERT INTO task_instance_answers (instance_id, item_id, equipment_id, checked, value, note, in_range, by, at)
          VALUES (${instanceId}, ${item.id}, ${equipId}, ${checked}, ${value}, ${note}, ${inRange}, ${by}, now())`;

        // Auto-create corrective action for out-of-range numeric answers
        if (inRange === false) {
          const station = equipId ? (equipMap[equipId]?.unit_name || null) : null;
          const title = `${inst.task_name} — ${item.label}${station ? ` (${station})` : ''}: ${value}${item.unit || ''} (expected ${item.min_val}–${item.max_val}${item.unit || ''})`;
          const due = new Date(); due.setDate(due.getDate() + 1);
          const assignee = STORE_BY_PC[inst.store_pc]?.mgr || null;
          const caResult = await db`
            INSERT INTO corrective_actions (instance_id, item_id, store_pc, station, title, measured_value, target, min_val, max_val, unit, assignee, status, due_date)
            VALUES (${instanceId}, ${item.id}, ${inst.store_pc}, ${station}, ${title}, ${value}, ${item.target}, ${item.min_val}, ${item.max_val}, ${item.unit}, ${assignee}, 'open', ${due.toISOString().slice(0, 10)})
            ON CONFLICT DO NOTHING
            RETURNING id`;
          if (caResult.length) casCreated.push({ label: item.label, value, unit: item.unit || '' });
        }
      }

      // Push DM if any corrective actions were created (fire-and-forget)
      if (casCreated.length) {
        sendCAPush(inst.store_pc, casCreated).catch((e) => console.warn('[tasks] CA push:', e.message));
      }

      // Auto-complete instance when all items × equipment are answered
      if (items.length > 0) {
        const totalExpected = items.length * Math.max(1, equip.length);
        const answeredCnt = (await db`SELECT COUNT(*) AS cnt FROM task_instance_answers WHERE instance_id = ${instanceId}`)[0]?.cnt || 0;
        const allItemsDone = +answeredCnt >= totalExpected;
        // Photo tasks also require a photo before auto-completing
        const photoRequired = inst.input_type === 'photo';
        const photoSatisfied = !photoRequired || !!inst.photo_url;
        if (allItemsDone && photoSatisfied) {
          const g = geoFromBody(body, inst.store_pc);
          await db`UPDATE task_instances SET status='completed', completed_by=${by}, completed_at=now(),
            gps_lat=${g.lat}, gps_lng=${g.lng}, gps_accuracy=${g.acc}, gps_dist_m=${g.dist}, gps_onsite=${g.onsite}
            WHERE id=${instanceId} AND status != 'completed'`;
        }
      }

      return reply(200, { ok: true, corrective_actions_created: casCreated });
    }

    if (action === 'reopen') {
      const id = +body.instance_id;
      if (!id) return reply(400, { error: 'instance_id required' });
      await db`UPDATE task_instances SET status='open', completed_by=null, completed_at=null, signed_off_by=null, signed_off_at=null,
        photo_url=null, value=null, note=null, checklist=null,
        gps_lat=null, gps_lng=null, gps_accuracy=null, gps_dist_m=null, gps_onsite=null WHERE id=${id}`;
      // Remove answers so the form resets
      await db`DELETE FROM task_instance_answers WHERE instance_id = ${id}`;
      return reply(200, { ok: true, instance_id: id });
    }

    if (action === 'dashboard') {
      const storePc = String(body.store_pc || '');
      const date = String(body.date || now.date);
      if (!storePc) return reply(400, { error: 'store_pc required' });
      await generateInstances(db, storePc, date);
      const rows = await db`
        SELECT i.id, i.status, i.business_date::text AS business_date, i.shift_time, t.category
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.store_pc = ${storePc} AND i.business_date = ${date}`;
      // CA count for this store (open)
      const caRows = await db`SELECT COUNT(*) AS cnt FROM corrective_actions WHERE store_pc = ${storePc} AND status = 'open'`;
      const openCAs = +(caRows[0]?.cnt || 0);
      const { totals, groups } = tally(rows, now, (r) => r.category || 'Other');
      const categories = groups.map((g) => ({ category: g.key, open: g.open, overdue: g.overdue, missed: g.missed, completed: g.completed, all: g.all, pct: g.pct }))
        .sort((a, b) => b.all - a.all);
      return reply(200, { store_pc: storePc, date, totals, categories, open_cas: openCAs });
    }

    if (action === 'rollup') {
      const date = String(body.date || now.date);
      const district = body.district ? +body.district : null;
      const stores = Object.values(STORE_BY_PC).filter((s) => !district || s.district === district);
      await generateInstances(db, stores.map((s) => s.pc), date);
      const rows = await db`
        SELECT i.store_pc, i.status, i.business_date::text AS business_date, i.shift_time
        FROM task_instances i
        WHERE i.business_date = ${date}
          AND i.store_pc = ANY(${stores.map((s) => s.pc)})`;
      // Open CA counts per store
      const caRows = await db`SELECT store_pc, COUNT(*) AS cnt FROM corrective_actions WHERE store_pc = ANY(${stores.map((s) => s.pc)}) AND status='open' GROUP BY store_pc`;
      const caByStore = Object.fromEntries(caRows.map((r) => [r.store_pc, +r.cnt]));

      const { groups } = tally(rows, now, (r) => r.store_pc);
      const gmap = {}; groups.forEach((g) => { gmap[g.key] = g; });
      const list = stores.map((s) => {
        const g = gmap[s.pc] || { open: 0, overdue: 0, missed: 0, completed: 0, all: 0, pct: 0 };
        return { pc: s.pc, name: s.name, district: s.district, dmName: s.dmName, open: g.open, overdue: g.overdue, missed: g.missed, completed: g.completed, all: g.all, pct: g.pct, open_cas: caByStore[s.pc] || 0 };
      }).sort((a, b) => a.pct - b.pct);
      return reply(200, { date, district, stores: list });
    }

    if (action === 'list_corrective_actions') {
      const storePc = body.store_pc ? String(body.store_pc) : null;
      const district = body.district ? +body.district : null;
      const status = body.status || null;

      let storePcs;
      if (storePc) {
        storePcs = [storePc];
      } else if (district) {
        storePcs = Object.values(STORE_BY_PC).filter((s) => s.district === district).map((s) => s.pc);
      } else {
        storePcs = Object.values(STORE_BY_PC).map((s) => s.pc);
      }

      const rows = status
        ? await db`SELECT ca.*, t.name AS task_name FROM corrective_actions ca LEFT JOIN task_instances ti ON ti.id = ca.instance_id LEFT JOIN task_templates t ON t.id = ti.template_id WHERE ca.store_pc = ANY(${storePcs}) AND ca.status = ${status} ORDER BY ca.created_at DESC LIMIT 200`
        : await db`SELECT ca.*, t.name AS task_name FROM corrective_actions ca LEFT JOIN task_instances ti ON ti.id = ca.instance_id LEFT JOIN task_templates t ON t.id = ti.template_id WHERE ca.store_pc = ANY(${storePcs}) ORDER BY ca.created_at DESC LIMIT 200`;

      const caList = rows.map((ca) => ({ ...ca, store_name: STORE_BY_PC[ca.store_pc]?.name || ca.store_pc }));
      return reply(200, { corrective_actions: caList });
    }

    if (action === 'sign_off') {
      const id = +body.instance_id;
      if (!id) return reply(400, { error: 'instance_id required' });
      const rows = await db`
        SELECT i.status, t.allow_signoff
        FROM task_instances i JOIN task_templates t ON t.id = i.template_id
        WHERE i.id = ${id}`;
      if (!rows.length) return reply(404, { error: 'instance not found' });
      if (!rows[0].allow_signoff) return reply(400, { error: 'task does not require sign-off' });
      if (rows[0].status !== 'completed') return reply(400, { error: 'task must be completed before sign-off' });
      await db`UPDATE task_instances SET signed_off_by=${body.signed_off_by || null}, signed_off_at=now() WHERE id=${id}`;
      return reply(200, { ok: true, instance_id: id });
    }

    if (action === 'ca_add_photo') {
      const id = +body.ca_id;
      if (!id) return reply(400, { error: 'ca_id required' });
      const caPhoto = body.photo_url || null;
      if (caPhoto && caPhoto.length > 400000) return reply(413, { error: 'photo too large' });
      await db`UPDATE corrective_actions SET photo_url=${caPhoto} WHERE id=${id}`;
      return reply(200, { ok: true, ca_id: id });
    }

    if (action === 'task_add_photo') {
      const id = +body.instance_id;
      const storePc = +body.store_pc;
      if (!id) return reply(400, { error: 'instance_id required' });
      if (!storePc) return reply(400, { error: 'store_pc required' });
      const photoUrl = body.photo_url || null;
      if (photoUrl && photoUrl.length > 400000) return reply(413, { error: 'photo too large' });
      const by = body.by || null;
      // Look up the task + whether it still has outstanding checklist items.
      const taskRow = await db`
        SELECT i.template_id, t.name FROM task_instances i
        JOIN task_templates t ON t.id = i.template_id
        WHERE i.id = ${id} AND i.store_pc = ${storePc}
        LIMIT 1`;
      if (!taskRow.length) return reply(404, { error: 'instance not found' });
      const taskName = taskRow[0].name || 'Task';
      const tplId = taskRow[0].template_id;
      const [{ cnt: itemCnt }] = await db`SELECT count(*)::int AS cnt FROM task_template_items WHERE template_id = ${tplId}`;
      const [{ cnt: equipCnt }] = await db`SELECT count(*)::int AS cnt FROM task_template_equipment WHERE template_id = ${tplId}`;
      const [{ cnt: ansCnt }] = await db`SELECT count(*)::int AS cnt FROM task_instance_answers WHERE instance_id = ${id}`;
      const totalExpected = itemCnt > 0 ? itemCnt * Math.max(1, equipCnt) : 0;
      // A photo only COMPLETES the task when there are no outstanding checklist items
      // (a pure photo task, or all items already answered). For a multi-item task the
      // photo is just attached — completion happens via submit_answers when items are done.
      const complete = totalExpected === 0 || ansCnt >= totalExpected;
      const g = geoFromBody(body, body.store_pc);
      if (complete) {
        await db`
          UPDATE task_instances
          SET photo_url=${photoUrl}, status='completed', completed_by=${by}, completed_at=NOW(),
              gps_lat=${g.lat}, gps_lng=${g.lng}, gps_accuracy=${g.acc},
              gps_dist_m=${g.dist}, gps_onsite=${g.onsite}
          WHERE id=${id} AND store_pc=${storePc}`;
      } else {
        await db`UPDATE task_instances SET photo_url=${photoUrl} WHERE id=${id} AND store_pc=${storePc}`;
      }
      // Notify DM (fire-and-forget)
      sendPhotoPush(storePc, taskName, by).catch((e) => console.warn('[tasks] photo push:', e.message));
      return reply(200, { ok: true, instance_id: id, completed: complete });
    }

    if (action === 'get_task_photo') {
      const id = +body.instance_id;
      const storePc = +body.store_pc;
      if (!id) return reply(400, { error: 'instance_id required' });
      if (!storePc) return reply(400, { error: 'store_pc required' });
      const rows = await db`SELECT photo_url FROM task_instances WHERE id=${id} AND store_pc=${storePc}`;
      return reply(200, { photo_url: rows[0]?.photo_url || null });
    }

    if (action === 'resolve_ca') {
      const id = +body.ca_id;
      if (!id) return reply(400, { error: 'ca_id required' });
      await db`UPDATE corrective_actions SET status='resolved', resolved_by=${body.resolved_by || null}, resolved_at=now() WHERE id=${id}`;
      return reply(200, { ok: true, ca_id: id });
    }

    // ───────────────────────── admin (Exec/IT) ─────────────────────────

    if (action === 'admin_templates') {
      const rows = await db`
        SELECT t.*, COALESCE(l.cnt, 0)::int AS location_count, COALESCE(it.cnt, 0)::int AS items_count
        FROM task_templates t
        LEFT JOIN (SELECT template_id, count(*) cnt FROM task_template_locations GROUP BY template_id) l ON l.template_id = t.id
        LEFT JOIN (SELECT template_id, count(*) cnt FROM task_template_items GROUP BY template_id) it ON it.template_id = t.id
        ORDER BY t.category, t.name`;
      return reply(200, { templates: rows });
    }

    if (action === 'admin_save_template') {
      const x = body.template || {};
      if (!x.name) return reply(400, { error: 'name required' });
      if (x.id) {
        await db`
          UPDATE task_templates SET
            name=${x.name}, task_type=${x.task_type || 'shift'}, category=${x.category || null},
            label=${x.label || null}, input_type=${x.input_type || 'checklist'},
            frequency=${x.frequency || 'daily'}, shift_time=${x.shift_time || null}, recur_days=${x.recur_days ?? null},
            target=${x.target ?? null}, min_val=${x.min_val ?? null}, max_val=${x.max_val ?? null}, unit=${x.unit || null},
            allow_signoff=${!!x.allow_signoff}, is_master=${!!x.is_master}, active=${x.active !== false},
            updated_at=now()
          WHERE id=${+x.id}`;
        return reply(200, { ok: true, id: +x.id });
      }
      const ins = await db`
        INSERT INTO task_templates
          (name, task_type, category, label, input_type, frequency, shift_time, recur_days,
           target, min_val, max_val, unit, allow_signoff, is_master, active)
        VALUES
          (${x.name}, ${x.task_type || 'shift'}, ${x.category || null}, ${x.label || null},
           ${x.input_type || 'checklist'}, ${x.frequency || 'daily'}, ${x.shift_time || null}, ${x.recur_days ?? null},
           ${x.target ?? null}, ${x.min_val ?? null}, ${x.max_val ?? null}, ${x.unit || null},
           ${!!x.allow_signoff}, ${!!x.is_master}, ${x.active !== false})
        ON CONFLICT (name) DO UPDATE SET
          task_type=EXCLUDED.task_type, category=EXCLUDED.category, label=EXCLUDED.label,
          input_type=EXCLUDED.input_type, frequency=EXCLUDED.frequency, shift_time=EXCLUDED.shift_time,
          recur_days=EXCLUDED.recur_days, target=EXCLUDED.target, min_val=EXCLUDED.min_val,
          max_val=EXCLUDED.max_val, unit=EXCLUDED.unit, allow_signoff=EXCLUDED.allow_signoff,
          is_master=EXCLUDED.is_master, active=EXCLUDED.active, updated_at=now()
        RETURNING id`;
      return reply(200, { ok: true, id: ins[0].id });
    }

    if (action === 'admin_get_locations') {
      const id = +body.template_id;
      if (!id) return reply(400, { error: 'template_id required' });
      const rows = await db`SELECT store_pc FROM task_template_locations WHERE template_id = ${id}`;
      return reply(200, { template_id: id, store_pcs: rows.map((r) => r.store_pc) });
    }

    if (action === 'admin_set_locations') {
      const id = +body.template_id;
      const pcs = Array.isArray(body.store_pcs) ? body.store_pcs.map(String) : [];
      if (!id) return reply(400, { error: 'template_id required' });
      await db`DELETE FROM task_template_locations WHERE template_id = ${id}`;
      if (pcs.length) {
        await db`
          INSERT INTO task_template_locations (template_id, store_pc)
          SELECT ${id}, pc FROM unnest(${pcs}::text[]) AS pc
          ON CONFLICT DO NOTHING`;
      }
      return reply(200, { ok: true, template_id: id, count: pcs.length });
    }

    if (action === 'admin_toggle_active') {
      const id = +body.template_id;
      if (!id) return reply(400, { error: 'template_id required' });
      await db`UPDATE task_templates SET active=${!!body.active}, updated_at=now() WHERE id=${id}`;
      return reply(200, { ok: true, template_id: id, active: !!body.active });
    }

    if (action === 'admin_get_items') {
      const id = +body.template_id;
      if (!id) return reply(400, { error: 'template_id required' });
      const items = await db`SELECT * FROM task_template_items WHERE template_id = ${id} ORDER BY sort_order`;
      const equipment = await db`SELECT * FROM task_template_equipment WHERE template_id = ${id} ORDER BY sort_order`;
      return reply(200, { template_id: id, items, equipment });
    }

    if (action === 'admin_save_items') {
      const id = +body.template_id;
      const items = Array.isArray(body.items) ? body.items : [];
      const equipment = Array.isArray(body.equipment) ? body.equipment : [];
      if (!id) return reply(400, { error: 'template_id required' });

      await db`DELETE FROM task_template_items WHERE template_id = ${id}`;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it.label) continue;
        await db`
          INSERT INTO task_template_items (template_id, label, sort_order, input_type, group_name, target, min_val, max_val, unit, requires_photo)
          VALUES (${id}, ${it.label}, ${i}, ${it.input_type || 'bool'}, ${it.group_name || null}, ${it.target ?? null}, ${it.min_val ?? null}, ${it.max_val ?? null}, ${it.unit || null}, ${!!it.requires_photo})`;
      }
      await db`DELETE FROM task_template_equipment WHERE template_id = ${id}`;
      for (let i = 0; i < equipment.length; i++) {
        const e = equipment[i];
        if (!e.unit_name) continue;
        await db`INSERT INTO task_template_equipment (template_id, unit_name, sort_order) VALUES (${id}, ${e.unit_name}, ${i})`;
      }
      return reply(200, { ok: true, items: items.length, equipment: equipment.length });
    }

    if (action === 'seed') {
      const all45 = Object.values(STORE_BY_PC).map((s) => s.pc);
      const col = (k, map) => CATALOG.map((c) => (map ? map(c[k]) : c[k]) ?? null);
      await db`
        INSERT INTO task_templates
          (name, task_type, category, label, input_type, frequency, shift_time, recur_days,
           target, min_val, max_val, unit, allow_signoff, is_master, active)
        SELECT * FROM unnest(
          ${col('name')}::text[], ${col('task_type')}::text[], ${col('category')}::text[], ${col('label')}::text[],
          ${col('input_type')}::text[], ${col('frequency')}::text[], ${col('shift_time')}::text[], ${col('recur_days')}::int[],
          ${col('target')}::numeric[], ${col('min_val')}::numeric[], ${col('max_val')}::numeric[], ${col('unit')}::text[],
          ${col('allow_signoff', Boolean)}::bool[], ${col('is_master', Boolean)}::bool[], ${col('active', (v) => v !== false)}::bool[]
        )
        ON CONFLICT (name) DO UPDATE SET category=EXCLUDED.category`;
      const all45Names = CATALOG.filter((c) => c.all45).map((c) => c.name);
      let assigned = 0;
      if (all45Names.length) {
        await db`
          INSERT INTO task_template_locations (template_id, store_pc)
          SELECT t.id, pc
          FROM task_templates t
          CROSS JOIN unnest(${all45}::text[]) AS pc
          WHERE t.name = ANY(${all45Names}::text[])
          ON CONFLICT DO NOTHING`;
        assigned = all45Names.length * all45.length;
      }
      return reply(200, { ok: true, templates: CATALOG.length, assignments: assigned });
    }

    if (action === 'seed_items') {
      let totalTemplates = 0, totalItems = 0;
      for (const entry of ITEMS_CATALOG) {
        const templates = entry.matchType === 'prefix'
          ? await db`SELECT id FROM task_templates WHERE name LIKE ${entry.namePattern + '%'}`
          : await db`SELECT id FROM task_templates WHERE name = ${entry.namePattern}`;

        for (const tmpl of templates) {
          // Replace items for this template
          await db`DELETE FROM task_template_items WHERE template_id = ${tmpl.id}`;
          for (let i = 0; i < (entry.items || []).length; i++) {
            const it = entry.items[i];
            await db`
              INSERT INTO task_template_items (template_id, label, sort_order, input_type, group_name, target, min_val, max_val, unit, requires_photo)
              VALUES (${tmpl.id}, ${it.label}, ${i}, ${it.input_type || 'bool'}, ${it.group_name || null}, ${it.target ?? null}, ${it.min_val ?? null}, ${it.max_val ?? null}, ${it.unit || null}, ${!!it.requires_photo})`;
          }
          // Always replace equipment (unconditional delete clears stale rows when catalog entry removes equipment)
          await db`DELETE FROM task_template_equipment WHERE template_id = ${tmpl.id}`;
          for (let i = 0; i < (entry.equipment || []).length; i++) {
            await db`INSERT INTO task_template_equipment (template_id, unit_name, sort_order) VALUES (${tmpl.id}, ${entry.equipment[i]}, ${i})`;
          }
          totalTemplates++;
          totalItems += (entry.items || []).length;
        }
      }
      return reply(200, { ok: true, templates: totalTemplates, items: totalItems });
    }

    return reply(400, { error: 'unknown action: ' + action });
  } catch (e) {
    console.error('[tasks] error:', e.message);
    return reply(500, { error: 'server error', detail: e.message });
  }
};
