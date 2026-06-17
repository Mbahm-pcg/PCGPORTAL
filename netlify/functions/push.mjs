// PCG Portal — Push Notifications via Web Push
// Manages push subscriptions (in Netlify Blobs) and sends push messages

import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

const SUBS_KEY = 'pcg_push_subscriptions_v1';

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  let payload;
  try { payload = await request.json().catch(() => ({})); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }

  const { action } = payload;
  if (!action) return new Response(JSON.stringify({ error: 'Missing action' }), { status: 400, headers });

  // Configure VAPID
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:noreply@pcgops.com';

  if (!vapidPublic || !vapidPrivate) {
    return new Response(JSON.stringify({ error: 'VAPID keys not configured' }), { status: 500, headers });
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  // Get Blobs store
  const store = getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token: process.env.PCG_AUTH_TOKEN,
  });

  try {
    // Load existing subscriptions
    async function loadSubs() {
      const result = await store.get(SUBS_KEY, { type: 'json' });
      return (result && result.data) ? result.data : {};
    }

    async function saveSubs(subs) {
      await store.setJSON(SUBS_KEY, { savedAt: new Date().toISOString(), data: subs });
    }

    // ── SUBSCRIBE ──────────────────────────────────────────────
    if (action === 'subscribe') {
      const { userId, subscription } = payload;
      if (!userId || !subscription || !subscription.endpoint) {
        return new Response(JSON.stringify({ error: 'Missing userId or subscription' }), { status: 400, headers });
      }

      const subs = await loadSubs();
      if (!subs[userId]) subs[userId] = [];

      // Deduplicate by endpoint
      const exists = subs[userId].some(s => s.endpoint === subscription.endpoint);
      if (!exists) {
        subs[userId].push(subscription);
        await saveSubs(subs);
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    // ── UNSUBSCRIBE ────────────────────────────────────────────
    if (action === 'unsubscribe') {
      const { userId, endpoint } = payload;
      if (!userId || !endpoint) {
        return new Response(JSON.stringify({ error: 'Missing userId or endpoint' }), { status: 400, headers });
      }

      const subs = await loadSubs();
      if (subs[userId]) {
        subs[userId] = subs[userId].filter(s => s.endpoint !== endpoint);
        if (subs[userId].length === 0) delete subs[userId];
        await saveSubs(subs);
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    // ── SEND ───────────────────────────────────────────────────
    if (action === 'send') {
      const { userIds, title, body: msgBody, url, tag } = payload;
      if (!userIds || !Array.isArray(userIds) || !title) {
        return new Response(JSON.stringify({ error: 'Missing userIds or title' }), { status: 400, headers });
      }

      const subs = await loadSubs();
      let sent = 0, failed = 0, expired = 0;
      const expiredEndpoints = [];

      const pushPayload = JSON.stringify({
        title,
        body: msgBody || '',
        icon: '/apple-touch-icon.png',
        url: url || '/',
        tag: tag || undefined,
      });

      const promises = [];
      for (const uid of userIds) {
        const userSubs = subs[uid];
        if (!userSubs || userSubs.length === 0) continue;

        for (const sub of userSubs) {
          promises.push(
            webpush.sendNotification(sub, pushPayload)
              .then(() => { sent++; })
              .catch((err) => {
                if (err.statusCode === 410 || err.statusCode === 404) {
                  expired++;
                  expiredEndpoints.push({ userId: uid, endpoint: sub.endpoint });
                } else {
                  failed++;
                  console.warn('Push send error:', err.statusCode, err.message);
                }
              })
          );
        }
      }

      await Promise.all(promises);

      // Clean up expired subscriptions
      if (expiredEndpoints.length > 0) {
        for (const { userId, endpoint } of expiredEndpoints) {
          if (subs[userId]) {
            subs[userId] = subs[userId].filter(s => s.endpoint !== endpoint);
            if (subs[userId].length === 0) delete subs[userId];
          }
        }
        await saveSubs(subs);
      }

      return new Response(JSON.stringify({ ok: true, sent, failed, expired }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers });

  } catch (err) {
    console.error('Push function error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
