// PCG Portal — Announcement acknowledgments
// Records who has acknowledged each announcement so admins can audit reach.
// One blob per (announcement, user) — ann_acks/{annId}/{userId} — so concurrent
// acknowledgments from different users never race (no read-modify-write).
//   POST { action: 'ack',  annId, userId, name }  → record an acknowledgment
//   POST { action: 'list', annId }                → list everyone who acked

import { getStore } from '@netlify/blobs';

const sanitize = (v) => String(v).replace(/[^a-zA-Z0-9_\-.]/g, '_').slice(0, 80);

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST')   return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  let payload;
  try { payload = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }

  const { action, annId } = payload;
  if (!action || annId == null) return new Response(JSON.stringify({ error: 'Missing action or annId' }), { status: 400, headers });

  const safeAnn = sanitize(annId);

  try {
    const store = getStore({
      name: 'pcg-portal',
      consistency: 'strong',
      siteID: process.env.PCG_SITE_ID,
      token: process.env.PCG_AUTH_TOKEN,
    });

    if (action === 'ack') {
      const { userId, name } = payload;
      if (userId == null) return new Response(JSON.stringify({ error: 'Missing userId' }), { status: 400, headers });
      // Store-wide convention (CLAUDE.md): every blob is wrapped as { savedAt, data }.
      await store.setJSON(`ann_acks/${safeAnn}/${sanitize(userId)}`, {
        savedAt: new Date().toISOString(),
        data: { userId, name: name || null, ts: new Date().toISOString() },
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    if (action === 'list') {
      const { blobs } = await store.list({ prefix: `ann_acks/${safeAnn}/` });
      const raw = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
      // Unwrap the { savedAt, data } envelope; tolerate any legacy unwrapped blobs.
      const acks = raw.filter(Boolean).map(r => r.data || r);
      return new Response(JSON.stringify({ ok: true, acks }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers });

  } catch (err) {
    console.error('ann-ack error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
