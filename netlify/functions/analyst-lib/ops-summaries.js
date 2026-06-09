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
    .slice(0, LIST_CAPS.critical);
  const byStore = {};
  for (const t of scoped) {
    byStore[t.store] = byStore[t.store] || { store: t.store, district: t.district, open: 0, oldestDays: 0 };
    byStore[t.store].open++;
    byStore[t.store].oldestDays = Math.max(byStore[t.store].oldestDays, t.ageDays || 0);
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

module.exports = { summarizeProjects, summarizeTickets, LIST_CAPS };
