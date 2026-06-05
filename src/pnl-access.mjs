// PCG Portal — P&L access control (pure helpers, ESM)
// Single source of truth for "who can see the P&L tab" and "who can manage access".
// Identity is matched case-insensitively against a user's username OR email, because
// the same person can appear under multiple usernames / casings in the user store.

// Managers: always allowed to VIEW P&L and the only ones who can MANAGE the allowlist.
export const PNL_MANAGERS = [
  'mike.bahm', 'mike@peoplecapitalgroup.com',
  'ahmed', 'ahmed@peoplecapitalgroup.com',
];

// Default grantees when no pcg_pnl_access_v1 blob exists yet (managers are implicit).
export const DEFAULT_PNL_ALLOWED = ['krunal', 'krunal@raogroupinc.com'];

export const normalizeId = (s) => (s == null ? '' : String(s).trim().toLowerCase());

/** The set of identifiers (username + email, normalized) that represent a user. */
export const pnlIds = (user) =>
  [user && user.username, user && user.email].map(normalizeId).filter(Boolean);

/** Only Mike & Ahmed: can view P&L and manage who else can. */
export const canManagePnlAccess = (user) =>
  pnlIds(user).some((id) => PNL_MANAGERS.includes(id));

/** Can this user view the P&L tab? Managers always; otherwise must be in the allowed list. */
export const canViewPnl = (user, allowed) => {
  if (canManagePnlAccess(user)) return true;
  const list = Array.isArray(allowed) ? allowed.map(normalizeId) : [];
  return pnlIds(user).some((id) => list.includes(id));
};
