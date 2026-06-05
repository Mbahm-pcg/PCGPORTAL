// PCG Deal Pipeline — role ranking for RBAC. view < edit < admin.
const ROLE_RANK = { view: 1, edit: 2, admin: 3 };

function roleSatisfies(userRole, requiredRole) {
  const have = ROLE_RANK[userRole] || 0;
  const need = ROLE_RANK[requiredRole];
  if (!need) return false;
  return have >= need;
}

module.exports = { ROLE_RANK, roleSatisfies };
