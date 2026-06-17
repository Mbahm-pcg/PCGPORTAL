// email-send.mjs — HTTP POST endpoint for sending emails from the portal
import https from 'node:https';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.mjs';
import { logAudit } from './analyst-lib/analyst-audit.mjs';

let nodemailer;
try { nodemailer = (await import('nodemailer')).default; } catch {}

export default async (request, context) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers });

  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers }); }

  const { to, cc, subject, bodyHtml, fromName, userId } = body;
  if (!to || !subject || !bodyHtml) {
    return new Response(JSON.stringify({ error: 'Missing required fields: to, subject, bodyHtml' }), { status: 400, headers });
  }

  // Rate limiting: max 50 sends/day per user
  const today = new Date().toISOString().slice(0, 10);
  const rateKey = `pcg_email_rate_${userId || 'anon'}_${today}`;
  const rateData = await cacheLoad(rateKey) || { count: 0 };
  if (rateData.count >= 50) {
    return new Response(JSON.stringify({ error: 'Daily email limit reached (50/day)' }), { status: 429, headers });
  }

  const FROM_DOMAIN = process.env.SMTP_FROM_DOMAIN || 'peoplecapitalgroup.com';
  const FROM_ADDRESS = fromName ? `${fromName} <ops@${FROM_DOMAIN}>` : `PCG Portal <ops@${FROM_DOMAIN}>`;

  let sent = false;
  let method = '';

  // Try SMTP first
  if (nodemailer && process.env.GOOGLE_SMTP_USER) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.GOOGLE_SMTP_HOST || 'smtp-relay.gmail.com',
        port: parseInt(process.env.GOOGLE_SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.GOOGLE_SMTP_USER, pass: process.env.GOOGLE_SMTP_PASSWORD },
      });
      const mailOptions = { from: FROM_ADDRESS, to, subject, html: bodyHtml };
      if (cc) mailOptions.cc = cc;
      await transporter.sendMail(mailOptions);
      sent = true;
      method = 'smtp';
    } catch (e) {
      console.warn('[email-send] SMTP failed:', e.message);
    }
  }

  // Fallback to Resend
  if (!sent && process.env.RESEND_API_KEY) {
    try {
      const payload = { from: process.env.NOTIFY_FROM || `Orion — PCG <noreply@pcgops.com>`, to: Array.isArray(to) ? to : [to], subject, html: bodyHtml };
      if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
      const resBody = JSON.stringify(payload);
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Length': Buffer.byteLength(resBody) },
        }, (res) => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => resolve(raw)); });
        req.on('error', reject);
        req.write(resBody);
        req.end();
      });
      sent = true;
      method = 'resend';
    } catch (e) {
      console.warn('[email-send] Resend failed:', e.message);
    }
  }

  if (!sent) {
    return new Response(JSON.stringify({ error: 'No email provider available' }), { status: 500, headers });
  }

  // Update rate limit
  rateData.count++;
  await cacheSave(rateKey, rateData);

  // Audit log
  await logAudit({ type: 'email_sent', to, subject, userId, method }).catch(() => {});

  return new Response(JSON.stringify({ ok: true, method }), { status: 200, headers });
};
