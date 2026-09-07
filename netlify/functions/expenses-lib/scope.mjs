// scope.mjs — pure helpers for the business-expenses feature. No I/O, no
// Postgres/blob calls here — safe to unit test in isolation. Consumed by
// netlify/functions/expenses.mjs.

export const CATEGORIES = ['Gas', 'Food', 'Tools', 'Supplies', 'Repairs', 'Office', 'Other'];

// Exec/IT/office_staff see every submission network-wide and can delete any
// row (executive/it only — see canDeleteExpense); everyone else only ever
// sees/deletes their own.
export const ADMIN_USER_TYPES = ['executive', 'it', 'office_staff'];

export function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

export function isFullExpenseAdmin(userType) {
  return ADMIN_USER_TYPES.includes(userType);
}

// Resolves store_name/district from a store_pc using a pc→store map (shape:
// { [pc]: { pc, name, district } }, e.g. STORE_BY_PC from ndcp-lib/store-map.js).
// Never trusts a client-sent name/district — only the pc travels from the
// caller, name/district are always looked up server-side. An unknown pc
// keeps the pc (so it's still visible/debuggable) but never invents a name
// or district for it.
export function resolveStoreFields(storePc, storeByPc) {
  if (!storePc) return { storePc: null, storeName: null, district: null };
  const key = String(storePc);
  const store = storeByPc[key];
  if (!store) return { storePc: key, storeName: null, district: null };
  return { storePc: store.pc, storeName: store.name, district: store.district };
}

// True if `claims` (the verified portal session token) may delete `row` (a
// business_expenses row). A non-admin may only delete their own row — an
// office_staff admin can VIEW everyone's rows (see buildListScope) but is
// deliberately NOT in the delete-any set, only executive/it are (matches
// canDeleteExpense's narrower set vs isFullExpenseAdmin's viewing set).
export function canDeleteExpense(row, claims) {
  if (!row || !claims) return false;
  if (claims.userType === 'executive' || claims.userType === 'it') return true;
  return String(row.submitted_by_user_id) === String(claims.sub);
}

// Builds the effective filter set for a `list` query. A non-admin caller is
// force-scoped to their own rows (forceUserId) regardless of any filter they
// sent — the server enforces "everyone sees only their own" here, not the
// client. An admin caller may also explicitly request their own rows only
// (filters.mine === true) — used by the "My receipts" view so exec/IT/
// office_staff don't get the full network view under a misleading label.
export function buildListScope(claims, filters = {}) {
  const forceOwn = filters.mine === true || !isFullExpenseAdmin(claims?.userType);
  return {
    storePc: filters.storePc || null,
    district: filters.district != null && filters.district !== '' ? Number(filters.district) : null,
    category: filters.category || null,
    dateFrom: filters.dateFrom || null,
    dateTo: filters.dateTo || null,
    forceUserId: forceOwn ? (claims?.sub ?? null) : null,
  };
}
