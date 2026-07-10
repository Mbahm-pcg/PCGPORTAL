// caps.js — CAP lifecycle rules. See spec §6.
const CAP_STATUSES = ['open', 'owner_resolved', 'verified_closed', 'overdue'];
const VERIFIERS = new Set(['auditor', 'executive', 'it']);

function canTransition(userType, isOwner, from, to) {
  if (from === 'verified_closed') return false;
  if ((from === 'open' || from === 'overdue') && to === 'owner_resolved')
    return isOwner || VERIFIERS.has(userType);
  if (from === 'owner_resolved' && to === 'verified_closed') return VERIFIERS.has(userType);
  if (from === 'owner_resolved' && to === 'open') return VERIFIERS.has(userType); // reject fix
  return false;
}

const HOURS = { critical: 48, high: 72 };
function defaultDeadline(severity, nowMs) {
  const h = HOURS[severity] || 24 * 7;
  return new Date(nowMs + h * 3600 * 1000).toISOString();
}

function isOverdue(cap, nowMs) {
  if (cap.status !== 'open' && cap.status !== 'overdue') return false;
  return Date.parse(cap.deadline) < nowMs;
}
module.exports = { CAP_STATUSES, canTransition, defaultDeadline, isOverdue };
