// holidays.mjs — US holiday DATE logic only (pure & testable).
// This answers "is this date a holiday, and which one?" and "when did that
// holiday fall in year Y?" — handling both fixed-date and floating
// (nth-weekday / Easter) holidays. The sales MAGNITUDE of each holiday is
// learned separately from real Pulse history (see forecast.learnHolidayFactor),
// so we never hand-tune multipliers here.

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// nth (1-based) `weekday` (0=Sun..6=Sat) of `month` (1-12) in `year`.
// Pass n='last' for the last such weekday of the month.
function nthWeekday(year, month, weekday, n) {
  const daysInMonth = new Date(year, month, 0).getDate();
  if (n === 'last') {
    for (let d = daysInMonth; d >= 1; d--) {
      if (new Date(year, month - 1, d).getDay() === weekday) return d;
    }
    return null;
  }
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month - 1, d).getDay() === weekday) { count++; if (count === n) return d; }
  }
  return null;
}

// Anonymous Gregorian algorithm for Easter Sunday → { month, day }.
function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

// key → display name + dateFor(year) → 'YYYY-MM-DD'
const DEFS = [
  { key: 'new_years',     name: "New Year's Day",   dateFor: (y) => iso(y, 1, 1) },
  { key: 'mlk',           name: 'MLK Day',          dateFor: (y) => iso(y, 1, nthWeekday(y, 1, 1, 3)) },
  { key: 'valentines',    name: "Valentine's Day",  dateFor: (y) => iso(y, 2, 14) },
  { key: 'presidents',    name: 'Presidents Day',   dateFor: (y) => iso(y, 2, nthWeekday(y, 2, 1, 3)) },
  { key: 'easter',        name: 'Easter',           dateFor: (y) => { const e = easter(y); return iso(y, e.month, e.day); } },
  { key: 'memorial',      name: 'Memorial Day',     dateFor: (y) => iso(y, 5, nthWeekday(y, 5, 1, 'last')) },
  { key: 'juneteenth',    name: 'Juneteenth',       dateFor: (y) => iso(y, 6, 19) },
  { key: 'independence',  name: 'Independence Day', dateFor: (y) => iso(y, 7, 4) },
  { key: 'labor',         name: 'Labor Day',        dateFor: (y) => iso(y, 9, nthWeekday(y, 9, 1, 1)) },
  { key: 'halloween',     name: 'Halloween',        dateFor: (y) => iso(y, 10, 31) },
  { key: 'thanksgiving',  name: 'Thanksgiving',     dateFor: (y) => iso(y, 11, nthWeekday(y, 11, 4, 4)) },
  { key: 'christmas_eve', name: 'Christmas Eve',    dateFor: (y) => iso(y, 12, 24) },
  { key: 'christmas',     name: 'Christmas',        dateFor: (y) => iso(y, 12, 25) },
  { key: 'new_years_eve', name: "New Year's Eve",   dateFor: (y) => iso(y, 12, 31) },
];

/** The 'YYYY-MM-DD' a given holiday falls on in `year`, or null for unknown key. */
export function holidayDateFor(key, year) {
  const def = DEFS.find((d) => d.key === key);
  return def ? def.dateFor(year) : null;
}

/** { key, name } if `dateISO` is a recognized holiday, else null. */
export function holidayInfo(dateISO) {
  if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;
  const year = Number(dateISO.slice(0, 4));
  for (const def of DEFS) {
    if (def.dateFor(year) === dateISO) return { key: def.key, name: def.name };
  }
  return null;
}

export const HOLIDAY_KEYS = DEFS.map((d) => d.key);
