// PCG Portal — Tips Report access control (pure helpers, ESM)
// Mirrors pnl-access.mjs's shape, but inverted: Tips Report is ON for everyone by
// default, and this is a BLOCK-list (people explicitly turned off) rather than an
// allow-list. Identity is matched case-insensitively against username OR email.
import { normalizeId } from './pnl-access.mjs';

export { normalizeId };

/** The set of identifiers (username + email, normalized) that represent a user. */
export const tipsIds = (user) =>
  [user && user.username, user && user.email].map(normalizeId).filter(Boolean);

/** Can this user see the Tips Report tile? Everyone can, unless explicitly blocked. */
export const canViewTipsReport = (user, blocked) => {
  const list = Array.isArray(blocked) ? blocked.map(normalizeId) : [];
  return !tipsIds(user).some((id) => list.includes(id));
};
