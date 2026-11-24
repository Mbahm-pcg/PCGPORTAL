// PCG Portal — Project Photo Gallery, backed by Neon Postgres. One row per
// photo; the photo itself is a separate small Netlify Blob referenced by
// image_key (same wrapper shape every other blob in this app uses). See
// docs/superpowers/specs/2026-09-07-project-gallery-design.md.
//
// Access is deliberately narrower than the Expenses feature: every action
// requires construction/executive/it — no other role, even with a valid
// session, may call this endpoint at all.
//
// Actions (POST { action, ... }):
//   create { projectId, projectNickname, lat?, lng?, imageBase64 } → { ok, photo }
//   list   { projectId } → { ok, photos:[…] }
//   saveAnnotations { id, annotations } → { ok, photo }
//   delete { id } → { ok }
//   migrateFromDailyReports { projectId, projectNickname, photos:[{sourceRef,dataUrl,name,timestamp,addedBy}] }
//     → { ok, imported, skipped }  (executive/it only; idempotent per sourceRef)
//
// Daily Report photos (v23.11) — each report photo is uploaded on its own instead of all
// of a report's photos travelling in one blob. Open to everyone who can edit projects
// (REPORT_PHOTO_ROLES: adds office_staff to the gallery roles):
//   createForReport { projectId, projectNickname, reportId, fileName, imageBase64, mediumBase64 }
//     → { ok, photo }   two blobs: full (1600px) at image_key, medium (800px) at med_key
//   removeFromReport { ids:[] } → { ok, removed }   soft delete (deleted_at); the nightly
//     reports-backup run purges rows + blobs 30 days later
// See docs/superpowers/specs/2026-11-21-daily-report-photos-design.md.
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { canAccessProjectGallery, sanitizeAnnotations } from './project-photos-lib/shapes.mjs';
import { canUploadReportPhotos } from '../../src/report-photos.mjs';

const REPORT_ACTIONS = new Set(['createForReport', 'removeFromReport']);
const MAX_IMAGE_CHARS = 4 * 1024 * 1024; // one photo's data URL — far under the ~6 MB request cap
const isImageDataUrl = (s) => typeof s === 'string' && s.startsWith('data:image/') && s.length > 64 && s.length <= MAX_IMAGE_CHARS;

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
  await sql`CREATE TABLE IF NOT EXISTS project_photos (
    id                text PRIMARY KEY,
    project_id        integer NOT NULL,
    project_nickname  text,
    lat               double precision,
    lng               double precision,
    taken_by_user_id  integer NOT NULL,
    taken_by_name     text NOT NULL,
    user_type         text NOT NULL,
    image_key         text NOT NULL,
    annotations       jsonb NOT NULL DEFAULT '[]'::jsonb,
    source            text NOT NULL DEFAULT 'capture',
    source_ref        text,
    created_at        timestamptz DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pphoto_project ON project_photos(project_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_pphoto_source_ref ON project_photos(source_ref) WHERE source_ref IS NOT NULL`;
  // v23.11 — Daily Report photos
  await sql`ALTER TABLE project_photos ADD COLUMN IF NOT EXISTS med_key text`;
  await sql`ALTER TABLE project_photos ADD COLUMN IF NOT EXISTS report_id text`;
  await sql`ALTER TABLE project_photos ADD COLUMN IF NOT EXISTS file_name text`;
  await sql`ALTER TABLE project_photos ADD COLUMN IF NOT EXISTS deleted_at timestamptz`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pphoto_report ON project_photos(report_id) WHERE report_id IS NOT NULL`;
  await sql`ALTER TABLE project_photos ADD COLUMN IF NOT EXISTS client_ref text`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_pphoto_client_ref ON project_photos(client_ref) WHERE client_ref IS NOT NULL`;
  _ready = true;
}

function rowToPhoto(r) {
  return {
    id: r.id,
    projectId: r.project_id,
    projectNickname: r.project_nickname,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    takenByUserId: r.taken_by_user_id,
    takenByName: r.taken_by_name,
    userType: r.user_type,
    imageKey: r.image_key,
    medKey: r.med_key || null,
    reportId: r.report_id || null,
    fileName: r.file_name || null,
    annotations: r.annotations || [],
    source: r.source,
    sourceRef: r.source_ref,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function genId(prefix = 'pphoto') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function saveBlob(id, dataUrl, addedBy, suffix = '') {
  const key = `pcg_project_photo_${id}${suffix}`;
  await blobStore().setJSON(key, {
    savedAt: new Date().toISOString(),
    data: { base64: dataUrl, addedBy, addedAt: new Date().toISOString() },
  });
  return key;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (!action) return json(400, { error: 'Missing action' });

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
    const allowed = REPORT_ACTIONS.has(action) ? canUploadReportPhotos(claims.userType) : canAccessProjectGallery(claims.userType);
    if (!allowed) return json(403, { error: 'Not available for this role' });

    if (action === 'createForReport') {
      const projectId = Number(payload.projectId);
      if (!Number.isFinite(projectId)) return json(400, { error: 'projectId required' });
      if (!isImageDataUrl(payload.imageBase64)) return json(400, { error: 'imageBase64 must be an image data URL under 4 MB' });
      if (!isImageDataUrl(payload.mediumBase64)) return json(400, { error: 'mediumBase64 must be an image data URL under 4 MB' });
      // Idempotent on clientRef: a retry after a lost reply returns the photo already saved
      // (scoped to the same uploader) instead of creating a second copy.
      const clientRef = typeof payload.clientRef === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(payload.clientRef) ? payload.clientRef : null;
      if (clientRef) {
        const dup = await sql`SELECT * FROM project_photos WHERE client_ref = ${clientRef} AND taken_by_user_id = ${claims.sub}`;
        if (dup.length) return json(200, { ok: true, photo: rowToPhoto(dup[0]) });
      }
      const id = genId();
      const by = claims.name || claims.username;
      const [imageKey, medKey] = await Promise.all([
        saveBlob(id, payload.imageBase64, by),
        saveBlob(id, payload.mediumBase64, by, '_med'),
      ]);
      const reportId = payload.reportId != null ? String(payload.reportId).slice(0, 64) : null;
      const fileName = payload.fileName ? String(payload.fileName).slice(0, 200) : null;
      try {
        const rows = await sql`
          INSERT INTO project_photos (
            id, project_id, project_nickname, taken_by_user_id, taken_by_name, user_type,
            image_key, med_key, report_id, file_name, source, client_ref
          ) VALUES (
            ${id}, ${projectId}, ${payload.projectNickname || null}, ${claims.sub}, ${by}, ${claims.userType},
            ${imageKey}, ${medKey}, ${reportId}, ${fileName}, 'daily_report', ${clientRef}
          ) RETURNING *`;
        return json(200, { ok: true, photo: rowToPhoto(rows[0]) });
      } catch (e) {
        // no row → nothing references the blobs; don't leave them behind
        await Promise.all([blobStore().delete(imageKey).catch(() => {}), blobStore().delete(medKey).catch(() => {})]);
        throw e;
      }
    }

    if (action === 'removeFromReport') {
      const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter(Boolean).slice(0, 500);
      if (!ids.length) return json(200, { ok: true, removed: 0 });
      const rows = await sql`
        UPDATE project_photos SET deleted_at = now()
        WHERE id = ANY(${ids}) AND source = 'daily_report' AND deleted_at IS NULL
        RETURNING id`;
      return json(200, { ok: true, removed: rows.length });
    }

    if (action === 'create') {
      const projectId = Number(payload.projectId);
      if (!Number.isFinite(projectId)) return json(400, { error: 'projectId required' });
      if (!payload.imageBase64) return json(400, { error: 'imageBase64 required' });
      const id = genId();
      const submittedByName = claims.name || claims.username;
      const imageKey = await saveBlob(id, payload.imageBase64, submittedByName);
      const lat = Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : null;
      const lng = Number.isFinite(Number(payload.lng)) ? Number(payload.lng) : null;
      const rows = await sql`
        INSERT INTO project_photos (
          id, project_id, project_nickname, lat, lng,
          taken_by_user_id, taken_by_name, user_type, image_key
        ) VALUES (
          ${id}, ${projectId}, ${payload.projectNickname || null}, ${lat}, ${lng},
          ${claims.sub}, ${submittedByName}, ${claims.userType}, ${imageKey}
        ) RETURNING *`;
      return json(200, { ok: true, photo: rowToPhoto(rows[0]) });
    }

    if (action === 'list') {
      const projectId = Number(payload.projectId);
      if (!Number.isFinite(projectId)) return json(400, { error: 'projectId required' });
      const rows = await sql`SELECT * FROM project_photos WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY created_at DESC`;
      return json(200, { ok: true, photos: rows.map(rowToPhoto) });
    }

    // "Recent projects" for the setup screen — real activity (an actual photo
    // exists), shared across every user/device, not a per-device click log.
    // A project nobody has photographed yet just never shows up here.
    if (action === 'listRecentProjects') {
      const limit = Number.isFinite(Number(payload.limit)) ? Math.min(20, Number(payload.limit)) : 4;
      const rows = await sql`
        SELECT project_id, MAX(project_nickname) AS project_nickname, MAX(created_at) AS last_activity
        FROM project_photos
        WHERE deleted_at IS NULL
        GROUP BY project_id
        ORDER BY last_activity DESC
        LIMIT ${limit}`;
      return json(200, { ok: true, recent: rows.map(r => ({ projectId: r.project_id, projectNickname: r.project_nickname, lastActivity: r.last_activity ? new Date(r.last_activity).toISOString() : null })) });
    }

    if (action === 'saveAnnotations') {
      const id = payload.id != null ? String(payload.id) : null;
      if (!id) return json(400, { error: 'id required' });
      const clean = sanitizeAnnotations(payload.annotations);
      const rows = await sql`UPDATE project_photos SET annotations = ${JSON.stringify(clean)}::jsonb WHERE id = ${id} RETURNING *`;
      if (!rows.length) return json(404, { error: 'Not found' });
      return json(200, { ok: true, photo: rowToPhoto(rows[0]) });
    }

    if (action === 'delete') {
      const id = payload.id != null ? String(payload.id) : null;
      if (!id) return json(400, { error: 'id required' });
      const rows = await sql`SELECT * FROM project_photos WHERE id = ${id}`;
      if (!rows.length) return json(404, { error: 'Not found' });
      // A Daily Report photo is never hard-deleted here, even after it was removed from its
      // report: a stale copy of the report can still point at it, and only the nightly purge
      // (reports-backup.mjs) checks that before deleting for good.
      if (rows[0].source === 'daily_report') {
        return json(409, { error: 'This photo belongs to a Daily Report. Remove it from the report instead.' });
      }
      await blobStore().delete(rows[0].image_key).catch(() => {});
      if (rows[0].med_key) await blobStore().delete(rows[0].med_key).catch(() => {});
      await sql`DELETE FROM project_photos WHERE id = ${id}`;
      return json(200, { ok: true });
    }

    if (action === 'migrateFromDailyReports') {
      // No extra role check here — the top-level canAccessProjectGallery
      // gate above already covers this action. It's now an automatic
      // background sync (making photos that already exist visible), not a
      // privileged bulk operation, so it's open to any gallery role.
      const projectId = Number(payload.projectId);
      if (!Number.isFinite(projectId)) return json(400, { error: 'projectId required' });
      const photos = Array.isArray(payload.photos) ? payload.photos : [];
      let imported = 0, skipped = 0, missingData = 0;
      for (const p of photos) {
        if (!p?.sourceRef || !p?.dataUrl) { missingData++; continue; }
        const existing = await sql`SELECT id FROM project_photos WHERE source_ref = ${p.sourceRef}`;
        if (existing.length) { skipped++; continue; }
        const id = genId();
        const imageKey = await saveBlob(id, p.dataUrl, p.addedBy || 'Daily Report');
        await sql`
          INSERT INTO project_photos (
            id, project_id, project_nickname, taken_by_user_id, taken_by_name,
            user_type, image_key, source, source_ref, created_at
          ) VALUES (
            ${id}, ${projectId}, ${payload.projectNickname || null}, ${claims.sub}, ${p.addedBy || 'Daily Report'},
            ${claims.userType}, ${imageKey}, 'migrated', ${p.sourceRef}, ${p.timestamp || new Date().toISOString()}
          )
          ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING`;
        imported++;
      }
      return json(200, { ok: true, imported, skipped, missingData });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('project-photos.mjs error:', err);
    return json(500, { error: err.message });
  }
};
