// PCG Portal — SMS Notifications via Twilio
// Sends SMS alerts for project changes, deadlines, chat mentions

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

  const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
  const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER;

  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Twilio credentials not configured' }) };
  }

  // Send to one or multiple phone numbers
  const numbers = Array.isArray(to) ? to : [to];
  const results = [];

  for (const number of numbers) {
    // Normalize phone number — strip formatting, ensure +1 prefix for US
    let cleaned = number.replace(/\D/g, '');
    if (cleaned.length === 10) cleaned = '1' + cleaned;
    if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;

    const postData = new URLSearchParams({
      To: cleaned,
      From: FROM_NUMBER,
      Body: message,
    }).toString();

    const result = await new Promise((resolve) => {
      const options = {
        hostname: 'api.twilio.com',
        port: 443,
        path: `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64'),
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          resolve({ number: cleaned, statusCode: res.statusCode, response: raw });
        });
      });

      req.on('error', (err) => {
        resolve({ number: cleaned, statusCode: 500, error: err.message });
      });

      req.write(postData);
      req.end();
    });

    results.push(result);
  }

  const allOk = results.every(r => r.statusCode >= 200 && r.statusCode < 300);
  return {
    statusCode: allOk ? 200 : 207,
    headers,
    body: JSON.stringify({ results }),
  };
};
