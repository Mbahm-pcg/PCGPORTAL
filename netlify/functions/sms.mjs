// PCG Portal — SMS Notifications via Textbelt (https://textbelt.com)
// Sends SMS alerts for project changes, deadlines, chat mentions.
// Contract is unchanged from the previous Twilio version: POST { to, message }
// where `to` is a single phone number or an array of numbers.

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

  const KEY = process.env.TEXTBELT_API_KEY;
  if (!KEY) {
    return new Response(JSON.stringify({ error: 'Textbelt API key not configured' }), { status: 500, headers });
  }

  // Quota check — no SMS sent. GET https://textbelt.com/quota/<key> → { success, quotaRemaining }
  if (payload.action === 'quota') {
    const q = await new Promise((resolve) => {
      https.get(`https://textbelt.com/quota/${encodeURIComponent(KEY)}`, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => { let j = {}; try { j = JSON.parse(raw); } catch {} resolve(j); });
      }).on('error', (err) => resolve({ success: false, error: err.message }));
    });
    return new Response(JSON.stringify({ success: !!q.success, quotaRemaining: q.quotaRemaining, error: q.error }), { status: 200, headers });
  }

  const { to, message } = payload;
  if (!to || !message) {
    return new Response(JSON.stringify({ error: 'Missing to or message' }), { status: 400, headers });
  }

  // Send to one or multiple phone numbers
  const numbers = Array.isArray(to) ? to : [to];
  const results = [];

  for (const number of numbers) {
    // Normalize to E.164 US (+1XXXXXXXXXX). Textbelt also accepts a bare 10-digit number.
    let cleaned = String(number).replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = '1' + cleaned;
    const phone = '+' + cleaned;

    const postData = new URLSearchParams({ phone, message, key: KEY }).toString();

    const result = await new Promise((resolve) => {
      const options = {
        hostname: 'textbelt.com',
        port: 443,
        path: '/text',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          let j = {};
          try { j = JSON.parse(raw); } catch {}
          // Textbelt: { success, textId, quotaRemaining } or { success:false, error }
          resolve({
            number: phone,
            success: !!j.success,
            quotaRemaining: j.quotaRemaining,
            textId: j.textId,
            error: j.error,
          });
        });
      });

      req.on('error', (err) => {
        resolve({ number: phone, success: false, error: err.message });
      });

      req.write(postData);
      req.end();
    });

    results.push(result);
  }

  const allOk = results.every(r => r.success);
  return new Response(JSON.stringify({ provider: 'textbelt', results }), {
    status: allOk ? 200 : 207,
    headers,
  });
};
