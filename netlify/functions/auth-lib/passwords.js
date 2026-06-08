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

module.exports = { hashPassword, verifyPassword, isHashed };
