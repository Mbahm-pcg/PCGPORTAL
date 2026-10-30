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
import { pickViewDistrict, parseDistricts } from '../../../src/director-scope.mjs';

const EXEC_ROLES = new Set(['executive', 'it']);

// v22.34: a Director of Operations resolves as the DM of the district they are viewing
// (`requestedDistrict`, from the request) — only if it is one of their own, else their
// first. A Director with no districts gets an impossible district (-1), never null: several
// callers read a null district as "whole network".
export async function resolveCaller(userId, requestedDistrict) {
  if (userId == null || userId === '') return null;
  try {
    const db = sql();
    const rows = await db`SELECT id, user_type, district, store_pc FROM users WHERE id = ${userId} AND active = true`;
    if (!rows.length) return null;
    const r = rows[0];
    if (r.user_type === 'director') {
      let list = null;
      try { list = (await db`SELECT director_districts FROM users WHERE id = ${userId}`)[0]?.director_districts; } catch { /* column not there yet */ }
      const district = pickViewDistrict(list, requestedDistrict);
      return { id: r.id, role: 'dm', realRole: 'director', district: district ?? -1, districts: parseDistricts(list), storePC: null };
    }
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

// The district a Director picked in the portal's switcher (pcg_view_district cookie), or null.
export function viewDistrictFromRequest(request) {
  const m = /(?:^|;\s*)pcg_view_district=(\d+)/.exec(request?.headers?.get?.('cookie') || '');
  return m ? Number(m[1]) : null;
}

export function isExec(role) {
  return EXEC_ROLES.has(role);
}
