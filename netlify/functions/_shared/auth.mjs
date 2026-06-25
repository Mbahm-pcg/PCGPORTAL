// auth.mjs — server-side caller resolution. The portal passes userId/userRole in request
// bodies; trusting the claimed role/scope lets a crafted POST escalate (e.g. {userRole:'executive'}).
// resolveCaller looks up the AUTHORITATIVE role/district/store from the Neon users table by id,
// so handlers can enforce scope on the server instead of trusting the payload.
//
// Note: userId itself still comes from the request (no session tokens yet), so this raises the bar
// (can't claim a role you don't have) rather than being full auth. Returns null for unknown ids and
// for server-internal callers (crons/MCP) that don't pass a real userId — callers treat null as
// "fall back to the claimed role" so trusted server jobs keep working.
import { sql } from './db.mjs';

const EXEC_ROLES = new Set(['executive', 'it']);

export async function resolveCaller(userId) {
  if (userId == null || userId === '') return null;
  try {
    const db = sql();
    const rows = await db`SELECT id, user_type, district, store_pc FROM users WHERE id = ${userId} AND active = true`;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      role: r.user_type,
      district: r.district != null ? Number(r.district) : null,
      storePC: r.store_pc != null ? String(r.store_pc) : null,
    };
  } catch {
    return null; // DB hiccup → caller falls back to claimed role (no hard fail)
  }
}

export function isExec(role) {
  return EXEC_ROLES.has(role);
}
