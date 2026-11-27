// src/screens/AdminDeals.jsx — moved out of app.jsx unchanged (v23.36, scripts/extract-screen.mjs).
import { DATE_TYPES, dateLabel, daysUntil, dealDeadlineFlag, icsForDeal, nextDeadline, warningStatus } from '../deal-dates.mjs';
import { O, btn, card, inp } from '../theme.js';
import { dealApi, dealDocsApi, dealDownloadVersion, dealUploadDoc } from '../deal-api.mjs';
import { fmtDollars, formatPhone } from '../../app.jsx';

const { useEffect, useState } = React;

export function AdminDeals({ th, user, dealAuth }) {
  const { token, role } = dealAuth;
  const canEdit = role === 'edit' || role === 'admin';

  // Relative time for the activity log (e.g. "just now", "3h ago", "2d ago"); falls back to date.
  const relTime = (ts) => {
    const t = new Date(ts).getTime();
    if (Number.isNaN(t)) return '';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 5400) { const m = Math.round(s / 60); return `${m}m ago`; }
    if (s < 86400) { const h = Math.round(s / 3600); return `${h}h ago`; }
    if (s < 7 * 86400) { const d = Math.round(s / 86400); return `${d}d ago`; }
    return new Date(ts).toLocaleDateString();
  };

  const STAGES = [
    { id: 'sourcing',               label: 'Sourcing' },
    { id: 'loi_out',                label: 'LOI Out' },
    { id: 'loi_executed',           label: 'LOI Executed' },
    { id: 'due_diligence',          label: 'Due Diligence' },
    { id: 'negotiating',            label: 'Lease/PSA Negotiating' },
    { id: 'executed',               label: 'Executed' },
    { id: 'closing',                label: 'Closing/Possession' },
    { id: 'ready_for_construction', label: 'Ready for Construction' },
  ];
  const STAGE_MAP = Object.fromEntries(STAGES.map(s => [s.id, s.label]));
  const STAGE_COLORS = {
    sourcing: '#64748b', loi_out: '#3b82f6', loi_executed: '#6366f1',
    due_diligence: '#f59e0b', negotiating: '#f97316', executed: '#22c55e',
    closing: '#14b8a6', ready_for_construction: '#a855f7',
  };
  const BRAND_COLORS = { dunkin: '#FF671F', papajohns: '#ef4444', bww_go: '#f59e0b', dual: '#6366f1' };
  const BRAND_LABELS = { dunkin: 'Dunkin\'', papajohns: 'Papa Johns', bww_go: 'BWW Go', dual: 'Dual' };
  const DEAD_REASONS = ['Lost to competitor', 'Failed due diligence', 'Zoning denied', 'Franchisor rejected', 'Economics', 'Financing fell through', 'Other'];

  // ── state ──
  const [deals, setDeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState('kanban');
  const [filterBrand, setFilterBrand] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [filterState, setFilterState] = useState('all');
  const [filterStage, setFilterStage] = useState('all');
  const [filterLead, setFilterLead] = useState('all');
  const [sortCol, setSortCol] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [selectedDeal, setSelectedDeal] = useState(null);
  const [detailDeal, setDetailDeal] = useState(null);
  const [detailDates, setDetailDates] = useState([]);
  const [detailNotes, setDetailNotes] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [editFields, setEditFields] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [noteErr, setNoteErr] = useState(null);
  const [actionErr, setActionErr] = useState(null); // inline surfacing for stage-move / handoff failures
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', deal_type: 'lease', brand: 'dunkin', state: 'PA', address: '', deal_lead: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [docs, setDocs] = useState([]);
  const [docVersions, setDocVersions] = useState([]);
  const [docBusy, setDocBusy] = useState(false);
  const [docErr, setDocErr] = useState(null);
  const [newDocType, setNewDocType] = useState('loi');
  const [allDates, setAllDates] = useState([]);
  const [newDateType, setNewDateType] = useState(DATE_TYPES[0]?.id || '');
  const [newDateDue, setNewDateDue] = useState('');
  const [newDateTiers, setNewDateTiers] = useState(DATE_TYPES[0]?.defaultTiers?.join(',') || '');
  const [newDateNotes, setNewDateNotes] = useState('');
  const [newDateRecurring, setNewDateRecurring] = useState('');
  const [dateAdding, setDateAdding] = useState(false);
  const [dateErr, setDateErr] = useState(null);
  // ── access panel state ──
  const [showAccess, setShowAccess] = useState(false);
  const [accessRows, setAccessRows] = useState(null);
  const [accessInput, setAccessInput] = useState('');
  const [accessRole, setAccessRole] = useState('view');
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessErr, setAccessErr] = useState(null);
  // ── deal leads state ──
  const [dealLeads, setDealLeads] = useState([]);
  const [newLeadName, setNewLeadName] = useState('');
  // ── mark-dead modal state ──
  const [deadFor, setDeadFor] = useState(null);
  const [deadReason, setDeadReason] = useState(DEAD_REASONS[0]);
  const [deadNote, setDeadNote] = useState('');
  const [deadBusy, setDeadBusy] = useState(false);
  const [deadErr, setDeadErr] = useState(null);
  // ── send reminder state ──
  const [remindFor, setRemindFor] = useState(null);
  const [remindPhone, setRemindPhone] = useState('');
  const [remindMsg, setRemindMsg] = useState('');
  const [remindBusy, setRemindBusy] = useState(false);
  const [remindStatus, setRemindStatus] = useState(null);

  // ── load deals ──
  const loadList = () => {
    setLoading(true);
    return dealApi(token, { action: 'list', status: 'active' })
      .then(r => { setDeals(r.deals || []); setAllDates(r.dates || []); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!token) { setLoading(false); return; }
    loadList();
    dealApi(token, { action: 'listLeads' }).then(r => setDealLeads(r.leads || [])).catch(() => {});
  }, [token]);

  // ── access panel helpers ──
  const loadAccess = () => {
    setAccessErr(null);
    dealApi(token, { action: 'listAccess' })
      .then(r => setAccessRows(r.access || []))
      .catch(e => setAccessErr(e.message));
  };
  useEffect(() => { if (showAccess) loadAccess(); }, [showAccess]);
  const doSetAccess = (key, r) => {
    setAccessBusy(true); setAccessErr(null);
    dealApi(token, { action: 'setAccess', user_key: key, role: r })
      .then(() => loadAccess())
      .catch(e => setAccessErr(e.message))
      .finally(() => setAccessBusy(false));
  };
  const doRemoveAccess = (key) => {
    setAccessBusy(true); setAccessErr(null);
    dealApi(token, { action: 'removeAccess', user_key: key })
      .then(() => loadAccess())
      .catch(e => setAccessErr(e.message))
      .finally(() => setAccessBusy(false));
  };

  // ── open detail ──
  const loadDocs = (dealId) => {
    setDocErr(null);
    dealDocsApi(token, { action: 'list', deal_id: dealId })
      .then(r => { setDocs(r.docs || []); setDocVersions(r.versions || []); })
      .catch(e => setDocErr(e.message));
  };

  const openDetail = (deal) => {
    setSelectedDeal(deal);
    setDetailDeal(deal);
    setDetailDates([]);
    setDetailNotes([]);
    setDocs([]);
    setDocVersions([]);
    setDocErr(null);
    setEditFields({});
    setSaveMsg(null);
    setDetailLoading(true);
    setDetailError(null);
    dealApi(token, { action: 'get', id: deal.id })
      .then(r => {
        setDetailDeal(r.deal);
        setDetailDates(r.dates || []);
        setDetailNotes(r.notes || []);
        setEditFields({});
      })
      .catch(e => setDetailError(e.message))
      .finally(() => setDetailLoading(false));
    loadDocs(deal.id);
  };

  const closeDetail = () => { setSelectedDeal(null); setDetailDeal(null); };

  // ── filters ──
  const leads = Array.from(new Set(deals.map(d => d.deal_lead).filter(Boolean))).sort();
  const filtered = deals.filter(d => {
    if (filterBrand !== 'all' && d.brand !== filterBrand) return false;
    if (filterType !== 'all' && d.deal_type !== filterType) return false;
    if (filterState !== 'all' && d.state !== filterState) return false;
    if (filterStage !== 'all' && d.stage !== filterStage) return false;
    if (filterLead !== 'all' && d.deal_lead !== filterLead) return false;
    return true;
  });

  // ── dates by deal ──
  const datesByDeal = React.useMemo(() => {
    const m = {};
    for (const d of allDates) (m[d.deal_id] = m[d.deal_id] || []).push(d);
    return m;
  }, [allDates]);

  // ── KPI header ──
  const totalActive = deals.length;
  const totalPurchaseCapital = deals.filter(d => d.deal_type === 'purchase').reduce((s, d) => s + (Number(d.purchase_price) || 0), 0);
  const totalBaseRent = deals.filter(d => d.deal_type === 'lease').reduce((s, d) => s + (Number(d.base_rent) || 0), 0);
  const leaseCount = deals.filter(d => d.deal_type === 'lease').length;
  const purchaseCount = deals.filter(d => d.deal_type === 'purchase').length;

  // deadline KPIs
  const nowMs = Date.now();
  const dealFlagMap = React.useMemo(() => {
    const m = {};
    for (const deal of deals) m[deal.id] = dealDeadlineFlag(datesByDeal[deal.id], nowMs);
    return m;
  }, [deals, datesByDeal, nowMs]);

  const within30 = deals.filter(d => { const nd = nextDeadline(datesByDeal[d.id], nowMs); return nd && nd.daysOut <= 30 && nd.daysOut >= 0; }).length;
  const within60 = deals.filter(d => { const nd = nextDeadline(datesByDeal[d.id], nowMs); return nd && nd.daysOut <= 60 && nd.daysOut >= 0; }).length;
  const within90 = deals.filter(d => { const nd = nextDeadline(datesByDeal[d.id], nowMs); return nd && nd.daysOut <= 90 && nd.daysOut >= 0; }).length;
  const overdueCount = deals.filter(d => dealFlagMap[d.id]?.level === 'overdue').length;
  const warningCount = deals.filter(d => dealFlagMap[d.id]?.level === 'warning').length;

  const kpiCards = [
    { label: 'Active Deals', value: totalActive, color: '#3b82f6' },
    { label: 'Leases', value: leaseCount, color: '#22c55e' },
    { label: 'Purchases', value: purchaseCount, color: '#f59e0b' },
    { label: 'Pipeline Base Rent', value: fmtDollars(totalBaseRent), color: '#a855f7' },
    { label: 'Committed Capital', value: fmtDollars(totalPurchaseCapital), color: '#ef4444' },
    { label: 'Due ≤30d', value: within30, color: within30 > 0 ? '#ef4444' : '#64748b' },
    { label: 'Due ≤60d', value: within60, color: '#f59e0b' },
    { label: 'Due ≤90d', value: within90, color: '#64748b' },
    { label: 'Overdue / Warning', value: `${overdueCount > 0 ? '🔴' : ''}${overdueCount} / ${warningCount > 0 ? '🟡' : ''}${warningCount}`, color: overdueCount > 0 ? '#ef4444' : warningCount > 0 ? '#f59e0b' : '#64748b' },
  ];

  // ── chip helpers ──
  const Chip = ({ label, color, small }) => (
    <span style={{
      display: 'inline-block', padding: small ? '1px 6px' : '2px 8px',
      borderRadius: 999, background: `${color}22`, color,
      fontSize: small ? '0.62rem' : '0.68rem', fontWeight: 700, letterSpacing: 0.3,
    }}>{label}</span>
  );

  const BrandChip = ({ brand }) => brand ? <Chip label={BRAND_LABELS[brand] || brand} color={BRAND_COLORS[brand] || '#64748b'} small /> : null;
  const TypeChip = ({ type }) => <Chip label={type === 'lease' ? 'Lease' : 'Purchase'} color={type === 'lease' ? '#22c55e' : '#f59e0b'} small />;
  const StageChip = ({ stage }) => <Chip label={STAGE_MAP[stage] || stage} color={STAGE_COLORS[stage] || '#64748b'} small />;

  // ── move stage ──
  const doMoveStage = (deal, newStage) => {
    setActionErr(null);
    setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, stage: newStage } : d));
    if (detailDeal?.id === deal.id) setDetailDeal(prev => ({ ...prev, stage: newStage }));
    dealApi(token, { action: 'moveStage', id: deal.id, stage: newStage }).catch(e => {
      setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, stage: deal.stage } : d));
      setActionErr(`Could not move "${deal.name}": ${e.message}`);
    });
  };

  const doHandoff = (deal) => {
    if (!window.confirm(`Hand off "${deal.name}" to construction?`)) return;
    setActionErr(null);
    dealApi(token, { action: 'handoff', id: deal.id })
      .then(() => { setDeals(prev => prev.filter(d => d.id !== deal.id)); if (detailDeal?.id === deal.id) closeDetail(); })
      .catch(e => setActionErr(`Handoff failed: ${e.message}`));
  };

  const doMarkDead = (deal) => {
    if (!canEdit) return;
    setDeadFor(deal);
    setDeadReason(DEAD_REASONS[0]);
    setDeadNote('');
    setDeadErr(null);
  };

  const confirmMarkDead = () => {
    if (!canEdit || !deadFor) return;
    const note = deadNote.trim();
    const reason = note ? `${deadReason} — ${note}` : deadReason;
    const deal = deadFor;
    setDeadBusy(true); setDeadErr(null);
    dealApi(token, { action: 'markDead', id: deal.id, reason })
      .then(() => {
        setDeals(prev => prev.filter(d => d.id !== deal.id));
        setDeadFor(null);
        if (detailDeal?.id === deal.id) closeDetail();
      })
      .catch(e => setDeadErr(e.message))
      .finally(() => setDeadBusy(false));
  };

  const doSave = () => {
    if (!Object.keys(editFields).length) return;
    setSaving(true); setSaveMsg(null);
    dealApi(token, { action: 'update', id: detailDeal.id, deal: editFields })
      .then(r => {
        setDetailDeal(r.deal);
        setDeals(prev => prev.map(d => d.id === r.deal.id ? r.deal : d));
        setEditFields({});
        setSaveMsg('Saved!');
        setTimeout(() => setSaveMsg(null), 2000);
      })
      .catch(e => setSaveMsg('Error: ' + e.message))
      .finally(() => setSaving(false));
  };

  const doAddNote = () => {
    if (!newNote.trim()) return;
    setAddingNote(true); setNoteErr(null);
    dealApi(token, { action: 'addNote', id: detailDeal.id, note: newNote.trim() })
      .then(r => { setDetailNotes(r.notes || []); setNewNote(''); })
      .catch(e => setNoteErr(e.message))
      .finally(() => setAddingNote(false));
  };

  const doCreate = () => {
    if (!createForm.name.trim()) { setCreateError('Name is required'); return; }
    setCreating(true); setCreateError(null);
    dealApi(token, { action: 'create', deal: createForm })
      .then(r => {
        setDeals(prev => [r.deal, ...prev]);
        setShowCreate(false);
        setCreateForm({ name: '', deal_type: 'lease', brand: 'dunkin', state: 'PA', address: '', deal_lead: '' });
        openDetail(r.deal);
      })
      .catch(e => setCreateError(e.message))
      .finally(() => setCreating(false));
  };

  // ── sort for table ──
  const sorted = [...filtered].sort((a, b) => {
    const va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
    const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  // ── early returns AFTER all hooks ──
  if (!token || !role) return (
    <div style={{ padding: '2rem', color: th.muted }}>You don't have access to the Deal Pipeline.</div>
  );
  if (loading) return <div style={{ padding: '2rem', color: th.muted }}>Loading deals…</div>;
  if (error) return <div style={{ padding: '2rem', color: '#ef4444' }}>Error: {error}</div>;

  const selLabel = inp(th);

  // ── Kanban ──
  const KanbanView = () => {
    const stageOrder = STAGES.map(s => s.id);
    return (
      <div style={{ display: 'flex', gap: '0.75rem', overflowX: 'auto', paddingBottom: '1rem', alignItems: 'flex-start', WebkitOverflowScrolling: 'touch', scrollSnapType: 'x proximity' }}>
        {stageOrder.map((stageId, si) => {
          const stageDeals = filtered.filter(d => d.stage === stageId);
          const color = STAGE_COLORS[stageId] || '#64748b';
          const isLast = si === stageOrder.length - 1;
          return (
            <div key={stageId} style={{ minWidth: 220, maxWidth: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem', scrollSnapAlign: 'start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.5rem', borderRadius: '0.5rem', background: `${color}18`, borderBottom: `2px solid ${color}` }}>
                <span style={{ fontSize: '0.72rem', fontWeight: 800, color, letterSpacing: 0.5, textTransform: 'uppercase' }}>{STAGE_MAP[stageId]}</span>
                <span style={{ marginLeft: 'auto', fontSize: '0.68rem', background: `${color}33`, color, borderRadius: 999, padding: '1px 7px', fontWeight: 700 }}>{stageDeals.length}</span>
              </div>
              {stageDeals.map(deal => {
                const prevStage = stageOrder[si - 1];
                const nextStage = stageOrder[si + 1];
                const flag = dealDeadlineFlag(datesByDeal[deal.id], Date.now());
                return (
                  <div key={deal.id}
                    onClick={() => openDetail(deal)}
                    style={{ ...card(th), padding: '0.65rem 0.75rem', cursor: 'pointer', borderLeft: `3px solid ${color}` }}>
                    <div style={{ fontWeight: 700, fontSize: '0.82rem', color: th.text, marginBottom: '0.25rem', lineHeight: 1.3 }}>{deal.name}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.3rem' }}>
                      {deal.brand && <BrandChip brand={deal.brand} />}
                      <TypeChip type={deal.deal_type} />
                    </div>
                    {deal.deal_lead && <div style={{ fontSize: '0.68rem', color: th.muted }}>{deal.deal_lead}</div>}
                    {deal.deal_type === 'lease' && deal.base_rent
                      ? <div style={{ fontSize: '0.72rem', color: th.muted, marginTop: '0.2rem' }}>{fmtDollars(deal.base_rent)}/mo</div>
                      : deal.purchase_price
                        ? <div style={{ fontSize: '0.72rem', color: th.muted, marginTop: '0.2rem' }}>{fmtDollars(deal.purchase_price)}</div>
                        : null}
                    {flag.level === 'overdue' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.3rem' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ fontSize: '0.65rem', color: '#ef4444', fontWeight: 700 }}>⚠ overdue</span>
                      </div>
                    )}
                    {flag.level === 'warning' && flag.nearest && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.3rem' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', display: 'inline-block', flexShrink: 0 }} />
                        <span style={{ fontSize: '0.65rem', color: '#f59e0b', fontWeight: 700 }}>next: {dateLabel(flag.nearest.date_type)} in {flag.nearest.daysOut}d</span>
                      </div>
                    )}
                    {canEdit && (
                      <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.4rem' }} onClick={e => e.stopPropagation()}>
                        {prevStage && (
                          <button onClick={() => doMoveStage(deal, prevStage)} style={{ ...btn(th), padding: '2px 7px', fontSize: '0.68rem', lineHeight: 1 }}>◀</button>
                        )}
                        {nextStage && !isLast && (
                          <button onClick={() => doMoveStage(deal, nextStage)} style={{ ...btn(th), padding: '2px 7px', fontSize: '0.68rem', lineHeight: 1 }}>▶</button>
                        )}
                        {isLast && (
                          <button onClick={() => doHandoff(deal)} style={{ ...btn(th), background: '#a855f71f', border: '1px solid #a855f755', padding: '2px 7px', fontSize: '0.68rem', lineHeight: 1, color: '#a855f7' }}>Hand off →</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  };

  // ── Table ──
  const TableView = () => {
    const cols = [
      { key: 'name', label: 'Name' },
      { key: 'brand', label: 'Brand' },
      { key: 'deal_type', label: 'Type' },
      { key: 'state', label: 'State' },
      { key: 'stage', label: 'Stage' },
      { key: 'deal_lead', label: 'Lead' },
      { key: 'base_rent', label: 'Base Rent' },
      { key: 'purchase_price', label: 'Purchase $' },
      { key: '_deadline', label: 'Deadline', noSort: true },
    ];
    return (
      <div style={{ ...card(th), overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ background: th.sidebar, color: th.muted, textAlign: 'left' }}>
              {cols.map(c => (
                <th key={c.key} onClick={() => !c.noSort && toggleSort(c.key)}
                  style={{ padding: '0.6rem 0.75rem', fontWeight: 700, cursor: c.noSort ? 'default' : 'pointer', whiteSpace: 'nowrap', userSelect: 'none' }}>
                  {c.label}{!c.noSort && sortCol === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(d => {
              const tf = dealDeadlineFlag(datesByDeal[d.id], Date.now());
              return (
                <tr key={d.id} onClick={() => openDetail(d)}
                  style={{ cursor: 'pointer', borderTop: `1px solid ${th.cardBorder}`, color: th.text }}>
                  <td style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>{d.name}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}><BrandChip brand={d.brand} /></td>
                  <td style={{ padding: '0.5rem 0.75rem' }}><TypeChip type={d.deal_type} /></td>
                  <td style={{ padding: '0.5rem 0.75rem', color: th.muted }}>{d.state}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}><StageChip stage={d.stage} /></td>
                  <td style={{ padding: '0.5rem 0.75rem', color: th.muted }}>{d.deal_lead || '—'}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>{d.base_rent ? fmtDollars(d.base_rent) : '—'}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>{d.purchase_price ? fmtDollars(d.purchase_price) : '—'}</td>
                  <td style={{ padding: '0.5rem 0.75rem' }}>
                    {tf.level === 'overdue' && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                        <span style={{ fontSize: '0.68rem', color: '#ef4444', fontWeight: 700 }}>overdue</span>
                      </span>
                    )}
                    {tf.level === 'warning' && tf.nearest && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                        <span style={{ fontSize: '0.68rem', color: '#f59e0b', fontWeight: 700 }}>{tf.nearest.daysOut}d</span>
                      </span>
                    )}
                    {tf.level === 'none' && <span style={{ color: th.muted, fontSize: '0.68rem' }}>—</span>}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr><td colSpan={9} style={{ padding: '1.5rem', textAlign: 'center', color: th.muted }}>No deals match filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    );
  };

  // ── Detail modal ──
  const DetailModal = () => {
    if (!selectedDeal) return null;
    const d = detailDeal || selectedDeal;
    const fv = (key) => editFields[key] !== undefined ? editFields[key] : (d[key] ?? '');
    const set = (key, val) => setEditFields(prev => ({ ...prev, [key]: val }));
    const Field = ({ label, fkey, type = 'text', readOnly = false }) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        <label style={{ fontSize: '0.65rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</label>
        {canEdit && !readOnly ? (
          <input type={type} value={fv(fkey)} onChange={e => set(fkey, e.target.value)}
            style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }} />
        ) : (
          <div style={{ fontSize: '0.82rem', color: th.text, padding: '0.2rem 0' }}>{d[fkey] ?? '—'}</div>
        )}
      </div>
    );
    const SelectField = ({ label, fkey, options }) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        <label style={{ fontSize: '0.65rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</label>
        {canEdit ? (
          <select value={fv(fkey)} onChange={e => set(fkey, e.target.value)}
            style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }}>
            {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: '0.82rem', color: th.text, padding: '0.2rem 0' }}>{d[fkey] ?? '—'}</div>
        )}
      </div>
    );
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', justifyContent: 'flex-end' }}>
        <div onClick={closeDetail} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} />
        <div style={{ position: 'relative', width: '100%', maxWidth: 640, background: th.bg, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem', boxShadow: '-8px 0 30px rgba(0,0,0,0.4)', zIndex: 1 }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
            <div>
              <h2 style={{ fontFamily: "'Raleway'", fontWeight: 800, color: th.text, margin: 0, fontSize: '1.2rem' }}>{d.name}</h2>
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                <BrandChip brand={d.brand} />
                <TypeChip type={d.deal_type} />
                <StageChip stage={d.stage} />
                {d.state && <Chip label={d.state} color="#64748b" small />}
              </div>
            </div>
            <button onClick={closeDetail} style={{ ...btn(th), padding: '0.3rem 0.7rem', fontSize: '0.8rem', flexShrink: 0 }}>✕</button>
          </div>

          {detailLoading && <div style={{ color: th.muted, fontSize: '0.85rem' }}>Loading…</div>}
          {detailError && <div style={{ color: '#ef4444', fontSize: '0.85rem' }}>Error: {detailError}</div>}

          {/* Actions */}
          {canEdit && !detailLoading && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <select value={d.stage} onChange={e => doMoveStage(d, e.target.value)}
                style={{ ...selLabel, padding: '0.35rem 0.6rem', fontSize: '0.8rem' }}>
                {STAGES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <button onClick={() => doHandoff(d)} style={{ ...btn(th), background: '#a855f71f', border: '1px solid #a855f755', padding: '0.35rem 0.8rem', fontSize: '0.8rem', color: '#a855f7' }}>Hand off →</button>
              <button onClick={() => doMarkDead(d)} style={{ ...btn(th), background: '#ef44441f', border: '1px solid #ef444455', padding: '0.35rem 0.8rem', fontSize: '0.8rem', color: '#ef4444' }}>Mark Dead</button>
            </div>
          )}

          {/* Core fields */}
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 800, color: th.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: '0.6rem' }}>Core</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              {Field({ label: "Name", fkey: "name" })}
              {Field({ label: "Address", fkey: "address" })}
              {Field({ label: "City", fkey: "city" })}
              {SelectField({ label: "State", fkey: "state", options: [{v:'PA',l:'PA'},{v:'NJ',l:'NJ'}] })}
              {SelectField({ label: "Brand", fkey: "brand", options: [{v:'dunkin',l:"Dunkin'"},{v:'papajohns',l:'Papa Johns'},{v:'bww_go',l:'BWW Go'},{v:'dual',l:'Dual'}] })}
              {SelectField({ label: "Deal Type", fkey: "deal_type", options: [{v:'lease',l:'Lease'},{v:'purchase',l:'Purchase'}] })}
              {(() => {
                const currentVal = fv('deal_lead');
                const inList = dealLeads.some(l => l.name === currentVal);
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <label style={{ fontSize: '0.65rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Deal Lead</label>
                    {canEdit ? (
                      <select value={currentVal} onChange={e => set('deal_lead', e.target.value)}
                        style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }}>
                        <option value="">— Select Lead —</option>
                        {!inList && currentVal && <option value={currentVal}>{currentVal}</option>}
                        {dealLeads.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
                      </select>
                    ) : (
                      <div style={{ fontSize: '0.82rem', color: th.text, padding: '0.2rem 0' }}>{d['deal_lead'] ?? '—'}</div>
                    )}
                  </div>
                );
              })()}
              {Field({ label: "Broker Source", fkey: "broker_source" })}
              {Field({ label: "PC Number", fkey: "pc_number" })}
              {Field({ label: "Sq Ft", fkey: "sqft", type: "number" })}
            </div>
          </div>

          {/* Lease terms */}
          {d.deal_type === 'lease' && (
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: th.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: '0.6rem' }}>Lease Terms</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                {Field({ label: "Landlord Entity", fkey: "landlord_entity" })}
                {Field({ label: "Landlord Contact", fkey: "landlord_contact" })}
                {Field({ label: "Lease Structure", fkey: "lease_structure" })}
                {Field({ label: "Base Rent ($/mo)", fkey: "base_rent", type: "number" })}
                {Field({ label: "Rent PSF", fkey: "rent_psf", type: "number" })}
                {Field({ label: "Term (years)", fkey: "term_years", type: "number" })}
                {Field({ label: "TI Allowance", fkey: "ti_allowance", type: "number" })}
                {Field({ label: "Free Rent (mo)", fkey: "free_rent", type: "number" })}
                {Field({ label: "Est NNN/CAM", fkey: "est_nnn_cam", type: "number" })}
                {Field({ label: "CAM Cap", fkey: "cam_cap" })}
                {Field({ label: "Guaranty Type", fkey: "guaranty_type" })}
                {Field({ label: "Use Clause", fkey: "use_clause" })}
                {Field({ label: "Exclusivity", fkey: "exclusivity" })}
                {Field({ label: "Escalations", fkey: "escalations" })}
                {Field({ label: "Renewal Options", fkey: "renewal_options" })}
                {Field({ label: "Security Deposit", fkey: "security_deposit", type: "number" })}
              </div>
            </div>
          )}

          {/* Purchase terms */}
          {d.deal_type === 'purchase' && (
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: 800, color: th.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: '0.6rem' }}>Purchase Terms</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                {Field({ label: "Seller Entity", fkey: "seller_entity" })}
                {Field({ label: "Seller Contact", fkey: "seller_contact" })}
                {Field({ label: "Purchase Price", fkey: "purchase_price", type: "number" })}
                {Field({ label: "Earnest Money", fkey: "earnest_money", type: "number" })}
                {Field({ label: "EMD Hard Date", fkey: "emd_hard" })}
                {Field({ label: "Title/Escrow Co", fkey: "title_escrow_co" })}
                {Field({ label: "Lender", fkey: "lender" })}
                {Field({ label: "Loan Terms", fkey: "loan_terms" })}
                {Field({ label: "Appraisal Status", fkey: "appraisal_status" })}
                {Field({ label: "Phase 1 Status", fkey: "phase1_status" })}
                {Field({ label: "Survey Status", fkey: "survey_status" })}
                {Field({ label: "Zoning Status", fkey: "zoning_status" })}
              </div>
            </div>
          )}

          {/* SPE */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            {Field({ label: "SPE Entity", fkey: "spe_entity" })}
          </div>

          {/* Save */}
          {canEdit && Object.keys(editFields).length > 0 && (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button onClick={doSave} disabled={saving} style={{ ...btn(th), padding: '0.45rem 1.2rem', fontWeight: 700, background: '#3b82f6', color: '#fff', border: 'none' }}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              {saveMsg && <span style={{ fontSize: '0.8rem', color: saveMsg.startsWith('Error') ? '#ef4444' : '#22c55e' }}>{saveMsg}</span>}
            </div>
          )}

          {/* Activity Log (notes + system events) */}
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 800, color: th.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: '0.6rem' }}>Activity Log</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
              {detailNotes.length === 0 && <div style={{ fontSize: '0.8rem', color: th.muted }}>No activity yet.</div>}
              {detailNotes.map((n, i) => {
                const isSys = n.kind === 'system';
                return (
                <div key={i} style={{ ...card(th), padding: '0.6rem 0.75rem',
                  ...(isSys ? { borderLeft: `3px solid ${O}`, background: th.bg, opacity: 0.95 } : {}) }}>
                  <div style={{ fontSize: '0.68rem', color: th.muted, marginBottom: '0.2rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    {isSys && <span style={{ fontSize: '0.58rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: O, background: O + '22', padding: '0.05rem 0.35rem', borderRadius: 4 }}>System</span>}
                    <strong style={{ color: th.text }}>{n.author || 'Unknown'}</strong>
                    {n.created_at ? <span> · {relTime(n.created_at)}</span> : ''}
                  </div>
                  <div style={{ fontSize: '0.82rem', color: th.text, fontStyle: isSys ? 'italic' : 'normal' }}>{n.body || n.note}</div>
                </div>
              ); })}
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input value={newNote} onChange={e => setNewNote(e.target.value)}
                  placeholder="Add a note…"
                  style={{ ...selLabel, flex: 1, padding: '0.4rem 0.6rem', fontSize: '0.82rem' }}
                  onKeyDown={e => e.key === 'Enter' && doAddNote()} />
                <button onClick={doAddNote} disabled={addingNote || !newNote.trim()}
                  style={{ ...btn(th), padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
                  {addingNote ? '…' : 'Add'}
                </button>
              </div>
            )}
            {noteErr && <div style={{ fontSize: '0.75rem', color: '#ef4444', marginTop: '0.4rem' }}>Error: {noteErr}</div>}
          </div>

          {/* Documents */}
          {/* Critical Dates */}
          {(() => {
            const nowMsD = Date.now();
            const sortedDates = [...detailDates].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

            const doAck = (dateId) => {
              dealApi(token, { action: 'ackDate', id: dateId })
                .then(() => dealApi(token, { action: 'get', id: d.id }))
                .then(r => { setDetailDates(r.dates || []); setDetailNotes(r.notes || []); })
                .then(() => loadList())
                .catch(e => alert('Ack failed: ' + e.message));
            };

            const doDelDate = (dateId) => {
              if (!window.confirm('Delete this date?')) return;
              dealApi(token, { action: 'deleteDate', id: dateId })
                .then(() => dealApi(token, { action: 'get', id: d.id }))
                .then(r => { setDetailDates(r.dates || []); setDetailNotes(r.notes || []); })
                .then(() => loadList())
                .catch(e => alert('Delete failed: ' + e.message));
            };

            const doAddDate = () => {
              if (!newDateDue) { setDateErr('Due date is required'); return; }
              const parsedTiers = newDateTiers.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
              setDateAdding(true); setDateErr(null);
              dealApi(token, { action: 'addDate', deal_id: d.id, date_type: newDateType, due_date: newDateDue, warning_tiers: parsedTiers, recurring: newDateRecurring || null, notes: newDateNotes })
                .then(() => dealApi(token, { action: 'get', id: d.id }))
                .then(r => {
                  setDetailDates(r.dates || []);
                  setNewDateDue(''); setNewDateNotes(''); setNewDateRecurring('');
                  const dt = DATE_TYPES.find(t => t.id === newDateType);
                  setNewDateTiers(dt?.defaultTiers?.join(',') || '');
                })
                .then(() => loadList())
                .catch(e => setDateErr(e.message))
                .finally(() => setDateAdding(false));
            };

            const doIcs = () => {
              const ics = icsForDeal(d, detailDates);
              const blob = new Blob([ics], { type: 'text/calendar' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = (d.name || 'deal') + '-dates.ics';
              document.body.appendChild(a); a.click();
              document.body.removeChild(a); URL.revokeObjectURL(url);
            };

            const gcalUrl = (dt) => {
              const ymd = String(dt.due_date || '').slice(0,10).replace(/-/g,'');
              if (ymd.length !== 8) return '#';
              const start = ymd;
              const dd = new Date(+ymd.slice(0,4), +ymd.slice(4,6)-1, +ymd.slice(6,8)+1);
              const end = `${dd.getFullYear()}${String(dd.getMonth()+1).padStart(2,'0')}${String(dd.getDate()).padStart(2,'0')}`;
              const title = `${detailDeal.name ? detailDeal.name + ' — ' : ''}${dateLabel(dt.date_type)}`;
              const details = dt.notes || '';
              return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${start}/${end}&details=${encodeURIComponent(details)}`;
            };

            return (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 800, color: th.muted, textTransform: 'uppercase', letterSpacing: 1 }}>Critical Dates</div>
                  {detailDates.length > 0 && (
                    <button onClick={doIcs} style={{ ...btn(th), padding: '2px 8px', fontSize: '0.7rem' }}>📅 Add to Calendar (.ics)</button>
                  )}
                </div>

                {sortedDates.length === 0 && <div style={{ fontSize: '0.8rem', color: th.muted, marginBottom: '0.5rem' }}>No dates yet.</div>}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
                  {sortedDates.map(dt => {
                    const ws = warningStatus(dt.due_date, dt.warning_tiers, nowMsD);
                    const statusColor = ws.level === 'overdue' ? '#ef4444' : ws.level === 'warning' ? '#f59e0b' : th.muted;
                    const statusText = ws.level === 'overdue' ? '⚠ overdue' : ws.level === 'warning' ? `in ${ws.daysOut}d` : `in ${ws.daysOut}d`;
                    const tiers = Array.isArray(dt.warning_tiers) ? dt.warning_tiers : [];
                    const isRemindOpen = remindFor && remindFor.id === dt.id;

                    // Date-only display: slice YYYY-MM-DD first (handles Neon ISO timestamps + avoids TZ off-by-one), then MM/DD/YYYY.
                    const fmtDealDate = (s) => { const ymd = String(s || '').slice(0, 10); const p = ymd.split('-'); return p.length === 3 ? `${p[1]}/${p[2]}/${p[0]}` : ymd; };
                    const openReminder = (dateRow) => {
                      const due = dateRow.due_date || '';
                      const dueFmt = fmtDealDate(due);
                      const days = daysUntil(due, Date.now());
                      const tail = days < 0
                        ? `— OVERDUE by ${Math.abs(days)} days`
                        : `— in ${days} days`;
                      const autoMsg = `${detailDeal.name} — ${dateLabel(dateRow.date_type)} needed on ${dueFmt} ${tail}`;
                      setRemindFor(dateRow);
                      setRemindPhone('');
                      setRemindMsg(autoMsg);
                      setRemindStatus(null);
                    };

                    const doSendReminder = async () => {
                      setRemindBusy(true); setRemindStatus(null);
                      try {
                        const r = await dealApi(token, { action: 'sendReminder', deal_id: detailDeal.id, phone: remindPhone, message: remindMsg });
                        if (r.notes) setDetailNotes(r.notes);
                        setRemindStatus(r.ok ? '✅ Sent' : '⚠ Logged but SMS failed');
                        if (r.ok) setTimeout(() => { setRemindFor(null); setRemindStatus(null); }, 1800);
                      } catch (e) {
                        setRemindStatus('❌ Error: ' + e.message);
                      } finally {
                        setRemindBusy(false);
                      }
                    };

                    return (
                      <div key={dt.id}>
                        <div style={{ ...card(th), padding: '0.6rem 0.75rem' }}>
                          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                <span style={{ fontSize: '0.82rem', fontWeight: 700, color: th.text }}>{dateLabel(dt.date_type)}</span>
                                <span style={{ fontSize: '0.75rem', color: th.muted }}>·</span>
                                <span style={{ fontSize: '0.75rem', color: th.muted }}>{fmtDealDate(dt.due_date)}</span>
                                <span style={{ fontSize: '0.75rem', color: th.muted }}>·</span>
                                <span style={{ fontSize: '0.72rem', fontWeight: 700, color: statusColor }}>{statusText}</span>
                                {dt.recurring && (
                                  <span title={`Recurring (${dt.recurring})`} style={{ fontSize: '0.72rem', color: th.muted, fontWeight: 700 }}>🔁 {dt.recurring}</span>
                                )}
                                {tiers.length > 0 && (
                                  <span style={{ display: 'inline-flex', gap: '0.2rem' }}>
                                    {tiers.map((t, i) => (
                                      <span key={i} style={{ display: 'inline-block', padding: '1px 5px', borderRadius: 999, background: `${th.cardBorder}`, color: th.muted, fontSize: '0.6rem', fontWeight: 700 }}>{t}</span>
                                    ))}
                                  </span>
                                )}
                              </div>
                              {dt.acknowledged_at ? (
                                <div style={{ fontSize: '0.68rem', color: '#22c55e' }}>✓ ack'd by {dt.acknowledged_by || 'unknown'}</div>
                              ) : null}
                              {dt.notes ? <div style={{ fontSize: '0.72rem', color: th.muted, marginTop: '0.1rem' }}>{dt.notes}</div> : null}
                            </div>
                            <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0, flexWrap: 'wrap' }}>
                              <a href={gcalUrl(dt)} target="_blank" rel="noopener noreferrer" style={{ ...btn(th), background: '#4285f41f', border: '1px solid #4285f455', color: '#4285f4', padding: '2px 8px', fontSize: '0.68rem', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>📅 Google</a>
                              {canEdit && (
                                <button onClick={() => isRemindOpen ? setRemindFor(null) : openReminder(dt)}
                                  style={{ ...btn(th), background: '#a855f71f', border: '1px solid #a855f755', padding: '2px 8px', fontSize: '0.68rem', color: '#a855f7' }}>📱 Remind</button>
                              )}
                              {canEdit && !dt.acknowledged_at && (
                                <>
                                  <button onClick={() => doAck(dt.id)} style={{ ...btn(th), background: '#22c55e1f', border: '1px solid #22c55e55', padding: '2px 8px', fontSize: '0.68rem', color: '#22c55e' }}>Acknowledge</button>
                                  <button onClick={() => doDelDate(dt.id)} style={{ ...btn(th), background: '#ef44441f', border: '1px solid #ef444455', padding: '2px 8px', fontSize: '0.68rem', color: '#ef4444' }}>Delete</button>
                                </>
                              )}
                              {canEdit && dt.acknowledged_at && (
                                <button onClick={() => doDelDate(dt.id)} style={{ ...btn(th), background: '#ef44441f', border: '1px solid #ef444455', padding: '2px 8px', fontSize: '0.68rem', color: '#ef4444' }}>Delete</button>
                              )}
                            </div>
                          </div>
                        </div>
                        {isRemindOpen && (
                          <div style={{ ...card(th), padding: '0.75rem', marginTop: '0.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', borderLeft: '3px solid #a855f7' }}>
                            <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#a855f7', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                              Send reminder — {detailDeal.name}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                              <label style={{ fontSize: '0.72rem', color: th.muted, fontWeight: 600 }}>Recipient</label>
                              <select
                                value={remindPhone}
                                onChange={e => setRemindPhone(e.target.value)}
                                style={{ ...inp(th), fontSize: '0.82rem', padding: '0.35rem 0.5rem' }}
                              >
                                <option value="">— Select recipient —</option>
                                {dealLeads.map(l => (
                                  <option key={l.id} value={l.phone || ''} disabled={!l.phone}>
                                    {l.name}{l.phone ? ` — ${formatPhone(l.phone)}` : ' (no number on file)'}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <textarea
                              value={remindMsg}
                              onChange={e => setRemindMsg(e.target.value)}
                              rows={3}
                              style={{ ...inp(th), fontSize: '0.8rem', padding: '0.35rem 0.5rem', resize: 'vertical' }}
                            />
                            {remindStatus && (
                              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: remindStatus.startsWith('✅') ? '#22c55e' : remindStatus.startsWith('⚠') ? '#f59e0b' : '#ef4444' }}>
                                {remindStatus}
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              <button onClick={doSendReminder} disabled={remindBusy || !remindPhone}
                                style={{ ...btn(th), padding: '0.35rem 0.9rem', fontSize: '0.8rem', background: '#a855f7', color: '#fff', border: 'none', fontWeight: 700, opacity: (!remindPhone || remindBusy) ? 0.5 : 1 }}>
                                {remindBusy ? 'Sending…' : 'Send'}
                              </button>
                              <button onClick={() => { setRemindFor(null); setRemindStatus(null); }}
                                style={{ ...btn(th), padding: '0.35rem 0.9rem', fontSize: '0.8rem' }}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {canEdit && (
                  <div style={{ ...card(th), padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <div style={{ fontSize: '0.68rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Add Date</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                      <select value={newDateType}
                        onChange={e => {
                          setNewDateType(e.target.value);
                          const dt2 = DATE_TYPES.find(t => t.id === e.target.value);
                          setNewDateTiers(dt2?.defaultTiers?.join(',') || '');
                        }}
                        style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }}>
                        {DATE_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                      <input type="date" value={newDateDue} onChange={e => setNewDateDue(e.target.value)}
                        style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }} />
                      <input value={newDateTiers} onChange={e => setNewDateTiers(e.target.value)}
                        placeholder="Warning tiers (e.g. 30,14,7)"
                        style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }} />
                      <select value={newDateRecurring} onChange={e => setNewDateRecurring(e.target.value)}
                        style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }}>
                        <option value="">Does not recur</option>
                        <option value="monthly">🔁 Recurring — Monthly</option>
                        <option value="quarterly">🔁 Recurring — Quarterly</option>
                        <option value="annual">🔁 Recurring — Annual</option>
                      </select>
                      <input value={newDateNotes} onChange={e => setNewDateNotes(e.target.value)}
                        placeholder="Notes (optional)"
                        style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem' }} />
                    </div>
                    {dateErr && <div style={{ fontSize: '0.75rem', color: '#ef4444' }}>{dateErr}</div>}
                    <button onClick={doAddDate} disabled={dateAdding} style={{ ...btn(th), padding: '0.35rem 0.9rem', fontSize: '0.8rem', alignSelf: 'flex-start', background: '#3b82f6', color: '#fff', border: 'none', fontWeight: 700 }}>
                      {dateAdding ? 'Adding…' : 'Add Date'}
                    </button>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Documents */}
          {(() => {
            const DOC_TYPE_LABELS = {
              loi: 'LOI', lease_psa: 'Lease / PSA', amendment: 'Amendment',
              estoppel: 'Estoppel', snda: 'SNDA', title: 'Title',
              survey: 'Survey', phase1: 'Phase I', zoning: 'Zoning',
              appraisal: 'Appraisal', guaranty: 'Guaranty', closing: 'Closing',
              other: 'Other',
            };
            const DOC_TYPE_OPTIONS = Object.entries(DOC_TYPE_LABELS);
            const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(0) + ' KB' : (n || 0) + ' B';
            const fmtDate = (s) => s ? new Date(s).toLocaleDateString() : '';

            const doUploadNew = async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              e.target.value = '';
              setDocBusy(true); setDocErr(null);
              try {
                await dealUploadDoc(token, { deal_id: d.id, doc_type: newDocType, file });
                loadDocs(d.id);
              } catch (err) {
                setDocErr(err.message);
              } finally {
                setDocBusy(false);
              }
            };

            const doUploadVersion = async (doc, e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              e.target.value = '';
              setDocBusy(true); setDocErr(null);
              try {
                await dealUploadDoc(token, { deal_id: d.id, document_id: doc.id, doc_type: doc.doc_type, file });
                loadDocs(d.id);
              } catch (err) {
                setDocErr(err.message);
              } finally {
                setDocBusy(false);
              }
            };

            const sortedDocs = [...docs].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

            return (
              <div>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: th.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: '0.6rem' }}>Documents</div>
                {docErr && <div style={{ fontSize: '0.78rem', color: '#ef4444', marginBottom: '0.5rem' }}>Error: {docErr}</div>}

                {sortedDocs.length === 0 && !docBusy && (
                  <div style={{ fontSize: '0.8rem', color: th.muted, marginBottom: '0.75rem' }}>No documents yet.</div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '0.75rem' }}>
                  {sortedDocs.map(doc => {
                    const versions = [...docVersions.filter(v => v.document_id === doc.id)]
                      .sort((a, b) => b.version_no - a.version_no);
                    return (
                      <div key={doc.id} style={{ ...card(th), padding: '0.65rem 0.75rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.3rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 999, background: '#3b82f622', color: '#3b82f6', fontSize: '0.62rem', fontWeight: 700, letterSpacing: 0.3 }}>
                              {DOC_TYPE_LABELS[doc.doc_type] || doc.doc_type}
                            </span>
                            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: th.text }}>{doc.title || '—'}</span>
                          </div>
                          {canEdit && (
                            <label style={{ cursor: docBusy ? 'not-allowed' : 'pointer' }}>
                              <span style={{ ...btn(th), padding: '2px 8px', fontSize: '0.68rem', opacity: docBusy ? 0.5 : 1 }}>↑ New version</span>
                              <input type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx,.txt,.csv" style={{ display: 'none' }} disabled={docBusy} onChange={e => doUploadVersion(doc, e)} />
                            </label>
                          )}
                        </div>
                        {versions.length === 0 && (
                          <div style={{ fontSize: '0.75rem', color: th.muted }}>No versions uploaded.</div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                          {versions.map(v => (
                            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                              <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 999, background: `${th.cardBorder}`, color: th.muted, fontSize: '0.62rem', fontWeight: 700 }}>
                                v{v.version_no}
                              </span>
                              <span style={{ fontSize: '0.75rem', color: th.text, fontWeight: 500 }}>{v.filename}</span>
                              <span style={{ fontSize: '0.68rem', color: th.muted }}>{fmtBytes(v.size)}</span>
                              <span style={{ fontSize: '0.68rem', color: th.muted }}>·</span>
                              <span style={{ fontSize: '0.68rem', color: th.muted }}>{v.uploaded_by}</span>
                              <span style={{ fontSize: '0.68rem', color: th.muted }}>·</span>
                              <span style={{ fontSize: '0.68rem', color: th.muted }}>{fmtDate(v.uploaded_at)}</span>
                              <button onClick={() => dealDownloadVersion(token, v.id)}
                                style={{ ...btn(th), padding: '1px 8px', fontSize: '0.68rem', marginLeft: 'auto' }}>
                                Download
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {canEdit && (
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <select value={newDocType} onChange={e => setNewDocType(e.target.value)}
                      style={{ ...selLabel, padding: '0.35rem 0.5rem', fontSize: '0.8rem', minWidth: 130 }}>
                      {DOC_TYPE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <label style={{ cursor: docBusy ? 'not-allowed' : 'pointer' }}>
                      <span style={{ ...btn(th), padding: '0.35rem 0.8rem', fontSize: '0.8rem', opacity: docBusy ? 0.5 : 1, display: 'inline-block' }}>
                        {docBusy ? 'Uploading…' : 'Upload Document'}
                      </span>
                      <input type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.doc,.docx,.xls,.xlsx,.txt,.csv" style={{ display: 'none' }} disabled={docBusy} onChange={doUploadNew} />
                    </label>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  // ── Create modal ──
  const CreateModal = () => {
    if (!showCreate) return null;
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div onClick={() => setShowCreate(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} />
        <div style={{ position: 'relative', background: th.bg, borderRadius: '0.75rem', padding: '1.5rem', width: '100%', maxWidth: 480, boxShadow: '0 8px 40px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h3 style={{ fontFamily: "'Raleway'", fontWeight: 800, color: th.text, margin: 0 }}>New Deal</h3>
          {[
            { label: 'Name', key: 'name', type: 'text' },
            { label: 'Address', key: 'address', type: 'text' },
          ].map(f => (
            <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              <label style={{ fontSize: '0.68rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{f.label}</label>
              <input type={f.type} value={createForm[f.key]} onChange={e => setCreateForm(p => ({ ...p, [f.key]: e.target.value }))}
                style={{ ...selLabel, padding: '0.4rem 0.6rem', fontSize: '0.85rem' }} />
            </div>
          ))}
          {[
            { label: 'Deal Type', key: 'deal_type', options: [{v:'lease',l:'Lease'},{v:'purchase',l:'Purchase'}] },
            { label: 'Brand', key: 'brand', options: [{v:'dunkin',l:"Dunkin'"},{v:'papajohns',l:'Papa Johns'},{v:'bww_go',l:'BWW Go'},{v:'dual',l:'Dual'}] },
            { label: 'State', key: 'state', options: [{v:'PA',l:'PA'},{v:'NJ',l:'NJ'}] },
          ].map(f => (
            <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
              <label style={{ fontSize: '0.68rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{f.label}</label>
              <select value={createForm[f.key]} onChange={e => setCreateForm(p => ({ ...p, [f.key]: e.target.value }))}
                style={{ ...selLabel, padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}>
                {f.options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
            <label style={{ fontSize: '0.68rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Deal Lead</label>
            <select value={createForm.deal_lead} onChange={e => setCreateForm(p => ({ ...p, deal_lead: e.target.value }))}
              style={{ ...selLabel, padding: '0.4rem 0.6rem', fontSize: '0.85rem' }}>
              <option value="">— Select Lead —</option>
              {dealLeads.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
            </select>
          </div>
          {createError && <div style={{ color: '#ef4444', fontSize: '0.82rem' }}>{createError}</div>}
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button onClick={() => setShowCreate(false)} style={{ ...btn(th), padding: '0.45rem 0.9rem' }}>Cancel</button>
            <button onClick={doCreate} disabled={creating} style={{ ...btn(th), padding: '0.45rem 1.2rem', fontWeight: 700, background: '#3b82f6', color: '#fff', border: 'none' }}>
              {creating ? 'Creating…' : 'Create Deal'}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: '1rem' }}>
      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h2 style={{ fontFamily: "'Raleway'", fontWeight: 800, color: th.text, margin: 0 }}>Deal Pipeline</h2>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: '0.25rem', background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: '0.5rem', padding: '0.2rem' }}>
            {['kanban','table'].map(v => (
              <button key={v} onClick={() => setView(v)}
                style={{ padding: '0.3rem 0.75rem', borderRadius: '0.35rem', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: '0.78rem',
                  background: view === v ? '#3b82f6' : 'transparent', color: view === v ? '#fff' : th.muted, transition: 'all .15s' }}>
                {v === 'kanban' ? 'Dealboard' : 'Table'}
              </button>
            ))}
          </div>
          {canEdit && (
            <button onClick={() => setShowCreate(true)} style={{ ...btn(th), padding: '0.4rem 0.9rem', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', fontSize: '0.82rem' }}>
              + New Deal
            </button>
          )}
          {role === 'admin' && (
            <button onClick={() => setShowAccess(true)} style={{ ...btn(th), padding: '0.4rem 0.9rem', fontWeight: 700, background: th.card, color: th.text, border: `1px solid ${th.cardBorder}`, fontSize: '0.82rem' }}>
              🔒 Manage Access
            </button>
          )}
        </div>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {kpiCards.map(k => (
          <div key={k.label} style={{ ...card(th), padding: '1rem 1.125rem', borderTop: `3px solid ${k.color}` }}>
            <div style={{ fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1.45rem', color: th.text }}>{k.value}</div>
            <div style={{ fontSize: '0.68rem', fontWeight: 600, color: th.muted, marginTop: '0.3rem', textTransform: 'uppercase', letterSpacing: 0.5 }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Stage chips summary */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '1rem' }}>
        {STAGES.map(s => {
          const cnt = deals.filter(d => d.stage === s.id).length;
          if (!cnt) return null;
          return <Chip key={s.id} label={`${s.label}: ${cnt}`} color={STAGE_COLORS[s.id]} small />;
        })}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {[
          { label: 'Brand', val: filterBrand, set: setFilterBrand, opts: [['all','All Brands'],['dunkin',"Dunkin'"],['papajohns','Papa Johns'],['bww_go','BWW Go'],['dual','Dual']] },
          { label: 'Type', val: filterType, set: setFilterType, opts: [['all','All Types'],['lease','Lease'],['purchase','Purchase']] },
          { label: 'State', val: filterState, set: setFilterState, opts: [['all','All States'],['PA','PA'],['NJ','NJ']] },
          { label: 'Stage', val: filterStage, set: setFilterStage, opts: [['all','All Stages'], ...STAGES.map(s => [s.id, s.label])] },
          { label: 'Lead', val: filterLead, set: setFilterLead, opts: [['all','All Leads'], ...leads.map(l => [l, l])] },
        ].map(f => (
          <select key={f.label} value={f.val} onChange={e => f.set(e.target.value)}
            style={{ ...selLabel, padding: '0.35rem 0.6rem', fontSize: '0.8rem', minWidth: 110 }}>
            {f.opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        ))}
        {(filterBrand !== 'all' || filterType !== 'all' || filterState !== 'all' || filterStage !== 'all' || filterLead !== 'all') && (
          <button onClick={() => { setFilterBrand('all'); setFilterType('all'); setFilterState('all'); setFilterStage('all'); setFilterLead('all'); }}
            style={{ ...btn(th), background: '#ef44441f', border: '1px solid #ef444455', padding: '0.35rem 0.7rem', fontSize: '0.78rem', color: '#ef4444' }}>
            Clear
          </button>
        )}
      </div>

      {/* Inline error banner for board-level actions (stage move / handoff) */}
      {actionErr && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#ef444418', border: '1px solid #ef444455', color: '#ef4444', borderRadius: '0.5rem', padding: '0.5rem 0.75rem', marginBottom: '0.75rem', fontSize: '0.8rem', fontWeight: 600 }}>
          <span style={{ flex: 1 }}>{actionErr}</span>
          <button onClick={() => setActionErr(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontWeight: 800, fontSize: '0.9rem', lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* Main view */}
      {view === 'kanban' ? <KanbanView /> : <TableView />}

      {/* Modals */}
      {DetailModal()}
      {CreateModal()}

      {/* Mark Dead modal */}
      {canEdit && deadFor && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
          onClick={e => { if (e.target === e.currentTarget && !deadBusy) setDeadFor(null); }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => { if (!deadBusy) setDeadFor(null); }} />
          <div style={{ position: 'relative', background: th.bg, borderRadius: '0.75rem', padding: '1.5rem', width: '100%', maxWidth: 440, boxShadow: '0 8px 40px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
            <h3 style={{ fontFamily: "'Raleway'", fontWeight: 800, color: th.text, margin: 0 }}>Mark Deal Dead</h3>
            <div style={{ fontSize: '0.82rem', color: th.muted }}>
              "{deadFor.name}" will be marked dead and removed from the active pipeline.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <label style={{ fontSize: '0.68rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reason</label>
              <select value={deadReason} onChange={e => setDeadReason(e.target.value)}
                style={{ ...selLabel, padding: '0.45rem 0.6rem', fontSize: '0.85rem' }}>
                {DEAD_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <label style={{ fontSize: '0.68rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Note (optional)</label>
              <textarea value={deadNote} onChange={e => setDeadNote(e.target.value)} rows={3}
                placeholder="Additional detail…"
                style={{ ...inp(th), fontSize: '0.82rem', padding: '0.4rem 0.6rem', resize: 'vertical' }} />
            </div>
            {deadErr && <div style={{ fontSize: '0.78rem', color: '#ef4444' }}>Error: {deadErr}</div>}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setDeadFor(null)} disabled={deadBusy}
                style={{ ...btn(th), padding: '0.45rem 1rem', fontSize: '0.82rem' }}>Cancel</button>
              <button onClick={confirmMarkDead} disabled={deadBusy}
                style={{ ...btn(th), padding: '0.45rem 1.1rem', fontSize: '0.82rem', fontWeight: 700, background: '#ef4444', color: '#fff', border: 'none' }}>
                {deadBusy ? 'Marking…' : 'Mark Dead'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Access Management Modal */}
      {showAccess && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
          onClick={e => { if (e.target === e.currentTarget) setShowAccess(false); }}>
          <div style={{ ...card(th), width: '100%', maxWidth: 560, maxHeight: '85vh', overflowY: 'auto', padding: '1.5rem', position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <div>
                <div style={{ fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1.15rem', color: th.text }}>🔒 Manage Deal Pipeline Access</div>
                <div style={{ fontSize: '0.78rem', color: th.muted, marginTop: '0.25rem' }}>Who can see and edit the Deal Pipeline. Admins manage this list.</div>
              </div>
              <button onClick={() => setShowAccess(false)} style={{ ...btn(th), padding: '0.25rem 0.6rem', fontSize: '0.78rem', color: th.muted, background: 'transparent', border: 'none' }}>✕</button>
            </div>

            {accessErr && <div style={{ background: '#fee2e2', color: '#991b1b', borderRadius: '0.4rem', padding: '0.5rem 0.75rem', marginBottom: '0.75rem', fontSize: '0.82rem' }}>{accessErr}</div>}

            {/* Current access list */}
            <div style={{ marginBottom: '1rem' }}>
              {accessRows === null ? (
                <div style={{ color: th.muted, fontSize: '0.85rem' }}>Loading…</div>
              ) : accessRows.length === 0 ? (
                <div style={{ color: th.muted, fontSize: '0.85rem' }}>No access entries yet.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                      <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: th.muted, fontWeight: 600 }}>User</th>
                      <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: th.muted, fontWeight: 600 }}>Role</th>
                      <th style={{ textAlign: 'left', padding: '0.35rem 0.5rem', color: th.muted, fontWeight: 600 }}>Added by</th>
                      <th style={{ padding: '0.35rem 0.5rem' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {accessRows.map(row => (
                      <tr key={row.user_key} style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                        <td style={{ padding: '0.4rem 0.5rem', color: th.text, fontWeight: 600 }}>{row.user_key}</td>
                        <td style={{ padding: '0.4rem 0.5rem' }}>
                          <select value={row.role} disabled={accessBusy}
                            onChange={e => doSetAccess(row.user_key, e.target.value)}
                            style={{ ...inp(th), padding: '0.2rem 0.4rem', fontSize: '0.78rem', width: 'auto' }}>
                            <option value="view">view</option>
                            <option value="edit">edit</option>
                            <option value="admin">admin</option>
                          </select>
                        </td>
                        <td style={{ padding: '0.4rem 0.5rem', color: th.muted, fontSize: '0.75rem' }}>{row.added_by || '—'}</td>
                        <td style={{ padding: '0.4rem 0.5rem' }}>
                          <button disabled={accessBusy} onClick={() => doRemoveAccess(row.user_key)}
                            style={{ ...btn(th), padding: '0.2rem 0.5rem', fontSize: '0.75rem', color: '#ef4444', background: 'transparent', border: `1px solid #ef4444` }}>
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Grant access row */}
            <div style={{ borderTop: `1px solid ${th.cardBorder}`, paddingTop: '1rem' }}>
              <div style={{ fontWeight: 700, fontSize: '0.82rem', color: th.text, marginBottom: '0.5rem' }}>Grant Access</div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <input value={accessInput} onChange={e => setAccessInput(e.target.value)}
                  placeholder="email or username"
                  style={{ ...inp(th), flex: 1, minWidth: 160, padding: '0.35rem 0.6rem', fontSize: '0.82rem' }} />
                <select value={accessRole} onChange={e => setAccessRole(e.target.value)}
                  style={{ ...inp(th), padding: '0.35rem 0.5rem', fontSize: '0.82rem', width: 'auto' }}>
                  <option value="view">view</option>
                  <option value="edit">edit</option>
                  <option value="admin">admin</option>
                </select>
                <button disabled={accessBusy || !accessInput.trim()}
                  onClick={() => { doSetAccess(accessInput.trim(), accessRole); setAccessInput(''); }}
                  style={{ ...btn(th), padding: '0.35rem 0.9rem', fontWeight: 700, background: '#3b82f6', color: '#fff', border: 'none', fontSize: '0.82rem', opacity: (accessBusy || !accessInput.trim()) ? 0.5 : 1 }}>
                  Grant Access
                </button>
              </div>
              <div style={{ fontSize: '0.73rem', color: th.muted, marginTop: '0.4rem' }}>Tip: add by the person's login email or username (case-insensitive).</div>
            </div>

            {/* Deal Leads section */}
            <div style={{ borderTop: `1px solid ${th.cardBorder}`, paddingTop: '1rem', marginTop: '0.5rem' }}>
              <div style={{ fontWeight: 700, fontSize: '0.82rem', color: th.text, marginBottom: '0.5rem' }}>Deal Leads</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.75rem' }}>
                {dealLeads.length === 0 && <div style={{ fontSize: '0.82rem', color: th.muted }}>No leads yet.</div>}
                {dealLeads.map(l => (
                  <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.3rem 0.5rem', background: th.card, borderRadius: '0.35rem', border: `1px solid ${th.cardBorder}` }}>
                    <span style={{ fontSize: '0.82rem', color: th.text }}>{l.name}</span>
                    <button disabled={accessBusy}
                      onClick={() => {
                        setAccessBusy(true);
                        dealApi(token, { action: 'removeLead', id: l.id })
                          .then(r => setDealLeads(r.leads || []))
                          .catch(e => setAccessErr(e.message))
                          .finally(() => setAccessBusy(false));
                      }}
                      style={{ ...btn(th), padding: '0.15rem 0.5rem', fontSize: '0.75rem', color: '#ef4444', background: 'transparent', border: `1px solid #ef4444` }}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <input value={newLeadName} onChange={e => setNewLeadName(e.target.value)}
                  placeholder="New lead name"
                  style={{ ...inp(th), flex: 1, padding: '0.35rem 0.6rem', fontSize: '0.82rem' }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newLeadName.trim()) {
                      setAccessBusy(true);
                      dealApi(token, { action: 'addLead', name: newLeadName.trim() })
                        .then(r => { setDealLeads(r.leads || []); setNewLeadName(''); })
                        .catch(e => setAccessErr(e.message))
                        .finally(() => setAccessBusy(false));
                    }
                  }} />
                <button disabled={accessBusy || !newLeadName.trim()}
                  onClick={() => {
                    if (!newLeadName.trim()) return;
                    setAccessBusy(true);
                    dealApi(token, { action: 'addLead', name: newLeadName.trim() })
                      .then(r => { setDealLeads(r.leads || []); setNewLeadName(''); })
                      .catch(e => setAccessErr(e.message))
                      .finally(() => setAccessBusy(false));
                  }}
                  style={{ ...btn(th), padding: '0.35rem 0.9rem', fontWeight: 700, background: '#3b82f6', color: '#fff', border: 'none', fontSize: '0.82rem', opacity: (accessBusy || !newLeadName.trim()) ? 0.5 : 1 }}>
                  Add Lead
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
