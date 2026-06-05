// PCG Portal — SMS Notifications via Textbelt (https://textbelt.com)
// Sends SMS alerts for project changes, deadlines, chat mentions.
// Contract is unchanged from the previous Twilio version: POST { to, message }
// where `to` is a single phone number or an array of numbers.

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

  const { to, message } = payload;
  if (!to || !message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing to or message' }) };
  }

  const KEY = process.env.TEXTBELT_API_KEY;
  if (!KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Textbelt API key not configured' }) };
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
  return {
    statusCode: allOk ? 200 : 207,
    headers,
    body: JSON.stringify({ provider: 'textbelt', results }),
  };
};
