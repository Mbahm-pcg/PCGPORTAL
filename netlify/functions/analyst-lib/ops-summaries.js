// ops-summaries.js — Pure summarizers for Orion's operational datasets
// (projects, tickets, cash deposits, food cost). No I/O here — builders in
// analyst-data.js load blobs and call these. All list lengths are capped for token control.

const DAY_MS = 86400000;
const LIST_CAPS = { projects: 20, tickets: 15, deposits: 25, missingDeposits: 20, foodItems: 15, critical: 10 };

function storesByPc(stores) {
  const m = new Map();
  for (const s of stores || []) m.set(String(s.pc), s);
  return m;
}

function toMs(d) { return d instanceof Date ? d.getTime() : new Date(d).getTime(); }
function dateMs(yyyyMmDd) { return new Date(yyyyMmDd + 'T12:00:00').getTime(); }
// Signed: positive when `aMs` is after `bMs`. Callers choose the order — e.g. daysBehind
// passes (now, target) so past-due is positive; atRisk passes (target, now) so "days until".
function daysBetween(aMs, bMs) { return Math.round((aMs - bMs) / DAY_MS); }

/** Coerce a money value that may be a number or a user-typed string ("$250,000") to a number, else null. */
function toMoney(v) {
  if (v == null || v === '') return null;
  const stripped = String(v).replace(/[^0-9.\-]/g, '');
  if (stripped === '') return null;
  const n = typeof v === 'number' ? v : Number(stripped);
  return Number.isFinite(n) ? n : null;
}

// Milestone date fields on project records, in pipeline order
const PROJECT_MILESTONES = [
  ['dcpDeliveryDate', 'DCP delivery'],
  ['ncrDeinstallDate', 'NCR de-install'],
  ['ncrReinstallDate', 'NCR re-install'],
  ['interiorDmbDate', 'Interior DMB install'],
  ['exteriorDmbDate', 'Exterior DMB install'],
  ['cameraReinstallDate', 'Camera reinstall'],
  ['installationDate', 'Installation'],
];

const AT_RISK_WINDOW_DAYS = 14; // active project with target within 14 days (or past) = at risk

function summarizeProjects(raw, district, now, stores) {
  if (!Array.isArray(raw) || raw.length === 0) return { available: false };
  const byPc = storesByPc(stores);
  const nowMs = toMs(now);

  const mapped = raw.map(p => {
    const store = byPc.get(String(p.pc));
    const dist = store ? store.district : (p.district || null);
    const target = p.constructionCompleteBy || p.dueDate || null;
    const active = !p.completed;
    const daysBehind = active && target ? Math.max(0, daysBetween(nowMs, dateMs(target))) : 0;
    const atRisk = active && target ? daysBetween(dateMs(target), nowMs) <= AT_RISK_WINDOW_DAYS : false;
    const budget = toMoney(p.totalBudget);       // existing UI key (app.jsx:11834), string-typed
    const actualCost = toMoney(p.spentToDate);   // existing UI key (app.jsx:11842), string-typed
    const variancePct = budget > 0 && actualCost != null
      ? Math.round(((actualCost - budget) / budget) * 1000) / 10 : null;
    let nextMilestone = null;
    for (const [key, label] of PROJECT_MILESTONES) {
      if (p[key] && dateMs(p[key]) >= nowMs) { nextMilestone = `${label} ${p[key]}`; break; }
    }
    const utilities = Object.entries(p.utilities || {})
      .map(([k, v]) => `${k}: ${v?.status || 'Unknown'}${v?.provider ? ` (${v.provider})` : ''}`);
    return {
      name: p.nickname || String(p.id), pc: p.pc || null, district: dist,
      type: p.type || null, status: p.completed ? 'Completed' : 'Active',
      targetCompletion: target, daysBehind, atRisk,
      budget, actualCost, variancePct,
      gc: p.gc || null, gcCompany: p.gcCompany || null,
      utilities, nextMilestone,
      notes: p.notes ? String(p.notes).slice(0, 200) : null,
    };
  });

  const scoped = district ? mapped.filter(p => p.district === district) : mapped;
  if (scoped.length === 0) return { available: true, counts: { total: 0, active: 0, behind: 0, atRisk: 0, completed: 0 }, projects: [] };

  const active = scoped.filter(p => p.status === 'Active');
  const counts = {
    total: scoped.length,
    active: active.length,
    behind: active.filter(p => p.daysBehind > 0).length,
    atRisk: active.filter(p => p.atRisk).length,
    completed: scoped.length - active.length,
  };
  const projects = active
    .sort((a, b) => (b.daysBehind - a.daysBehind) || String(a.targetCompletion || '9999').localeCompare(String(b.targetCompletion || '9999')))
    .slice(0, LIST_CAPS.projects);
  return { available: true, counts, projects };
}

const CLOSED_TICKET_STATUSES = new Set(['completed', 'closed', 'resolved', 'done', 'cancelled']);
const CRITICAL_PRIORITIES = new Set(['high', 'urgent', 'critical']);

function summarizeTickets(raw, district, now, stores) {
  if (!Array.isArray(raw) || raw.length === 0) return { available: false };
  const byPc = storesByPc(stores);
  const nowMs = toMs(now);

  let scoped = raw
    .filter(t => !CLOSED_TICKET_STATUSES.has(String(t.status || '').toLowerCase()))
    .map(t => {
      const store = byPc.get(String(t.storePC));
      return {
        number: t.number || String(t.id),
        title: t.title || null,
        storePC: t.storePC != null ? String(t.storePC) : null,
        store: t.storeName || (store && store.name) || String(t.storePC),
        district: store ? store.district : null,
        category: t.category || null,
        priority: t.priority || 'Medium',
        status: t.status || 'Open',
        owner: t.ticketOwner || null,
        dueDate: t.dueDate || null,
        ageDays: t.createdAt ? Math.max(0, daysBetween(nowMs, toMs(t.createdAt))) : null,
      };
    });
  if (district) scoped = scoped.filter(t => t.district === district);

  const aging = {
    gt7: scoped.filter(t => (t.ageDays || 0) > 7).length,
    gt14: scoped.filter(t => (t.ageDays || 0) > 14).length,
  };
  const critical = scoped
    .filter(t => CRITICAL_PRIORITIES.has(String(t.priority).toLowerCase()))
    .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0)) // oldest first, so the cap keeps the worst
    .slice(0, LIST_CAPS.critical);
  const byStore = {};
  for (const t of scoped) {
    const key = String(t.storePC || t.store); // key by PC — store display names can collide
    byStore[key] = byStore[key] || { store: t.store, district: t.district, open: 0, oldestDays: 0 };
    byStore[key].open++;
    byStore[key].oldestDays = Math.max(byStore[key].oldestDays, t.ageDays || 0);
  }
  const tickets = [...scoped].sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0)).slice(0, LIST_CAPS.tickets);
  return {
    available: true,
    totalOpen: scoped.length,
    tickets,
    openByStore: Object.values(byStore).sort((a, b) => b.open - a.open),
    aging,
    critical,
  };
}

const CASH_WINDOW_DAYS = 14;  // gap-scan window
const CASH_BUFFER_DAYS = 2;   // most recent N days exempt (upload lag)

// UTC-relative day string — pair only with `nowMs` derived from an ISO timestamp
// (Netlify runs UTC); a local-midnight Date on a non-UTC dev machine can shift edges by a day.
function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

function summarizeCash(raw, district, now, stores) {
  if (!Array.isArray(raw) || raw.length === 0) return { available: false };
  const byPc = storesByPc(stores);
  const nowMs = toMs(now);

  let deps = raw.map(d => {
    const store = byPc.get(String(d.pc));
    return {
      store: store ? store.name : String(d.pc),
      district: store ? store.district : null,
      pc: String(d.pc),
      depositDate: d.depositDate || null,
      amount: typeof d.amount === 'number' ? d.amount : Number(d.amount) || 0,
      llcName: d.llcName || null,
      businessDates: Array.isArray(d.businessDates) ? d.businessDates : [],
    };
  });
  if (district) deps = deps.filter(d => d.district === district);

  const ageDays = d => d.depositDate ? daysBetween(nowMs, dateMs(d.depositDate)) : Infinity;
  const round2 = n => Math.round(n * 100) / 100;
  const last7Total = round2(deps.filter(d => ageDays(d) <= 7).reduce((s, d) => s + d.amount, 0));
  const last30Total = round2(deps.filter(d => ageDays(d) <= 30).reduce((s, d) => s + d.amount, 0));

  // Missing deposits: per participating store (≥1 deposit in scope), business dates in
  // [now-CASH_WINDOW_DAYS, now-CASH_BUFFER_DAYS] not covered by any deposit's businessDates.
  // Heuristic: closed days (Sundays/holidays) show as false positives — the prompt layer
  // instructs the LLM to recommend verification, never accuse.
  const coveredByPc = new Map();
  for (const d of deps) {
    if (!coveredByPc.has(d.pc)) coveredByPc.set(d.pc, new Set());
    for (const bd of d.businessDates) coveredByPc.get(d.pc).add(bd);
  }
  const missingDeposits = [];
  for (const [pc, covered] of coveredByPc) {
    const store = byPc.get(pc);
    for (let back = CASH_WINDOW_DAYS; back >= CASH_BUFFER_DAYS; back--) {
      const date = isoDay(nowMs - back * DAY_MS);
      if (!covered.has(date)) {
        missingDeposits.push({ store: store ? store.name : pc, district: store ? store.district : null, date });
      }
    }
  }
  missingDeposits.sort((a, b) => a.store.localeCompare(b.store) || a.date.localeCompare(b.date));

  const deposits = [...deps]
    .sort((a, b) => String(b.depositDate || '').localeCompare(String(a.depositDate || '')))
    .slice(0, LIST_CAPS.deposits)
    .map(({ pc, ...rest }) => rest);
  return {
    available: true,
    deposits,
    last7Total,
    last30Total,
    missingDeposits: missingDeposits.slice(0, LIST_CAPS.missingDeposits),
    missingCount: missingDeposits.length,
  };
}

module.exports = { summarizeProjects, summarizeTickets, summarizeCash, LIST_CAPS };
