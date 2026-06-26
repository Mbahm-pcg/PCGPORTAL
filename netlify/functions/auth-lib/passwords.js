// passwords.js — scrypt password hashing for portal auth. Pure, no dependencies
// (Node built-in crypto). Format: "scrypt$<saltB64url>$<hashB64url>".
const crypto = require('crypto');

const KEYLEN = 32;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password == null ? '' : password), salt, KEYLEN);
  return `scrypt$${salt.toString('base64url')}$${dk.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], 'base64url');
    expected = Buffer.from(parts[2], 'base64url');
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  let dk;
  try { dk = crypto.scryptSync(String(password == null ? '' : password), salt, expected.length); }
  catch { return false; }
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// True if a stored value is a scrypt hash (vs a legacy plaintext password).
function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('scrypt$');
}

// Password complexity policy: ≥12 chars with a lowercase letter, an uppercase
// letter, a number, and a special character. Single-regex form (used for quick
// client/server gating) plus a granular validator that explains what's missing.
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;

function validatePasswordComplexity(password) {
  const pw = String(password == null ? '' : password);
  if (pw.length < 12) return { ok: false, message: 'Password must be at least 12 characters long.' };
  if (!/[a-z]/.test(pw)) return { ok: false, message: 'Password must include a lowercase letter.' };
  if (!/[A-Z]/.test(pw)) return { ok: false, message: 'Password must include an uppercase letter.' };
  if (!/\d/.test(pw)) return { ok: false, message: 'Password must include a number.' };
  if (!/[^A-Za-z0-9]/.test(pw)) return { ok: false, message: 'Password must include a special character.' };
  return { ok: true };
}

// Shared-device logins (store tablets, kiosks) use a fixed shared password and are
// EXEMPT from the complexity policy and the failed-attempt lockout.
function isSharedDevice(userType) {
  const t = String(userType || '');
  return t === 'store_tablet' || t.startsWith('kiosk');
}

module.exports = { hashPassword, verifyPassword, isHashed, validatePasswordComplexity, PASSWORD_RE, isSharedDevice };
