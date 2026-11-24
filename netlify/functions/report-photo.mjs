// report-photo.mjs — one Daily Report photo, full size, WITHOUT sign-in (v23.14).
// Every photo in a report PDF is a link to this, so whoever was sent the PDF can open the
// full-size picture. GET ?t=<64-hex share token> — the token is the credential; it is made
// by project-photos.mjs `shareLinks` (signed in, report roles) when a PDF is built, and is
// unrelated to the photo's id. A photo removed from its report stops being served.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { isValidToken } from '../../src/report-pdf-chunks.mjs';

const notFound = () => new Response('This photo link is not valid.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const store = () => getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
const IMAGE = /^data:(image\/(?:jpeg|png|webp));base64,/;

export default async (request) => {
  if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
  try {
    const token = new URL(request.url).searchParams.get('t');
    if (!isValidToken(token)) return notFound();
    const rows = await sql()`SELECT image_key, file_name FROM project_photos WHERE share_token = ${token} AND source = 'daily_report' AND deleted_at IS NULL`;
    if (!rows.length) return notFound();
    const blob = await store().get(rows[0].image_key, { type: 'json' }).catch(() => null);
    const dataUrl = blob?.data?.base64;
    const m = typeof dataUrl === 'string' ? IMAGE.exec(dataUrl) : null;
    if (!m) return notFound();
    const name = String(rows[0].file_name || 'photo').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 80) || 'photo';
    return new Response(Buffer.from(dataUrl.slice(m[0].length), 'base64'), {
      status: 200,
      headers: {
        'Content-Type': m[1],
        'Content-Disposition': `inline; filename="${name}"`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex',
      },
    });
  } catch (e) {
    console.error('[report-photo] error:', e.message);
    return new Response('The photo could not be loaded. Try again in a moment.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
};
