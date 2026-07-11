// access.js — Per-user audits access elevation helper. See spec §2.
const VIEWERS = new Set(['auditor', 'executive', 'it', 'office_staff', 'dm']);
const VERIFIERS = new Set(['auditor', 'executive', 'it']);

function effectiveAudits(userType, grant) {
  // Normalize grant: only 'view' or 'full' are valid, anything else is null
  const normalizedGrant = (grant === 'view' || grant === 'full') ? grant : null;

  // canView: baseline viewer role OR grant elevates
  const canView = VIEWERS.has(userType) || normalizedGrant === 'view' || normalizedGrant === 'full';

  // canAudit: baseline verifier role OR full grant (never reduces)
  const canAudit = VERIFIERS.has(userType) || normalizedGrant === 'full';

  // effUserType: if full grant and not already a verifier, become 'auditor'; else keep userType
  const effUserType = normalizedGrant === 'full' && !VERIFIERS.has(userType) ? 'auditor' : userType;

  return { canView, canAudit, effUserType };
}

module.exports = { effectiveAudits };
