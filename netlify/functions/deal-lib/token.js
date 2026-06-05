// PCG Deal Pipeline — signed session token (HMAC-SHA256), pure + testable.
// Format: base64url(JSON body) + "." + base64url(HMAC-SHA256(bodyB64, secret)).
const crypto = require('crypto');

const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function signToken(payload, secret, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const ttl = typeof opts.ttlSeconds === 'number' ? opts.ttlSeconds : 43200;
  const iat = Math.floor(nowMs / 1000);
  const body = { ...payload, iat, exp: iat + ttl };
  const p = b64urlJson(body);
  return `${p}.${hmac(p, secret)}`;
}

function verifyToken(token, secret, opts = {}) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [p, sig] = parts;
  if (!p || !sig) return null;
  const expected = hmac(p, secret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!body || typeof body.exp !== 'number' || Math.floor(nowMs / 1000) >= body.exp) return null;
  return body;
}

module.exports = { signToken, verifyToken };
