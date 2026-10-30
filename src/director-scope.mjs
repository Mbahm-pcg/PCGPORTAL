// src/director-scope.mjs — Director of Operations scoping (v22.34). Pure, no I/O.
//
// A Director oversees several districts. Rather than teach every DM check in the app and
// the functions about district LISTS, a Director always looks at ONE of their districts
// at a time (the sidebar switcher) and, while doing so, is treated exactly like that
// district's DM. The district being viewed travels to the server in the
// `pcg_view_district` cookie; the server only ever honours a district on the Director's
// own list. Their saved account stays user_type 'director', so DM-targeted alerts and
// DM assignment (which query user_type = 'dm') never pick them up.
//
// netlify/functions/auth-lib/require-user.js is CommonJS and carries an inline copy of
// pickViewDistrict — keep the two in step.

export const VIEW_DISTRICT_COOKIE = 'pcg_view_district';

// "3, 9" | [3,'9'] | null → [3, 9] (unique, positive integers, ascending)
export function parseDistricts(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/);
  const out = [...new Set(list.map(x => Number(x)).filter(n => Number.isInteger(n) && n > 0))];
  return out.sort((a, b) => a - b);
}

// [9, 3] → "3,9"; empty → null (the column's "none" value)
export function formatDistricts(v) {
  const list = parseDistricts(v);
  return list.length ? list.join(',') : null;
}

// The district a Director is viewing: the requested one if it's theirs, else their first.
// null when they have none (callers must then grant no DM scope at all).
export function pickViewDistrict(districts, requested) {
  const list = parseDistricts(districts);
  if (!list.length) return null;
  const r = Number(requested);
  return list.includes(r) ? r : list[0];
}

// The account as the app should see it right now. Idempotent: passing an already-viewed
// account back in (e.g. setUser({ ...user, x })) re-derives from realUserType.
export function directorView(user, requested) {
  if (!user) return user;
  const real = user.realUserType || user.userType;
  if (real !== 'director') return user;
  const districts = parseDistricts(user.districts);
  const district = pickViewDistrict(districts, requested ?? user.district);
  if (district == null) return { ...user, userType: 'director', realUserType: 'director', districts, district: null };
  return { ...user, userType: 'dm', realUserType: 'director', districts, district };
}

export const isDirector = (user) => (user?.realUserType || user?.userType) === 'director';
