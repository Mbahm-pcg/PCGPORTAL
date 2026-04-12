// PCG Portal — Email Notifications via Resend
// Sends email alerts for project phase changes, deadlines, and new projects

const https = require('https');

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

  const { to, subject, body: htmlBody, attachments } = payload;
  if (!to || !subject || !htmlBody) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing to, subject, or body' }) };
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_API_KEY not configured' }) };
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
    emailPayload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: a.content,
    }));
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
        resolve({
          statusCode: res.statusCode < 300 ? 200 : 500,
          headers,
          body: raw,
        });
      });
    });

    req.on('error', (err) => {
      resolve({ statusCode: 500, headers, body: JSON.stringify({ error: err.message }) });
    });

    req.write(emailData);
    req.end();
  });
};
