// incident-report-drive.mjs — backs up an Incident Report's PDF + evidence
// to a Google Shared Drive, one subfolder per store. Fire-and-forget from
// the client's side (called right after a successful report create) —
// never blocks or reflects back onto the report's own success/failure.
// Failures here log server-side AND write a bell notification to exec/IT
// (type: incident_report_drive_backup_failed) so a silent, ongoing failure
// doesn't go unnoticed.
import { google } from 'googleapis';
import { getStore } from '@netlify/blobs';
import { neon } from '@neondatabase/serverless';
import { Readable } from 'node:stream';
import { requireActiveUser } from './auth-lib/require-user.js';
import { buildFolderFindQuery, buildFolderCreateParams, buildFileUploadParams } from '../../src/incident-report-drive.mjs';

const SHARED_DRIVE_ID = '1A2aYyLns90Qv1LqgxZ8HQhxUW9epiP5r';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

let _sql = null;
const db = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

function getBlobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

// Separate GoogleAuth instance from kb-sync.mjs's read-only one — same
// credential (GOOGLE_SERVICE_ACCOUNT_KEY), different scope (write, not
// read), different client instance. kb-sync.mjs is untouched by this.
function getDriveClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var not set');
  const credentials = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return google.drive({ version: 'v3', auth });
}

// Reassembles a chunked file (same {key}_meta + {key}_c{i} shape this app
// already uses for ticket photos/videos and deal docs) into a Buffer.
async function readChunkedFile(store, key) {
  const meta = await store.get(`${key}_meta`, { type: 'json' });
  if (!meta) throw new Error(`blob missing: ${key}_meta`);
  const parts = [];
  for (let i = 0; i < (meta.chunks || 1); i++) {
    const c = await store.get(`${key}_c${i}`);
    if (c == null) throw new Error(`chunk ${i} missing for ${key}`);
    parts.push(c);
  }
  return { buffer: Buffer.from(parts.join(''), 'base64'), name: meta.name, type: meta.type };
}

async function findOrCreateStoreFolder(drive, storeName) {
  const findRes = await drive.files.list(buildFolderFindQuery(storeName, SHARED_DRIVE_ID));
  const existing = findRes.data.files && findRes.data.files[0];
  if (existing) return existing.id;
  const createRes = await drive.files.create(buildFolderCreateParams(storeName, SHARED_DRIVE_ID));
  return createRes.data.id;
}

async function uploadFile(drive, store, { fileKey, name, mimeType, parentFolderId }) {
  const { buffer } = await readChunkedFile(store, fileKey);
  const params = buildFileUploadParams({ name, mimeType, parentFolderId });
  params.media.body = Readable.from(buffer);
  const res = await drive.files.create(params);
  return res.data.id;
}

async function notifyDriveBackupFailed(store, { reportId, storeName, error }) {
  try {
    const existing = await store.get('pcg_notifications_v1', { type: 'json' });
    const list = Array.isArray(existing) ? existing : (existing?.data || []);
    const entry = {
      id: `incidentdrive_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type: 'incident_report_drive_backup_failed',
      message: `Drive backup failed for Incident Report #${reportId} (${storeName}): ${error}`,
      read: false, createdAt: new Date().toISOString(),
    };
    await store.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [entry, ...list].slice(0, 500) });
  } catch (e) { console.warn('[incident-report-drive] failure-notification write failed:', e.message); }
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  const { action } = payload || {};
  if (action !== 'backup') return json(400, { error: `Unknown action: ${action}` });

  const sql = db();
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql);
  if (!caller) return json(401, { error: 'Sign in required.' });

  const { reportId, storeName, pdfKey, attachments } = payload;
  if (!reportId || !storeName || !pdfKey) return json(400, { error: 'Missing reportId, storeName, or pdfKey' });

  const blobStore = getBlobStore();
  const uploaded = [];
  const failed = [];

  try {
    const drive = getDriveClient();
    const folderId = await findOrCreateStoreFolder(drive, storeName);

    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      await uploadFile(drive, blobStore, { fileKey: pdfKey, name: `Incident-Report-${reportId}-${dateStr}.pdf`, mimeType: 'application/pdf', parentFolderId: folderId });
      uploaded.push(pdfKey);
    } catch (e) { failed.push({ key: pdfKey, error: e.message }); }

    for (const a of (attachments || [])) {
      try {
        await uploadFile(drive, blobStore, { fileKey: a.fileKey, name: a.name, mimeType: a.mimeType, parentFolderId: folderId });
        uploaded.push(a.fileKey);
      } catch (e) { failed.push({ key: a.fileKey, error: e.message }); }
    }
  } catch (e) {
    // Couldn't even get a Drive client or find/create the folder — everything failed.
    console.error('[incident-report-drive] backup failed entirely:', e.message);
    await notifyDriveBackupFailed(blobStore, { reportId, storeName, error: e.message });
    return json(200, { ok: false, uploaded, failed: [{ key: 'all', error: e.message }] });
  }

  if (failed.length) {
    console.error('[incident-report-drive] partial failure:', JSON.stringify(failed));
    await notifyDriveBackupFailed(blobStore, { reportId, storeName, error: failed.map(f => `${f.key}: ${f.error}`).join('; ') });
  }

  return json(200, { ok: failed.length === 0, uploaded, failed });
};
