// manager-sync-orphan-fix.mjs — TEMPORARY, exec/IT-gated, one-time data fix.
// 28 active manager accounts were found with store_pc = null (see
// manager-sync-title-diag.mjs?orphanCheck=1), making them invisible to runManagerSync's
// linkedByPc lookup and any other store_pc-keyed logic. Every one of them maps cleanly,
// 1:1 by name, to a store in the roster already hardcoded in audits.mjs. This applies that
// exact mapping as a single batched UPDATE, keyed by user id (not name — avoids any risk
// of a name collision touching the wrong row).
//
// Dry-run by default: GET with no ?apply=1 just reports what WOULD change, reading current
// values first so nothing is touched blind. Real writes require ?apply=1 explicitly.
// Remove this file once the fix has been applied and confirmed.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// id -> store_pc, from cross-referencing manager-sync-title-diag.mjs's orphanCheck output
// against the store roster in audits.mjs (both name AND district checked for every row).
const FIX_MAP = {
  40: '310382', // Safiya Eshag       — district 7
  21: '337063', // Mosammat Akhtar    — district 3
  34: '345985', // Jessica Garcia     — district 4
  39: '365361', // Ashley DiNardo     — district 7
  28: '332393', // Rajiv Kumar        — district 3
  35: '356374', // Radha Rao          — district 5
  37: '353047', // Joseph Allen       — district 5
  31: '335981', // Chris Brown        — district 4
  18: '341350', // Sara Elhagar       — district 2
  32: '353150', // Edmonds Brandy     — district 4
  19: '337839', // Kirtida Singh      — district 2
  33: '351050', // Torres Katiuska    — district 4
  26: '304863', // Mahmuda Akter      — district 3
  27: '354561', // Thai Banh          — district 3
  24: '355146', // Moslima Akhter     — district 3
  20: '330338', // Satpal Kaur        — district 3
  36: '353843', // Syncere Myer       — district 5
  29: '341167', // Norberto Rodriguez — district 4
  38: '340538', // Vinit Patel        — district 5
  15: '351099', // Sefali Patel       — district 2
  45: '364412', // Tejal Soni         — district 7
  47: '336372', // Dilara Begum       — district 7 (Elkins Park — the original bug report)
  46: '345489', // Iqbal Komal        — district 7
  48: '358933', // Nitin Patel        — district 8
  52: '356316', // Perry Patel        — district 8
  51: '342184', // Cheri Patel        — district 8
  43: '302446', // Nurani Chowdhury   — district 7
  44: '337079', // Andrea Robison     — district 7
};

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return json({ error: 'Exec/IT session required.' }, 403);
  }
  const url = new URL(request.url);
  const apply = url.searchParams.get('apply') === '1';
  const db = sql();

  const ids = Object.keys(FIX_MAP).map(Number);
  const before = await db`SELECT id, name, store_pc, active, user_type FROM users WHERE id = ANY(${ids})`;
  const beforeById = Object.fromEntries(before.map(r => [r.id, r]));

  const plan = ids.map(id => ({
    id,
    name: beforeById[id]?.name || '(not found)',
    active: beforeById[id]?.active ?? null,
    userType: beforeById[id]?.userType ?? beforeById[id]?.user_type ?? null,
    currentStorePc: beforeById[id]?.store_pc ?? null,
    targetStorePc: FIX_MAP[id],
    // Only actually touch rows that are still exactly as diagnosed — an active manager
    // with a still-null store_pc. Anything else (already fixed, deactivated, missing,
    // reassigned) is skipped and reported, never overwritten.
    willUpdate: !!beforeById[id] && beforeById[id].active === true && beforeById[id].user_type === 'manager' && beforeById[id].store_pc == null,
  }));

  if (!apply) {
    return json({ mode: 'dry-run', note: 'Add &apply=1 to actually write these changes.', plan });
  }

  const results = [];
  for (const row of plan) {
    if (!row.willUpdate) { results.push({ ...row, applied: false }); continue; }
    await db`UPDATE users SET store_pc = ${row.targetStorePc}, updated_at = now() WHERE id = ${row.id}`;
    results.push({ ...row, applied: true });
  }
  return json({ mode: 'applied', results });
};
