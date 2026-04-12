// PCG Portal — Push Notifications via Web Push
// Manages push subscriptions (in Netlify Blobs) and sends push messages

const webpush = require('web-push');
const { getStore } = require('@netlify/blobs');

const SUBS_KEY = 'pcg_push_subscriptions_v1';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action } = payload;
  if (!action) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing action' }) };

  // Configure VAPID
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:noreply@pcgops.com';

  if (!vapidPublic || !vapidPrivate) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'VAPID keys not configured' }) };
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
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing userId or subscription' }) };
      }

      const subs = await loadSubs();
      if (!subs[userId]) subs[userId] = [];

      // Deduplicate by endpoint
      const exists = subs[userId].some(s => s.endpoint === subscription.endpoint);
      if (!exists) {
        subs[userId].push(subscription);
        await saveSubs(subs);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── UNSUBSCRIBE ────────────────────────────────────────────
    if (action === 'unsubscribe') {
      const { userId, endpoint } = payload;
      if (!userId || !endpoint) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing userId or endpoint' }) };
      }

      const subs = await loadSubs();
      if (subs[userId]) {
        subs[userId] = subs[userId].filter(s => s.endpoint !== endpoint);
        if (subs[userId].length === 0) delete subs[userId];
        await saveSubs(subs);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    // ── SEND ───────────────────────────────────────────────────
    if (action === 'send') {
      const { userIds, title, body: msgBody, url, tag } = payload;
      if (!userIds || !Array.isArray(userIds) || !title) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing userIds or title' }) };
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

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent, failed, expired }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action: ${action}` }) };

  } catch (err) {
    console.error('Push function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
