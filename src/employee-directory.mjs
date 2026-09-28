// src/employee-directory.mjs
// Pure logic for the Employee Directory sync — no I/O. Merges one store's
// Paycor `employees` page and `identifyingData` page (same legal entity,
// same sync run, so Paycor's GUID lines up directly between them — no
// name-based fallback matching needed here) into upsert-ready rows.

export function buildDirectoryRows(employeesPage, identifyingDataPage, storePc, legalEntityId) {
  const dobById = new Map();
  for (const r of (identifyingDataPage || [])) {
    if (r && r.employeeId) dobById.set(r.employeeId, r.birthDate || null);
  }
  return (employeesPage || [])
    .filter(e => e && e.id)
    .map(e => ({
      paycorEmployeeId: e.id,
      employeeNumber: e.employeeNumber || null,
      firstName: e.firstName || '',
      lastName: e.lastName || '',
      email: e.email?.emailAddress || null,
      birthDate: dobById.has(e.id) ? dobById.get(e.id) : null,
      status: e.statusData?.status || null,
      storePc,
      legalEntityId,
    }));
}
