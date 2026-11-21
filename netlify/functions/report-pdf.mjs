// report-pdf.mjs — emailed Daily Report PDFs as a link instead of an attachment (v23.00).
// See docs/superpowers/specs/2026-11-21-daily-report-photos-design.md.
//
// POST { action:'put', token?, index, total, chunk, fileName }   signed in, project-edit roles
//   The browser builds the PDF, then uploads it as base64 chunks (≤ 3 MB each, so no request
//   comes near the ~6 MB body cap). The first call (index 0, no token) mints the token; the
//   last chunk writes the meta blob, which is what makes the link live.
//   → { ok, token, done }
// GET ?t=<token>   NO sign-in — the 64-hex token is the credential, so the link can be sent to
//   people outside the company. Streams the PDF back chunk by chunk.
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { canUploadReportPhotos } from '../../src/report-photos.mjs';
import { isValidToken, chunkKey, metaKey, safeFileName, chunkProblem } from '../../src/report-pdf-chunks.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const notFound = () => new Response('This report link is not valid.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const store = () => getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });

async function serve(request) {
  const token = new URL(request.url).searchParams.get('t');
  if (!isValidToken(token)) return notFound();
  const s = store();
  const meta = await s.get(metaKey(token), { type: 'json' }).catch(() => null);
  if (!meta || !Number.isInteger(meta.chunks) || meta.chunks < 1) return notFound();
  let i = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (i >= meta.chunks) { controller.close(); return; }
        const text = await s.get(chunkKey(token, i), { type: 'text' });
        if (typeof text !== 'string') throw new Error(`chunk ${i} missing`);
        controller.enqueue(new Uint8Array(Buffer.from(text, 'base64')));
        i++;
      } catch (e) {
        console.error('[report-pdf] stream error:', e.message);
        controller.error(e);
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safeFileName(meta.fileName)}"`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex',
    },
  });
}

async function put(request) {
  let payload;
  try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
  if (payload?.action !== 'put') return json(400, { error: 'Unknown action' });

  const eventShim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };
  const claims = await requireActiveUser(eventShim, sql());
  if (!claims) return json(401, { error: 'Sign in required' });
  if (!canUploadReportPhotos(claims.userType)) return json(403, { error: 'Not available for this role' });

  const index = Number(payload.index), total = Number(payload.total);
  const problem = chunkProblem({ index, total, chunk: payload.chunk });
  if (problem) return json(400, { error: problem });

  let token = payload.token;
  if (index === 0 && !token) token = crypto.randomBytes(32).toString('hex');
  if (!isValidToken(token)) return json(400, { error: 'token required' });

  const s = store();
  // A finished link is immutable — nobody holding the URL can replace what it serves.
  if (await s.get(metaKey(token), { type: 'json' }).catch(() => null)) return json(409, { error: 'Already uploaded' });
  await s.set(chunkKey(token, index), payload.chunk);
  const done = index === total - 1;
  if (done) {
    await s.setJSON(metaKey(token), {
      chunks: total,
      fileName: safeFileName(payload.fileName),
      uploadedBy: claims.name || claims.username || String(claims.sub),
      uploadedAt: new Date().toISOString(),
    });
  }
  return json(200, { ok: true, token, done });
}

export default async (request) => {
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return await serve(request);
    if (request.method === 'POST') return await put(request);
    return json(405, { error: 'Method Not Allowed' });
  } catch (err) {
    console.error('report-pdf.mjs error:', err);
    return json(500, { error: err.message });
  }
};
