// netlify/functions/minor-timecard-resolve.mjs — manual "Mark Resolved"
// override for exec/it/dm, for the case where Paycor's punch data hasn't
// caught up to a real fix yet (a confirmed real gap — see the Omar Ali/
// Westchester case, 2026-09-29). Restricted to exec/it/dm per the spec.
import { requireActiveUser } from './auth-lib/require-user.js';
import { neon } from '@neondatabase/serverless';
import { getStore } from '@netlify/blobs';

const db = () => neon(process.env.NEON_DATABASE_URL);
function getBlobStore() { return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN }); }

export default async (request) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db());
  if (!caller || !['executive', 'it', 'dm'].includes(caller.userType)) {
    return new Response(JSON.stringify({ error: 'Exec/IT/DM session required.' }), { status: 403, headers });
  }

  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }
  const issueId = body?.issueId;
  if (!issueId) return new Response(JSON.stringify({ error: 'Missing issueId' }), { status: 400, headers });

  const store = getBlobStore();
  const raw = await store.get('pcg_minor_timecard_issues_v1', { type: 'json' });
  const issues = Array.isArray(raw?.data) ? raw.data : [];
  const idx = issues.findIndex(i => i.id === issueId);
  if (idx === -1) return new Response(JSON.stringify({ error: 'Issue not found' }), { status: 404, headers });

  // A DM may only resolve issues for their own district — exec/it can resolve any.
  if (caller.userType === 'dm' && String(issues[idx].district) !== String(caller.district)) {
    return new Response(JSON.stringify({ error: 'Not your district.' }), { status: 403, headers });
  }

  issues[idx] = { ...issues[idx], status: 'manually_resolved', resolvedAt: new Date().toISOString(), resolvedVia: 'manual', resolvedBy: caller.username || caller.sub };
  await store.setJSON('pcg_minor_timecard_issues_v1', { savedAt: new Date().toISOString(), data: issues });

  return new Response(JSON.stringify({ ok: true, issue: issues[idx] }), { status: 200, headers });
};
