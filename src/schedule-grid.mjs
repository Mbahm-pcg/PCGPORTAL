// Pure list-mutation helpers for moving a shift between employees' shift
// lists. Shared by the desktop editable grid (Edit popover's Re-assign
// dropdown, Cut/Copy/Paste) and the mobile card flow's "reassign to a
// different employee" action — every higher-level move is these two
// functions composed (remove from source, add to target).
//
// List shape: [{ employeeId, shifts: [{ dayOffset, startTime, endTime }], ...other fields }]
// `shift` is always matched by object reference (===), never by value —
// callers must pass the exact instance being acted on.

export function removeShiftFromEmployee(list, employeeId, shift) {
  return list.map(c => c.employeeId === employeeId
    ? { ...c, shifts: (c.shifts || []).filter(s => s !== shift) }
    : c);
}

export function addShiftToEmployee(list, employeeId, shift) {
  return list.map(c => c.employeeId === employeeId
    ? { ...c, shifts: [...(c.shifts || []), shift] }
    : c);
}
