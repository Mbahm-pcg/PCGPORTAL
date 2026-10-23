// src/office-clock-weeks.mjs — weekly totals for the employee's own Time Clock (v22.17).
// Pure, no I/O. A biweekly pay period ends on a Saturday and holds two Sunday–Saturday
// workweeks (the same split office-clock-lib.mjs's weeklyRegOtFromPunches uses for
// payroll). Daily minutes come from officeClockDailyHours / dailyHoursFromPunches:
// [{ day: 'YYYY-MM-DD', totalMinutes: number | null }] — null = an incomplete day
// (e.g. no clock-out), which is never guessed at or counted.

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The two workweeks of the period ending on periodEnd (a Saturday).
export function periodWeeks(periodEnd) {
  return [
    { weekStart: addDays(periodEnd, -13), weekEnd: addDays(periodEnd, -7) },
    { weekStart: addDays(periodEnd, -6), weekEnd: periodEnd },
  ];
}

// Per-week totals for one period. `today` + `todayMinutes` let a still-open day
// (clocked in, no clock-out yet) count its hours so far, flagged inProgress.
export function weekTotals(dailyRows, periodEnd, { today = null, todayMinutes = null } = {}) {
  return periodWeeks(periodEnd).map(({ weekStart, weekEnd }) => {
    let minutes = 0, incompleteDays = 0, inProgress = false;
    const days = [];
    for (const row of dailyRows || []) {
      if (row.day < weekStart || row.day > weekEnd) continue;
      let m = row.totalMinutes;
      let live = false;
      if (m == null && row.day === today && todayMinutes != null) { m = todayMinutes; live = true; inProgress = true; }
      if (m == null) incompleteDays++;
      else minutes += m;
      days.push({ day: row.day, minutes: m, inProgress: live });
    }
    days.sort((a, b) => (a.day < b.day ? 1 : -1)); // most recent first
    return { weekStart, weekEnd, minutes, incompleteDays, inProgress, days };
  });
}

// The week (of the given period's two) that contains `day`, or null.
export function weekContaining(weeks, day) {
  return (weeks || []).find(w => day >= w.weekStart && day <= w.weekEnd) || null;
}
