// PCG Deal Pipeline — authenticated document store with version history.
// Confidential deal documents (LOI, lease/PSA, title, Phase I, etc.) are stored in a
// SEPARATE blob store ('pcg-deals') that the public, unauthenticated storage.js function
// cannot read — every read/write here requires a valid deal session token + role.
// Large files are chunked (≤4 MB base64 per chunk) to stay under the function size limit.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { verifyToken } from './deal-lib/token.js';
import { roleSatisfies } from './deal-lib/roles.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const reply = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: cors });

function authUser(request) {
  const raw = request.headers.get('authorization') || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  // No `|| ''` fallback — fail closed if the secret is unset (the handler also guards this).
  return verifyToken(token, process.env.DEAL_SESSION_SECRET);
}

// Isolated store — NOT 'pcg-portal', so storage.js (no auth) cannot serve these blobs.
function dealStore() {
  return getStore({ name: 'pcg-deals', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

const safeKey = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '');

// Conservative server-side allowlist for deal documents. Validated on finalize so a
// client can't store arbitrary/executable content in the confidential deal blob store.
// Permissive enough for the real workflow: PDFs, common images, Office docs, text/CSV.
const ALLOWED_EXT = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif',
  'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv',
]);
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain', 'text/csv', 'application/csv',
]);
// Accept if EITHER the extension OR the declared MIME is on the allowlist (browsers are
// inconsistent about MIME for Office/HEIC files, so requiring both would break real uploads).
function isAllowedFile(filename, mime) {
  const ext = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (ext && ALLOWED_EXT.has(ext[1])) return true;
  if (mime && ALLOWED_MIME.has(String(mime).toLowerCase())) return true;
  return false;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (!process.env.DEAL_SESSION_SECRET) return reply(500, { error: 'server not configured' });
  const user = authUser(request);
  if (!user) return reply(401, { error: 'unauthorized' });
  if (!roleSatisfies(user.role, 'view')) return reply(403, { error: 'forbidden' }); // explicit read gate

  let body; try { body = await request.json(); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action;
  const db = sql();
  const store = dealStore();
  const needWrite = ['createDoc', 'uploadChunk', 'finalizeVersion'].includes(action);
  if (needWrite && !roleSatisfies(user.role, 'edit')) return reply(403, { error: 'read-only access' });

  try {
    // List a deal's documents with their versions (newest version first).
    if (action === 'list') {
      const docs = await db`SELECT * FROM deal_documents WHERE deal_id = ${body.deal_id} ORDER BY created_at`;
      const versions = await db`
        SELECT v.* FROM deal_document_versions v
        JOIN deal_documents d ON d.id = v.document_id
        WHERE d.deal_id = ${body.deal_id}
        ORDER BY v.document_id, v.version_no DESC`;
      return reply(200, { docs, versions });
    }

    // Create a logical document (LOI, lease_psa, etc.) — versions are uploaded into it.
    if (action === 'createDoc') {
      const [doc] = await db`
        INSERT INTO deal_documents (deal_id, doc_type, title)
        VALUES (${body.deal_id}, ${body.doc_type || 'other'}, ${body.title || null})
        RETURNING *`;
      return reply(200, { doc });
    }

    // Receive one base64 chunk for an in-progress upload. blobKey is client-generated.
    if (action === 'uploadChunk') {
      const key = safeKey(body.blobKey);
      if (!key || typeof body.chunk !== 'string') return reply(400, { error: 'blobKey + chunk required' });
      await store.set(`${key}_c${Number(body.index) || 0}`, body.chunk);
      return reply(200, { ok: true });
    }

    // Finalize: record the version row + write the assembly metadata blob.
    if (action === 'finalizeVersion') {
      const key = safeKey(body.blobKey);
      if (!key || !body.document_id) return reply(400, { error: 'document_id + blobKey required' });
      // Reject disallowed file types before recording a version row.
      if (!isAllowedFile(body.filename, body.type)) {
        return reply(400, { error: 'unsupported file type — allowed: PDF, images (png/jpg/gif/webp/heic), Word, Excel, txt, csv' });
      }
      const [{ next }] = await db`
        SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM deal_document_versions WHERE document_id = ${body.document_id}`;
      // Server-derive the MIME + data-URL prefix (don't trust client prefix); clamp chunk count.
      const mime = /^[\w.+-]+\/[\w.+-]+$/.test(body.type || '') ? body.type : 'application/octet-stream';
      const chunks = Math.min(Math.max(1, Number(body.chunks) || 1), 512);
      await store.setJSON(`${key}_meta`, {
        filename: String(body.filename || '').slice(0, 255), type: mime,
        size: Number(body.size) || 0, chunks, prefix: `data:${mime};base64,`,
      });
      const [version] = await db`
        INSERT INTO deal_document_versions (document_id, version_no, blob_key, filename, size, uploaded_by)
        VALUES (${body.document_id}, ${next}, ${key}, ${body.filename || null}, ${body.size || null}, ${user.username})
        RETURNING *`;
      return reply(200, { version });
    }

    // Download a specific version — assemble the chunks and return a data URL.
    if (action === 'download') {
      const [v] = await db`SELECT * FROM deal_document_versions WHERE id = ${body.version_id}`;
      if (!v) return reply(404, { error: 'version not found' });
      const meta = await store.get(`${v.blob_key}_meta`, { type: 'json' });
      if (!meta) return reply(404, { error: 'blob missing' });
      const parts = [];
      for (let i = 0; i < (meta.chunks || 1); i++) {
        const c = await store.get(`${v.blob_key}_c${i}`);
        if (c == null) return reply(404, { error: `chunk ${i} missing` });
        parts.push(c);
      }
      const dataUrl = (meta.prefix || 'data:application/octet-stream;base64,') + parts.join('');
      return reply(200, { filename: meta.filename, type: meta.type, size: meta.size, dataUrl });
    }

    return reply(400, { error: 'unknown action' });
  } catch (e) {
    return reply(500, { error: 'server error' });
  }
};
