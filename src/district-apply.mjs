// src/district-apply.mjs — "Apply to live" for District Alignment (v22.12).
// Pure, no I/O. Compares the District Alignment draft with live Locations + the
// Users table and returns exactly what applying it would change, so the screen
// can show every change for confirmation before anything is written.
//
// draft:      { stores: { [pc]: { district } }, dms: [{ id, name, email, district }] }
// liveStores: Locations stores (open ones) — { pc, name, district, dmName }
// users:      portal users — { id, name, email, userType, district, active }
//
// Returns:
//   storeMoves   [{ pc, name, from, to, editedSinceDraft }]  stores changing district (0 = Unassigned);
//                editedSinceDraft = changed in Locations after the draft was started
//   dmLinks      [{ userId, name, from, to }]      DM accounts to link to a (new) district
//   dmUnlinks    [{ userId, name, from }]          DM accounts whose district the plan gives to someone else
//   keptLinks    [{ name, district }]              DMs left linked: their district has no DM in the plan
//   districtDms  { [district]: { name, email } }   DM per district after applying ('' = none)
//   noAccount    [{ name, district }]              draft DMs with no DM account to link
//   hasChanges   boolean

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
const firstName = (v) => norm(v).split(' ')[0] || '';
export const aliasesOf = (u) => String(u?.aliases || '').split(',').map(norm).filter(Boolean);
const lastName = (v) => { const p = norm(v).split(' '); return p.length > 1 ? p[p.length - 1] : ''; };
const distNum = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : 0; };
const hasDistrict = (v) => v != null && v !== '' && Number(v) > 0;

// The DM account a draft DM refers to: same email, else same full name, else a DM
// already linked to that district with the same first name (the draft is seeded
// from Locations' DM name, which can be shorter than the account name —
// "Mohamed" vs "Mohamed Ali").
export function matchDmUser(dm, dmUsers) {
  const email = norm(dm.email);
  if (email) { const byEmail = dmUsers.filter(u => norm(u.email) === email); if (byEmail.length === 1) return byEmail[0]; }
  const byName = dmUsers.filter(u => norm(u.name) === norm(dm.name));
  if (byName.length === 1) return byName[0];
  // "Also known as" on the DM's account (Admin → Users), e.g. Jay Patel aka "Jayshilkumar Patel".
  const byAlias = dmUsers.filter(u => aliasesOf(u).includes(norm(dm.name)));
  if (byAlias.length === 1) return byAlias[0];
  // Same district + same first OR last name ("Jayshilkumar Patel" in Locations is the
  // "Jay Patel" account — confirmed live 2026-10-23, the mismatch unlinked him).
  const fn = firstName(dm.name), ln = lastName(dm.name);
  const sameDistrict = dmUsers.filter(u => Number(u.district) === Number(dm.district)
    && ((fn && firstName(u.name) === fn) || (ln && lastName(u.name) === ln)));
  if (sameDistrict.length === 1) return sameDistrict[0];
  return null;
}

export function planDistrictApply({ draft, liveStores, users }) {
  const out = { storeMoves: [], dmLinks: [], dmUnlinks: [], keptLinks: [], districtDms: {}, noAccount: [], hasChanges: false };
  if (!draft || !draft.stores) return out;
  const live = new Map((liveStores || []).map(s => [String(s.pc), s]));

  for (const [pc, rec] of Object.entries(draft.stores)) {
    const s = live.get(String(pc));
    if (!s) continue; // closed / gone since the draft was made
    const from = distNum(s.district), to = distNum(rec && rec.district);
    // Edited in Locations after the draft was started: applying may undo that change.
    const editedSinceDraft = !!(draft.seededFromLiveAt && s.updatedAt && String(s.updatedAt) > String(draft.seededFromLiveAt));
    if (from !== to) out.storeMoves.push({ pc: String(pc), name: s.name || String(pc), from, to, editedSinceDraft });
  }
  out.storeMoves.sort((a, b) => a.to - b.to || String(a.name).localeCompare(String(b.name)));

  const dms = (draft.dms || []).filter(d => distNum(d.district) > 0);
  const districtNums = new Set([...Object.values(draft.stores).map(r => distNum(r && r.district)), ...dms.map(d => distNum(d.district))]);
  districtNums.delete(0);
  for (const n of districtNums) {
    const dm = dms.find(d => distNum(d.district) === n);
    out.districtDms[n] = { name: dm ? String(dm.name || '').trim() : '', email: dm ? String(dm.email || '').trim() : '' };
  }

  const dmUsers = (users || []).filter(u => u && u.userType === 'dm' && u.active !== false);
  const matched = new Set();
  const accountByDistrict = {}; // district -> the DM account the plan puts there
  for (const dm of dms) {
    const u = matchDmUser(dm, dmUsers.filter(x => !matched.has(x.id)));
    if (!u) { out.noAccount.push({ name: dm.name, district: distNum(dm.district) }); continue; }
    matched.add(u.id);
    accountByDistrict[distNum(dm.district)] = u.id;
    if (!out.districtDms[distNum(dm.district)].email && u.email) out.districtDms[distNum(dm.district)].email = u.email;
    if (String(u.district ?? '') !== String(distNum(dm.district))) out.dmLinks.push({ userId: u.id, name: u.name, from: hasDistrict(u.district) ? Number(u.district) : null, to: distNum(dm.district) });
  }
  // Only unlink a DM when the plan hands their district to a DIFFERENT DM ACCOUNT
  // (Jay → the new DM's account). A district whose planned DM is just a name with no
  // matching account, or has no DM at all, keeps whoever is linked now — the draft's
  // DM names come from Locations, which can be blank or spelled differently.
  for (const u of dmUsers) {
    if (matched.has(u.id) || !hasDistrict(u.district)) continue;
    const planned = out.districtDms[Number(u.district)];
    const takenBy = accountByDistrict[Number(u.district)];
    if (takenBy != null && takenBy !== u.id) out.dmUnlinks.push({ userId: u.id, name: u.name, from: Number(u.district) });
    else {
      out.keptLinks.push({ name: u.name, district: Number(u.district) });
      if (planned) { planned.name = u.name || ''; planned.email = u.email || ''; } // Locations keeps showing them as DM
    }
  }
  // A planned DM with no account in a district someone stays linked to: say who stays.
  for (const a of out.noAccount) {
    const kept = out.keptLinks.find(k => k.district === a.district);
    if (kept) a.keeps = kept.name;
  }

  out.hasChanges = out.storeMoves.length + out.dmLinks.length + out.dmUnlinks.length > 0;
  return out;
}

// The Locations store list after applying: moved stores get their new district,
// and every planned store gets its district's DM name.
export function applyPlanToStores(stores, plan) {
  const moves = new Map(plan.storeMoves.map(m => [m.pc, m.to]));
  return (stores || []).map(s => {
    const pc = String(s.pc);
    const to = moves.has(pc) ? moves.get(pc) : Number(s.district);
    const dm = plan.districtDms[to];
    const next = { ...s };
    let changed = false;
    if (moves.has(pc)) { next.district = to; changed = true; }
    if (dm && (s.dmName || '') !== dm.name) { next.dmName = dm.name; changed = true; }
    return changed ? next : s;
  });
}

// Locations → Districts after applying: each planned district's DM name/email.
export function applyPlanToDistricts(districts, plan) {
  const out = { ...(districts || {}) };
  for (const [n, dm] of Object.entries(plan.districtDms)) {
    const num = Number(n);
    out[num] = { ...(out[num] || { num }), num, name: dm.name, email: dm.email };
  }
  return out;
}
