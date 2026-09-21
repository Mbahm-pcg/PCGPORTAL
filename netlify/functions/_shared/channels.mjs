// netlify/functions/_shared/channels.mjs
// Best-effort delivery helpers (SMS via Textbelt, email via Resend, web push via VAPID).
// Same patterns as pulse-notify.mjs / system-health-cron.mjs. None of these ever throw,
// so one failing channel can't block the others.
import https from 'node:https';
import webpush from 'web-push';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendSms(numbers, message) {
  const KEY = process.env.TEXTBELT_API_KEY;
  const list = (Array.isArray(numbers) ? numbers : [numbers]).filter(Boolean);
  if (!KEY || !list.length) return { sent: 0, results: [] };
  const results = [];
  for (const number of list) {
    let cleaned = String(number).replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = '1' + cleaned;
    const phone = '+' + cleaned;
    const postData = new URLSearchParams({ phone, message, key: KEY }).toString();
    const r = await new Promise((resolve) => {
      const req = https.request(
        { hostname: 'textbelt.com', port: 443, path: '/text', method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) } },
        (res) => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => { let j = {}; try { j = JSON.parse(raw); } catch {} resolve({ number: phone, success: !!j.success, error: j.error }); }); });
      req.on('error', (e) => resolve({ number: phone, success: false, error: e.message }));
      req.write(postData); req.end();
    });
    results.push(r);
  }
  return { sent: results.filter(r => r.success).length, results };
}

export function sendEmail(to, subject, text) {
  return new Promise((resolve) => {
    const key = process.env.RESEND_API_KEY;
    const list = (to || []).filter(Boolean);
    if (!key || !list.length) return resolve(false);
    const payload = JSON.stringify({
      from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>',
      to: list, subject, html: `<p>${esc(text)}</p>`,
    });
    const req = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode < 300)); });
    req.on('error', () => resolve(false)); req.write(payload); req.end();
  });
}

export async function sendPush(blobStore, userIds, title, body, tag) {
  try {
    if (!userIds.length) return { sent: 0 };
    const vpub = process.env.VAPID_PUBLIC_KEY, vpriv = process.env.VAPID_PRIVATE_KEY;
    if (!vpub || !vpriv) return { sent: 0 };
    const w = await blobStore.get('pcg_push_subscriptions_v1', { type: 'json' });
    const subs = (w && w.data) ? w.data : {};
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:${process.env.VAPID_EMAIL || 'noreply@pcgops.com'}`, vpub, vpriv);
    const payload = JSON.stringify({ title, body: body || '', icon: '/apple-touch-icon.png', url: '/', tag: tag || undefined });
    let sent = 0;
    for (const uid of userIds) for (const sub of (subs[String(uid)] || [])) {
      try { await webpush.sendNotification(sub, payload); sent++; } catch { /* expired subscription */ }
    }
    return { sent };
  } catch { return { sent: 0 }; }
}
