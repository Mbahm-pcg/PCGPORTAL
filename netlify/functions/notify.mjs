// PCG Portal — Email Notifications via Resend
// Sends email alerts for project phase changes, deadlines, and new projects

import https from 'node:https';

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

  const { to, subject, body: htmlBody, attachments } = payload;
  if (!to || !subject || !htmlBody) {
    return new Response(JSON.stringify({ error: 'Missing to, subject, or body' }), { status: 400, headers });
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    return new Response(JSON.stringify({ error: 'RESEND_API_KEY not configured' }), { status: 500, headers });
  }

  const FROM = process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>';

  const emailPayload = {
    from: FROM,
    to: Array.isArray(to) ? to : [to],
    subject,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #FF671F; padding: 16px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="color: #fff; margin: 0; font-size: 18px;">People Capital Group</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 8px 8px;">
          ${htmlBody}
          <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
          <p style="color: #999; font-size: 12px;">This is an automated notification from People Capital Group Portal.</p>
        </div>
      </div>
    `,
  };

  if (attachments && Array.isArray(attachments) && attachments.length > 0) {
    emailPayload.attachments = attachments.map(a => {
      const att = { filename: a.filename, content: a.content };
      if (a.content_type) att.content_type = a.content_type;
      if (a.content_id) att.content_id = a.content_id;
      if (a.content_disposition) att.content_disposition = a.content_disposition;
      return att;
    });
  }

  const emailData = JSON.stringify(emailPayload);

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.resend.com',
      port: 443,
      path: '/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Length': Buffer.byteLength(emailData),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        resolve(new Response(raw, {
          status: res.statusCode < 300 ? 200 : 500,
          headers,
        }));
      });
    });

    req.on('error', (err) => {
      resolve(new Response(JSON.stringify({ error: err.message }), { status: 500, headers }));
    });

    req.write(emailData);
    req.end();
  });
};
