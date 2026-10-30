// src/terminations.mjs — terminated employees by location, per quarter / half year (v22.33).
// Pure, no I/O. The sync (netlify/functions/terminations-lib/run.mjs) reads each store's
// Paycor roster (include=All) and keeps only people who are no longer active with a
// termination date; the Tools-hub "Terminations" screen groups them by store per period.

const iso = (d) => (d ? String(d).slice(0, 10) : null);

// A Paycor employee record → a termination row, or null if they're still employed.
// The termination date is read from where Paycor documents it (employmentDateData),
// with the status's own effective date as a fallback.
export function extractTermination(e, pc) {
  if (!e || !e.id) return null;
  const status = String(e.statusData?.status || e.status || '');
  if (!status || /^active$/i.test(status) || /leave/i.test(status)) return null;
  const date = iso(e.employmentDateData?.terminationDate || e.employmentDates?.terminationDate || e.terminationDate || e.statusData?.terminationDate || e.statusData?.effectiveDate);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    id: String(e.id),
    pc: String(pc),
    name: `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim() || 'Unknown',
    jobTitle: e.positionData?.jobTitle || null,
    hireDate: iso(e.employmentDateData?.hireDate || e.employmentDates?.hireDate || e.hireDate),
    terminationDate: date,
    status,
  };
}

// kind: 'quarter' | 'half'; index: 1-4 (quarter) or 1-2 (half).
export function periodFor(kind, year, index) {
  const months = kind === 'half' ? 6 : 3;
  const startMonth = (index - 1) * months; // 0-based
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, startMonth + months, 0)).getUTCDate();
  return {
    kind, year, index,
    start: `${year}-${pad(startMonth + 1)}-01`,
    end: `${year}-${pad(startMonth + months)}-${pad(lastDay)}`,
    label: kind === 'half' ? `${index === 1 ? 'First' : 'Second'} half ${year}` : `Q${index} ${year}`,
    short: kind === 'half' ? `H${index} ${year}` : `Q${index} ${year}`,
  };
}

export function periodContaining(kind, isoDate) {
  const [y, m] = String(isoDate).slice(0, 7).split('-').map(Number);
  const index = kind === 'half' ? (m <= 6 ? 1 : 2) : Math.floor((m - 1) / 3) + 1;
  return periodFor(kind, y, index);
}

export function shiftPeriod(p, delta) {
  const per = p.kind === 'half' ? 2 : 4;
  let i = p.index - 1 + delta;
  const y = p.year + Math.floor(i / per);
  i = ((i % per) + per) % per;
  return periodFor(p.kind, y, i + 1);
}

// rows in the period, grouped by store (desc by count, then name). stores: [{pc,name,district}]
export function groupByStore(rows, period, stores) {
  const meta = new Map((stores || []).map(s => [String(s.pc), s]));
  const by = new Map();
  for (const r of rows || []) {
    if (!r || r.terminationDate < period.start || r.terminationDate > period.end) continue;
    if (!by.has(r.pc)) by.set(r.pc, []);
    by.get(r.pc).push(r);
  }
  return [...by.entries()].map(([pc, people]) => ({
    pc, name: meta.get(pc)?.name || `PC# ${pc}`, district: meta.get(pc)?.district ?? null,
    count: people.length,
    people: people.sort((a, b) => a.terminationDate.localeCompare(b.terminationDate) || a.name.localeCompare(b.name)),
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function countIn(rows, period) {
  return (rows || []).filter(r => r && r.terminationDate >= period.start && r.terminationDate <= period.end).length;
}
