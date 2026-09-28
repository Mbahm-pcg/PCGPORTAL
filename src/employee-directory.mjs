// src/employee-directory.mjs
// Pure logic for the Employee Directory sync — no I/O. Merges one store's
// Paycor `employees` page and `identifyingData` page (same legal entity,
// same sync run, so Paycor's GUID lines up directly between them — no
// name-based fallback matching needed here) into upsert-ready rows.

// Paycor's birthDate comes back as a full timestamp ("2000-03-08T00:00:00"),
// not a bare date — normalize to "yyyy-MM-dd" at the source so every
// consumer (the search endpoint, the frontend's <input type="date">, the
// PDF export) gets a clean date and never has to re-derive this.
function normalizeDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

export function buildDirectoryRows(employeesPage, identifyingDataPage, storePc, legalEntityId) {
  const dobById = new Map();
  for (const r of (identifyingDataPage || [])) {
    if (r && r.employeeId) dobById.set(r.employeeId, normalizeDate(r.birthDate));
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
