// src/screens/DistrictAlignmentTool.jsx — moved out of app.jsx unchanged (v23.36, scripts/extract-screen.mjs).
import { O, card, inp } from '../theme.js';
import { applyPlanToDistricts, applyPlanToStores, planDistrictApply } from '../district-apply.mjs';
import { authHeader } from '../portal-auth.mjs';
import { haversineMiles } from '../impact.mjs';
import { withAlpha } from '../chart-style.js';
import { DISTRICT_COLORS, PortalConfirmModal, STORE_COORDS, districtTint, isFullAdmin, logClientEvent, storeMgrName } from '../../app.jsx';

export function DistrictAlignmentTool({ user, th, stores, users, onBack, setStores, districts, setDistricts, setUsers }) {
  const [draft, setDraft] = React.useState(null);
  const [metrics, setMetrics] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [hoverHoursPc, setHoverHoursPc] = React.useState(null); // { pc, rect } of the open busiest-hours card (v21.92/93)
  React.useEffect(() => {
    if (!hoverHoursPc) return;
    const close = () => setHoverHoursPc(null);
    window.addEventListener('scroll', close, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', close, { capture: true });
  }, [hoverHoursPc]);
  // Drag-to-move (v21.93): which store is being dragged, which district it's hovering.
  const [dragPc, setDragPc] = React.useState(null);
  const [dragOverDistrict, setDragOverDistrict] = React.useState(null);
  const dragFromControlRef = React.useRef(false);
  // While dragging, holding near the top/bottom edge of the window scrolls the page
  // (native drag auto-scroll is unreliable across browsers).
  React.useEffect(() => {
    if (!dragPc) return;
    let y = null; let raf = 0;
    const onOver = (e) => { y = e.clientY; };
    const tick = () => {
      if (y != null) { const edge = 90; if (y < edge) window.scrollBy(0, -Math.ceil((edge - y) / 4)); else if (y > window.innerHeight - edge) window.scrollBy(0, Math.ceil((y - (window.innerHeight - edge)) / 4)); }
      raf = requestAnimationFrame(tick);
    };
    document.addEventListener('dragover', onOver);
    raf = requestAnimationFrame(tick);
    return () => { document.removeEventListener('dragover', onOver); cancelAnimationFrame(raf); };
  }, [dragPc]);
  const isAdmin = isFullAdmin(user);

  const activeStores = React.useMemo(
    () => (stores || []).filter(s => s.status !== 'Permanently Closed'),
    [stores]
  );

  const loadDraft = React.useCallback(() => {
    setLoading(true);
    setError('');
    fetch('/.netlify/functions/district-alignment', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'get', liveStores: activeStores }),
    })
      .then(r => r.json())
      .then(j => {
        if (!j?.ok) { setError(j?.error || 'Could not load District Alignment.'); return; }
        setDraft(j.draft);
      })
      .catch(() => setError('Network error — please try again.'))
      .finally(() => setLoading(false));
  }, [activeStores]);

  const [saving, setSaving] = React.useState(false);
  const [showAddDm, setShowAddDm] = React.useState(null); // district number the "add DM" form is open for, or null
  const [showNewDistrict, setShowNewDistrict] = React.useState(false); // creating a brand-new district number
  const [newDistrictNum, setNewDistrictNum] = React.useState('');
  const [newDmName, setNewDmName] = React.useState('');
  const [newDmEmail, setNewDmEmail] = React.useState('');

  const callAction = (body) => {
    setSaving(true);
    return fetch('/.netlify/functions/district-alignment', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(j => {
        if (!j?.ok) { setActionError(j?.error || 'That action failed — please try again.'); return; }
        setDraft(j.draft);
        setActionError('');
      })
      .catch(() => setActionError('Network error — please try again.'))
      .finally(() => setSaving(false));
  };

  const reassignStore = (pc, district) => callAction({ action: 'reassignStore', pc, district });
  const addDm = (district) => {
    if (!newDmName.trim() || !Number.isFinite(district) || district <= 0) return;
    callAction({ action: 'addDm', name: newDmName.trim(), email: newDmEmail.trim(), district }).then(() => {
      setShowAddDm(null); setShowNewDistrict(false); setNewDistrictNum(''); setNewDmName(''); setNewDmEmail('');
    });
  };
  // Swap a district's DM in one step (v22.14) instead of Remove + Add.
  const replaceDm = (district) => {
    if (!newDmName.trim() || !Number.isFinite(district) || district <= 0) return;
    callAction({ action: 'replaceDm', name: newDmName.trim(), email: newDmEmail.trim(), district }).then(() => {
      setShowAddDm(null); setNewDmName(''); setNewDmEmail('');
    });
  };
  const dmAccounts = (users || []).filter(u => u.userType === 'dm' && u.active !== false).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const [confirmAction, setConfirmAction] = React.useState(null); // { title, message, confirmLabel, run } or null
  // Apply to live (v22.12): plan shown for confirmation, then written to Locations + Users.
  const [applyPlan, setApplyPlan] = React.useState(null);
  const [applying, setApplying] = React.useState(false);
  const [applyResult, setApplyResult] = React.useState(null); // { ok, text }
  const removeDm = (dmId) => setConfirmAction({
    title: 'Remove this DM?',
    message: 'Their stores will show as Unassigned until reassigned.',
    confirmLabel: 'Remove',
    run: () => callAction({ action: 'removeDm', dmId }),
  });
  const resetToLive = () => setConfirmAction({
    title: 'Reset to live data?',
    message: 'This overwrites the draft with a fresh copy of the real Locations data. Any unsaved sandbox changes will be lost.',
    confirmLabel: 'Reset',
    run: () => callAction({ action: 'reset', liveStores: activeStores }),
  });

  // Everything the draft would change, shown in full before anything is written.
  const openApply = () => {
    setApplyResult(null);
    const plan = planDistrictApply({ draft, liveStores: activeStores, users });
    const nameChanges = Object.entries(plan.districtDms).filter(([n, dm]) => (districts?.[n]?.name || '') !== dm.name);
    if (!plan.hasChanges && nameChanges.length === 0) { setActionError('Nothing to apply — the draft already matches live Locations.'); return; }
    setApplyPlan({ ...plan, nameChanges });
  };
  // DM account links first (they can be refused, e.g. a lost session); Locations is
  // only written once they've all gone through, so a failure never leaves stores moved
  // with the DMs still pointing at their old districts.
  const runApply = async () => {
    const plan = applyPlan;
    setApplying(true);
    const userChanges = [...plan.dmLinks.map(l => ({ id: l.userId, name: l.name, district: l.to })), ...plan.dmUnlinks.map(u => ({ id: u.userId, name: u.name, district: null }))];
    const done = [];
    for (const ch of userChanges) {
      try {
        const res = await fetch('/.netlify/functions/users', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({ action: 'update', id: ch.id, patch: { district: ch.district } }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        done.push(ch);
        if (setUsers && j.user) setUsers(us => us.map(u => u.id === ch.id ? { ...u, ...j.user } : u));
      } catch (e) {
        setApplying(false); setApplyPlan(null);
        setApplyResult({ ok: false, text: `Stopped — couldn't update ${ch.name}'s account (${e.message}). ${done.length ? `Already updated: ${done.map(d => d.name).join(', ')}. ` : ''}No stores were moved. Fix the issue and press Apply to live again.` });
        return;
      }
    }
    if (setStores) setStores(ss => applyPlanToStores(ss, plan));
    if (setDistricts) setDistricts(d => applyPlanToDistricts(d, plan));
    logClientEvent(user?.id, user?.userType, 'district_alignment_applied', {
      moves: plan.storeMoves.map(m => `${m.pc}:${m.from}->${m.to}`), links: plan.dmLinks.map(l => `${l.name}->${l.to}`), unlinks: plan.dmUnlinks.map(u => u.name),
    });
    setApplying(false); setApplyPlan(null);
    setApplyResult({ ok: true, text: `Applied: ${plan.storeMoves.length} store${plan.storeMoves.length === 1 ? '' : 's'} moved, ${plan.dmLinks.length} DM${plan.dmLinks.length === 1 ? '' : 's'} linked, ${plan.dmUnlinks.length} unlinked. Alerts and reports follow the new districts from their next run.` });
  };

  React.useEffect(() => { loadDraft(); }, [loadDraft]);

  React.useEffect(() => {
    if (activeStores.length === 0) return;
    fetch('/.netlify/functions/district-alignment', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'metrics', pcs: activeStores.map(s => s.pc) }),
    })
      .then(r => r.json())
      .then(j => { if (j?.ok) setMetrics(j.metrics); })
      .catch(() => {});
  }, [activeStores]);

  if (loading) return <div style={{ padding: '2rem', color: th.muted }}>Loading District Alignment…</div>;
  if (error) return <div style={{ padding: '2rem', color: '#ef4444' }}>{error}</div>;
  if (!draft) return null;

  const storeByPc = Object.fromEntries(activeStores.map(s => [s.pc, s]));
  const byDistrict = {};
  Object.entries(draft.stores).forEach(([pc, { district }]) => {
    const d = district ?? 0;
    (byDistrict[d] ||= []).push(pc);
  });
  const districtNums = Object.keys(byDistrict).map(Number).sort((a, b) => a - b);
  // Includes districts that exist only as a DM entry with zero stores yet
  // (freshly created via "+ New District"), so they're selectable in the
  // reassign dropdown even before any store has been moved into them.
  const selectableDistrictNums = Array.from(new Set([...districtNums, ...draft.dms.map(d => d.district)])).sort((a, b) => a - b);

  const nearestSiblingMiles = (pc, districtPcs) => {
    const coord = STORE_COORDS[pc];
    if (!coord) return null;
    let min = null;
    districtPcs.forEach(otherPc => {
      if (otherPc === pc) return;
      const d = haversineMiles(coord, STORE_COORDS[otherPc]);
      if (Number.isFinite(d) && (min == null || d < min)) min = d;
    });
    return min;
  };

  const districtSpread = (districtPcs) => {
    const coords = districtPcs.map(pc => STORE_COORDS[pc]).filter(Boolean);
    if (coords.length < 2) return { avg: null, max: null };
    let total = 0, count = 0, max = 0;
    for (let i = 0; i < coords.length; i++) {
      for (let j = i + 1; j < coords.length; j++) {
        const d = haversineMiles(coords[i], coords[j]);
        total += d; count++; if (d > max) max = d;
      }
    }
    return { avg: Math.round((total / count) * 10) / 10, max: Math.round(max * 10) / 10 };
  };

  const fmtMoney = n => n == null ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtHour = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toLocaleTimeString(undefined, { hour: 'numeric' }); };
  // v21.92: weekly sales label + busiest-hour ranges ("8–9 AM").
  const fmtWeekRange = (m) => { if (!m.weekStart || !m.weekEnd) return ''; const f = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); return `${f(m.weekStart)} – ${f(m.weekEnd)}${m.weekComplete ? '' : ' (partial)'}`; };
  const fmtHourRange = h => `${fmtHour(h)}–${fmtHour((h + 1) % 24)}`;
  const assetCombined = s => `${s.isNextGen ? 'NXT-' : ''}${s.baseAsset || '—'}`;

  // Builds a self-contained, forced-light-mode HTML string (not the live
  // themed DOM) so the PDF is always readable regardless of dark/light mode —
  // same approach the Store Directory PDF export already uses in this file.
  const exportDistrictAlignmentPdf = () => {
    const cell = "padding:2px 6px;font-size:8.5px;color:#1a1a1a;border-bottom:0.5px solid #ddd;";
    const rowsHtml = (pcs, bg) => pcs.map(pc => {
      const s = storeByPc[pc];
      if (!s) return '';
      const m = metrics[pc] || {};
      const nearest = nearestSiblingMiles(pc, pcs);
      const maxAvg = Math.max(1, ...((m.hourlyAvg || []).map(h => h.avgSales)));
      const topSet = new Set((m.topHours || []).map(t => t.h));
      const barsHtml = (m.hourlyAvg || []).map(h => `<div style="display:inline-block;width:3px;height:${Math.max(1, Math.round((h.avgSales / maxAvg) * 16))}px;background:${topSet.has(h.h) ? '#b8430f' : O + '99'};margin-right:1px;vertical-align:bottom;"></div>`).join('')
        + ((m.topHours || []).length ? `<div style="font-size:6.5px;color:#555;white-space:normal;">${m.topHours.map(t => `${fmtHourRange(t.h)} ${fmtMoney(t.avgSales)}`).join(' · ')}</div>` : '');
      return `
        <tr style="background:${bg};">
          <td style="${cell}font-weight:700;color:#c2540c;">${s.pc}</td>
          <td style="${cell}">${s.paycor || "—"}</td>
          <td style="${cell}">${s.legal || "—"}</td>
          <td style="${cell}font-weight:700;">${s.name || "—"}</td>
          <td style="${cell}">${[s.address, s.city, s.state].filter(Boolean).join(", ")}</td>
          <td style="${cell}">${assetCombined(s)}</td>
          <td style="${cell}">${storeMgrName(s, users) || "Unassigned"}</td>
          <td style="${cell}">${s.email || "—"}</td>
          <td style="${cell}">${fmtMoney(m.weeklySales)}${m.weekStart ? `<div style="font-size:6.5px;color:#888;">${fmtWeekRange(m)}</div>` : ''}</td>
          <td style="${cell}white-space:nowrap;height:16px;">${barsHtml}</td>
          <td style="${cell}">${nearest != null ? `${Math.round(nearest * 10) / 10} mi` : '—'}</td>
        </tr>`;
    }).join('');
    const districtsHtml = selectableDistrictNums.map(dNum => {
      const pcs = byDistrict[dNum] || [];
      const dm = draft.dms.find(d => d.district === dNum);
      const dc = DISTRICT_COLORS[dNum] || { bg: '#e5e7eb', text: '#111' };
      const spread = districtSpread(pcs);
      return `
        <tr style="background:${dc.bg};">
          <td colspan="8" style="padding:3px 6px;font-size:9.5px;font-weight:800;color:${dc.text};">${dNum ? `District #${dNum}${dm ? " " + dm.name : " — Unassigned"}` : "Unassigned"}</td>
          <td colspan="3" style="padding:3px 6px;font-size:8.5px;font-weight:700;color:${dc.text};text-align:right;">${spread.avg != null ? `spread: ${spread.avg} mi avg, ${spread.max} mi max` : ''}</td>
        </tr>
        ${pcs.length === 0 ? `<tr><td colspan="11" style="${cell}font-style:italic;color:#888;">No stores assigned yet</td></tr>` : rowsHtml(pcs, districtTint(dc.bg))}`;
    }).join('');
    const el = document.createElement('div');
    el.innerHTML = `
      <div style="font-family:'Source Sans 3',sans-serif;background:#fff;padding:2px;">
        <div style="font-family:'Raleway',sans-serif;font-weight:800;font-size:14px;color:#1a1a1a;margin-bottom:1px;">People Capital Group — District Alignment (Draft)</div>
        <div style="font-size:8px;color:#888;margin-bottom:5px;">Generated ${new Date().toLocaleDateString()} — sandbox draft only; never reflects or affects the real Locations data.</div>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:#e5e7eb;">
              ${['PC#', 'Paycor Client ID', 'Legal Name', 'Property Name', 'Address', 'Asset Type', 'Manager', 'Store Email', 'Weekly Sales', 'Busiest Hours', 'Nearest Sibling'].map(h => `<th style="text-align:left;padding:2px 6px;font-size:7.5px;font-weight:800;color:#555;text-transform:uppercase;">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>${districtsHtml}</tbody>
        </table>
      </div>`;
    const dateStr = new Date().toISOString().slice(0, 10);
    html2pdf().set({ margin: 0.15, filename: `PCG-District-Alignment-Draft-${dateStr}.pdf`, image: { type: "jpeg", quality: 0.98 }, html2canvas: { scale: 2 }, jsPDF: { unit: "in", format: "letter", orientation: "landscape" }, pagebreak: { mode: ["css", "legacy"] } }).from(el).save();
  };

  // ── Layout (redesigned v21.93) ────────────────────────────────────────────
  const COLS = ['PC#', 'Paycor Client ID', 'Legal Name', 'Property Name', 'Address', 'Asset Type', 'Manager', 'Store Email', 'Weekly Sales', 'Busiest Hours', 'Nearest Sibling'];
  const thStyle = { position: 'sticky', top: 0, zIndex: 2, textAlign: 'left', padding: '0.8rem 0.5rem', fontSize: '0.64rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'normal', verticalAlign: 'bottom', color: th.muted, background: th.card, borderBottom: `1px solid ${th.cardBorder}` };
  const tdStyle = { padding: '0.8rem 0.5rem', fontSize: '0.78rem', color: th.text, borderBottom: `1px solid ${th.cardBorder}`, verticalAlign: 'middle', transition: 'background 0.15s ease' };
  const mutedTd = { ...tdStyle, color: th.muted };
  const textLink = { background: 'none', border: 'none', padding: 0, marginLeft: '1rem', fontSize: '0.72rem', fontWeight: 600, color: O, cursor: 'pointer', fontFamily: "'Source Sans 3'" };
  const outlineBtn = (accent) => ({ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.62rem 1.1rem', borderRadius: '0.6rem', border: `1px solid ${accent ? O + '88' : th.cardBorder}`, background: th.card, color: accent ? O : th.text, fontSize: '0.8rem', fontWeight: 600, fontFamily: "'Source Sans 3'", cursor: 'pointer' });
  const solidBtn = { ...outlineBtn(false), background: O, border: `1px solid ${O}`, color: '#fff' };
  const Ico = ({ d, c = th.muted, s = 16 }) => <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;

  // Summary strip figures
  const realDistricts = selectableDistrictNums.filter(n => n > 0);
  const storesShown = Object.keys(draft.stores).filter(pc => storeByPc[pc]).length;
  const siblingDistances = Object.entries(byDistrict).flatMap(([, pcs]) => pcs.map(pc => nearestSiblingMiles(pc, pcs)).filter(v => v != null));
  const avgSibling = siblingDistances.length ? Math.round((siblingDistances.reduce((a, b) => a + b, 0) / siblingDistances.length) * 10) / 10 : null;
  const StatTile = ({ icon, value, label }) => (
    <div style={{ flex: '1 1 170px', display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.85rem 1rem', borderRadius: '0.7rem', border: `1px solid ${th.cardBorder}`, background: th.card, minWidth: 0 }}>
      <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '1.05rem', fontWeight: 800, color: th.text, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
        <div style={{ fontSize: '0.72rem', color: th.muted }}>{label}</div>
      </div>
    </div>
  );

  // Drag-to-move: press and hold any store row, drag it onto another district's
  // header or rows, release. Uses the same reassignStore action as the dropdown.
  const dropOn = (dNum) => {
    const pc = dragPc;
    setDragPc(null); setDragOverDistrict(null);
    if (!pc || draft.stores[pc]?.district === dNum) return;
    reassignStore(pc, dNum);
  };
  const dropHandlers = (dNum) => isAdmin ? {
    onDragOver: (e) => { if (!dragPc) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverDistrict !== dNum) setDragOverDistrict(dNum); },
    onDrop: (e) => { e.preventDefault(); dropOn(dNum); },
  } : {};

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.1rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
          {onBack && (
            <button onClick={onBack} aria-label="Back to Tools" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.35rem 0.2rem 0 0', display: 'flex' }}>
              <Ico d={<path d="m15 18-6-6 6-6" />} c={th.text} s={22} />
            </button>
          )}
          <div>
            <h2 style={{ margin: 0, fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1.75rem', color: th.text }}>District Alignment</h2>
            <div style={{ fontSize: '0.88rem', color: th.muted, marginTop: '0.2rem' }}>Plan district groupings without changing live Locations data.</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="da-btn" onClick={exportDistrictAlignmentPdf} style={outlineBtn(false)}>
            <Ico d={<><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></>} c={th.text} />Download PDF
          </button>
          {isAdmin && (
            showNewDistrict ? (
              <span style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center', background: th.card, padding: '0.35rem 0.5rem', borderRadius: '0.6rem', border: `1px solid ${th.cardBorder}`, animation: 'daPopIn 0.18s ease-out both' }}>
                <input type="number" placeholder="District #" value={newDistrictNum} onChange={e => setNewDistrictNum(e.target.value)} style={{ ...inp(th, { width: 80, fontSize: '0.75rem', padding: '0.35rem 0.5rem' }) }} />
                <input placeholder="DM name" value={newDmName} onChange={e => setNewDmName(e.target.value)} style={{ ...inp(th, { width: 140, fontSize: '0.75rem', padding: '0.35rem 0.5rem' }) }} />
                <input placeholder="DM email" value={newDmEmail} onChange={e => setNewDmEmail(e.target.value)} style={{ ...inp(th, { width: 170, fontSize: '0.75rem', padding: '0.35rem 0.5rem' }) }} />
                <button className="da-btn" onClick={() => addDm(Number(newDistrictNum))} disabled={saving || !newDistrictNum || !newDmName.trim()} style={{ ...solidBtn, padding: '0.4rem 0.8rem' }}>Save</button>
                <button className="da-btn" onClick={() => { setShowNewDistrict(false); setNewDistrictNum(''); setNewDmName(''); setNewDmEmail(''); }} style={{ ...outlineBtn(false), padding: '0.4rem 0.8rem' }}>Cancel</button>
              </span>
            ) : (
              <button className="da-btn" disabled={saving}
                onClick={() => { setNewDistrictNum(String(Math.max(0, ...districtNums.filter(n => n > 0)) + 1)); setShowNewDistrict(true); }}
                style={{ ...solidBtn, opacity: saving ? 0.6 : 1 }}>
                <Ico d={<path d="M12 5v14M5 12h14"/>} c="#fff" />New District
              </button>
            )
          )}
          {isAdmin && setStores && (
            <button className="da-btn" onClick={openApply} disabled={saving || applying} style={{ ...solidBtn, opacity: saving || applying ? 0.6 : 1 }}>
              <Ico d={<path d="m5 12.5 4.5 4.5L19 7.5"/>} c="#fff" />Apply to live
            </button>
          )}
          {isAdmin && (
            <button className="da-btn" onClick={resetToLive} disabled={saving} style={{ ...outlineBtn(true), opacity: saving ? 0.6 : 1 }}>
              <Ico d={<><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></>} c={O} />Reset to live data
            </button>
          )}
        </div>
      </div>

      {/* Summary strip */}
      <div style={{ ...card(th), borderRadius: '0.9rem', padding: '0.75rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div style={{ flex: '1.4 1 220px', display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.85rem 1rem' }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: O, flexShrink: 0, boxShadow: `0 0 0 4px ${O}22` }} />
          <div>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: th.text }}>Draft</div>
            <div style={{ fontSize: '0.72rem', color: th.muted }}>Changes are not live yet</div>
          </div>
        </div>
        <StatTile icon={<Ico d={<><path d="M12 22s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></>} s={20} />} value={realDistricts.length} label="Districts" />
        <StatTile icon={<Ico d={<><path d="M3 9 4.5 4h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/></>} s={20} />} value={storesShown} label="Stores shown" />
        <StatTile icon={<Ico d={<><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></>} s={20} />} value={avgSibling != null ? `${avgSibling} mi` : '—'} label="Avg. sibling distance" />
        <StatTile icon={<Ico d={<><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5M9 13h6M9 17h6"/></>} s={20} />}
          value={draft.seededFromLiveAt ? new Date(draft.seededFromLiveAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'} label="Draft started from live data" />
      </div>

      {actionError && (
        <div style={{ padding: '0.5rem 0.75rem', marginBottom: '0.6rem', borderRadius: 8, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444', fontSize: '0.78rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', animation: 'daPopIn 0.2s ease-out both' }}>
          <span>{actionError}</span>
          <button onClick={() => setActionError('')} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }} aria-label="Dismiss">×</button>
        </div>
      )}
      {applyResult && (
        <div style={{ padding: '0.6rem 0.85rem', marginBottom: '0.6rem', borderRadius: 8, background: applyResult.ok ? 'rgba(22,163,74,0.10)' : 'rgba(239,68,68,0.12)', border: `1px solid ${applyResult.ok ? 'rgba(22,163,74,0.35)' : 'rgba(239,68,68,0.35)'}`, color: applyResult.ok ? '#16a34a' : '#ef4444', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', animation: 'daPopIn 0.2s ease-out both' }}>
          <span>{applyResult.text}</span>
          <button onClick={() => setApplyResult(null)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }} aria-label="Dismiss">×</button>
        </div>
      )}
      {isAdmin && (
        <div style={{ fontSize: '0.74rem', color: th.muted, margin: '0 0 0.5rem 0.25rem' }}>
          Tip: press and hold a store row, then drag it onto another district to move it. Hold near the top or bottom of the window to scroll.
        </div>
      )}

      {/* Table */}
      <div style={{ ...card(th), borderRadius: '0.9rem', padding: '0 0.5rem 0.5rem', overflowX: 'auto' }}>
        {/* Fluid (v22.11): was minWidth 1400, which pushed the right edge (Avg. distance,
            Nearest Sibling) off-screen at 100% zoom. Now it fits the window and only scrolls on phones. */}
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>{COLS.map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {selectableDistrictNums.map((dNum, dIdx) => {
              const pcs = byDistrict[dNum] || [];
              const dm = draft.dms.find(d => d.district === dNum);
              const dc = DISTRICT_COLORS[dNum] || { bg: th.muted, text: th.text };
              const spread = districtSpread(pcs);
              const isTarget = !!dragPc && dragOverDistrict === dNum && draft.stores[dragPc]?.district !== dNum;
              const rowEnterStyle = (extra) => ({ ...extra, animation: `daRowIn 0.35s ease-out both`, animationDelay: `${Math.min(dIdx, 10) * 40}ms` });
              return (
                <React.Fragment key={dNum}>
                  <tr style={rowEnterStyle({})} {...dropHandlers(dNum)}>
                    <td colSpan={COLS.length} style={{ padding: '0.6rem 0.15rem 0.35rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem 1rem', padding: '0.6rem 0.9rem', borderRadius: '0.6rem', background: districtTint(dc.bg, isTarget ? 0.32 : 0.14), outline: isTarget ? `2px dashed ${dc.bg}` : 'none', transition: 'background 0.15s ease' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', minWidth: 0, flexWrap: 'wrap' }}>
                          <span style={{ width: 10, height: 10, borderRadius: '50%', background: dc.bg, flexShrink: 0 }} />
                          <span style={{ fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1.05rem', color: th.text }}>{dNum ? `District ${dNum}` : 'Unassigned'}</span>
                          <span style={{ fontSize: '0.8rem', color: th.muted }}>{dm ? dm.name : (dNum ? 'No district manager' : '')}</span>
                          {/* v22.34: the Director(s) of Operations overseeing this district — live
                              from their accounts (set in Admin → Users), not part of the draft. */}
                          {dNum > 0 && (users || []).filter(u => u.userType === 'director' && u.active !== false && (u.districts || []).map(Number).includes(dNum)).map(u => (
                            <span key={u.id} title="Director of Operations — change in Admin → Users" style={{ fontSize: '0.75rem', fontWeight: 700, color: '#ca8a04', background: withAlpha('#ca8a04', 0.12), padding: '0.12rem 0.5rem', borderRadius: 999, whiteSpace: 'nowrap' }}>Director: {u.name}</span>
                          ))}
                          {isTarget && <span style={{ fontSize: '0.75rem', fontWeight: 700, color: th.text }}>· Drop to move {storeByPc[dragPc]?.name || dragPc} here</span>}
                          {/* Add or change (v22.14) the district's DM. Picking a DM account fills
                              name + email exactly as in Admin → Users, which is what Apply to live
                              matches on to link the right account. */}
                          {isAdmin && dNum > 0 && !isTarget && showAddDm === dNum && (
                            <span style={{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center', flexWrap: 'wrap', animation: 'daPopIn 0.18s ease-out both' }}>
                              <select value="" onChange={e => { const u = dmAccounts.find(x => String(x.id) === e.target.value); if (u) { setNewDmName(u.name || ''); setNewDmEmail(u.email || ''); } }}
                                style={{ ...inp(th, { fontSize: '0.72rem', padding: '0.25rem 0.5rem', width: 170 }), cursor: 'pointer' }}>
                                <option value="">Pick a DM account…</option>
                                {dmAccounts.map(u => <option key={u.id} value={u.id}>{u.name}{u.district ? ` (now District ${u.district})` : ' (no district)'}</option>)}
                              </select>
                              <input placeholder="Name" value={newDmName} onChange={e => setNewDmName(e.target.value)} style={{ ...inp(th, { fontSize: '0.72rem', padding: '0.25rem 0.5rem', width: 130 }) }} />
                              <input placeholder="Email" value={newDmEmail} onChange={e => setNewDmEmail(e.target.value)} style={{ ...inp(th, { fontSize: '0.72rem', padding: '0.25rem 0.5rem', width: 160 }) }} />
                              <button className="da-btn" onClick={() => (dm ? replaceDm(dNum) : addDm(dNum))} disabled={saving || !newDmName.trim()} style={{ ...solidBtn, padding: '0.25rem 0.7rem', fontSize: '0.72rem' }}>Save</button>
                              <button className="da-btn" onClick={() => { setShowAddDm(null); setNewDmName(''); setNewDmEmail(''); }} style={{ ...outlineBtn(false), padding: '0.25rem 0.7rem', fontSize: '0.72rem' }}>Cancel</button>
                            </span>
                          )}
                          {isAdmin && dm && !isTarget && showAddDm !== dNum && (<>
                            <button className="da-btn" onClick={() => { setNewDmName(''); setNewDmEmail(''); setShowAddDm(dNum); }} disabled={saving} style={textLink}>Change district manager</button>
                            <button className="da-btn" onClick={() => removeDm(dm.id)} disabled={saving} style={textLink}>Remove district manager</button>
                          </>)}
                          {isAdmin && !dm && dNum > 0 && !isTarget && showAddDm !== dNum && (
                            <button className="da-btn" onClick={() => { setNewDmName(''); setNewDmEmail(''); setShowAddDm(dNum); }} style={textLink}>+ Add district manager</button>
                          )}
                        </div>
                        {spread.avg != null && (
                          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: th.text, background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 999, padding: '0.25rem 0.75rem', whiteSpace: 'nowrap' }}>
                            Avg. distance <strong>{spread.avg} mi</strong> · Max <strong>{spread.max} mi</strong>
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {pcs.length === 0 && (
                    <tr style={rowEnterStyle({})} {...dropHandlers(dNum)}>
                      <td colSpan={COLS.length} style={{ padding: '0.5rem 0.75rem 0.85rem' }}>
                        <div style={{ border: `1.5px dashed ${isTarget ? dc.bg : th.cardBorder}`, borderRadius: 8, padding: '0.7rem 0.75rem', fontSize: '0.74rem', color: th.muted, textAlign: 'center' }}>
                          No stores yet. Drag a store here, or use a store's district dropdown.
                        </div>
                      </td>
                    </tr>
                  )}
                  {pcs.map((pc) => {
                    const s = storeByPc[pc];
                    if (!s) return null;
                    const m = metrics[pc] || {};
                    const nearest = nearestSiblingMiles(pc, pcs);
                    const maxAvg = Math.max(1, ...((m.hourlyAvg || []).map(h => h.avgSales)));
                    const dragging = dragPc === pc;
                    const baseBg = isTarget ? districtTint(dc.bg, 0.1) : 'transparent';
                    return (
                      <tr key={pc}
                        draggable={isAdmin && !saving}
                        onMouseDownCapture={e => { dragFromControlRef.current = !!e.target.closest('select, input, button, textarea'); }}
                        onDragStart={e => {
                          if (dragFromControlRef.current) { e.preventDefault(); return; }
                          e.dataTransfer.effectAllowed = 'move';
                          try { e.dataTransfer.setData('text/plain', pc); } catch {}
                          setDragPc(pc);
                        }}
                        onDragEnd={() => { setDragPc(null); setDragOverDistrict(null); }}
                        {...dropHandlers(dNum)}
                        style={rowEnterStyle({ background: baseBg, opacity: dragging ? 0.45 : 1, cursor: isAdmin ? 'grab' : 'default' })}
                        onMouseEnter={e => { if (!dragPc) e.currentTarget.style.background = th.card2; }}
                        onMouseLeave={e => { e.currentTarget.style.background = baseBg; }}>
                        <td style={{ ...tdStyle, color: O, fontWeight: 700 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                            {isAdmin && <Ico d={<><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></>} c={th.muted} s={14} />}
                            {pc}
                          </span>
                        </td>
                        <td style={tdStyle}>{s.paycor || '—'}</td>
                        <td style={mutedTd}>{s.legal || '—'}</td>
                        <td style={{ ...tdStyle, fontWeight: 700 }}>
                          {s.name || '—'}
                          {isAdmin && (
                            <select value={dNum} disabled={saving} onChange={e => reassignStore(pc, Number(e.target.value))}
                              style={{ ...inp(th, { fontSize: '0.72rem', padding: '0.35rem 0.6rem', borderRadius: 8 }), display: 'block', marginTop: '0.35rem', minWidth: 120, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1, background: th.card }}>
                              {selectableDistrictNums.map(n => <option key={n} value={n}>{n ? `District ${n}` : 'Unassigned'}</option>)}
                            </select>
                          )}
                        </td>
                        <td style={{ ...mutedTd, maxWidth: 220 }}>{[s.address, s.city, s.state].filter(Boolean).join(', ')}</td>
                        <td style={mutedTd}>{assetCombined(s)}</td>
                        <td style={tdStyle}>{storeMgrName(s, users) || 'Unassigned'}</td>
                        <td style={{ ...mutedTd, overflowWrap: 'anywhere' }}>{s.email || '—'}</td>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 700 }}>{fmtMoney(m.weeklySales)}</div>
                          {m.weekStart && <div style={{ fontSize: '0.66rem', color: th.muted, whiteSpace: 'nowrap' }}>{fmtWeekRange(m)}</div>}
                        </td>
                        <td style={tdStyle}
                          onMouseEnter={e => setHoverHoursPc({ pc, rect: e.currentTarget.getBoundingClientRect() })} onMouseLeave={() => setHoverHoursPc(null)}>
                          {hoverHoursPc?.pc === pc && !dragPc && (m.topHours || []).length > 0 && ReactDOM.createPortal(
                            // Rendered into <body> (v21.93): each row's entry animation leaves a transform on
                            // the <tr>, which traps any z-index inside it — the card was painting UNDER the
                            // next rows. A fixed-position portal sits above everything.
                            <div role="tooltip" style={{ position: 'fixed', top: hoverHoursPc.rect.top + hoverHoursPc.rect.height / 2, left: hoverHoursPc.rect.left - 8, transform: 'translate(-100%, -50%)', zIndex: 1000, minWidth: 190, background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: '0.6rem', boxShadow: '0 10px 28px rgba(0,0,0,0.18)', padding: '0.6rem 0.75rem', pointerEvents: 'none' }}>
                              <div style={{ fontSize: '0.66rem', fontWeight: 700, color: th.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: '0.35rem' }}>Busiest hours · avg last {m.hourlyDays || 7} days</div>
                              {m.topHours.map((t, i) => (
                                <div key={t.h} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', fontSize: '0.8rem', padding: '0.12rem 0', color: th.text }}>
                                  <span><span style={{ color: O, fontWeight: 800, marginRight: '0.35rem' }}>{i + 1}</span>{fmtHourRange(t.h)}</span>
                                  <span style={{ fontWeight: 700 }}>{fmtMoney(t.avgSales)}</span>
                                </div>
                              ))}
                            </div>,
                            document.body
                          )}
                          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 26, cursor: (m.topHours || []).length ? 'help' : 'default' }}>
                            {(m.hourlyAvg || []).map((h, hIdx) => (
                              <div key={h.h}
                                style={{
                                  width: 3, height: Math.max(2, (h.avgSales / maxAvg) * 26), background: (m.topHours || []).some(t => t.h === h.h) ? '#c2410c' : O + '99', borderRadius: 1.5,
                                  transformOrigin: 'bottom', animation: 'daBarGrow 0.4s ease-out both', animationDelay: `${hIdx * 12}ms`,
                                }} />
                            ))}
                          </div>
                        </td>
                        <td style={tdStyle}>{nearest != null ? `${Math.round(nearest * 10) / 10} mi` : '—'}</td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <style>{`
        .da-btn { transition: transform 0.12s ease, box-shadow 0.15s ease; }
        .da-btn:hover:not(:disabled) { box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
        .da-btn:active:not(:disabled) { transform: scale(0.95); }
        @keyframes daRowIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes daPopIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
        @keyframes daBarGrow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        @media (prefers-reduced-motion: reduce) {
          .da-btn, .da-btn:active:not(:disabled) { transition: none !important; transform: none !important; }
        }
      `}</style>
      {applyPlan && (() => {
        const dLabel = (n) => n ? `District ${n}` : 'Unassigned';
        const dmOf = (n) => applyPlan.districtDms[n]?.name;
        const noDm = Object.entries(applyPlan.districtDms).filter(([n, dm]) => !dm.name && !applyPlan.keptLinks.some(k => k.district === Number(n)) && Object.values(draft.stores).some(r => Number(r?.district) === Number(n))).map(([n]) => Number(n));
        const section = (title, rows, color) => rows.length > 0 && (
          <div style={{ marginBottom: '0.9rem' }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: color || th.muted, marginBottom: '0.35rem' }}>{title}</div>
            {rows.map((r, i) => <div key={i} style={{ fontSize: '0.83rem', color: th.text, padding: '0.28rem 0', borderBottom: i === rows.length - 1 ? 'none' : `1px solid ${th.cardBorder}` }}>{r}</div>)}
          </div>
        );
        return (
          <div onClick={() => !applying && setApplyPlan(null)} style={{ position: 'fixed', inset: 0, zIndex: 10001, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
            <div onClick={e => e.stopPropagation()} style={{ background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: '1rem', width: 'min(560px, 94vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '1.2rem 1.4rem 0.6rem' }}>
                <div style={{ fontWeight: 800, fontFamily: "'Raleway'", color: th.text, fontSize: '1.05rem' }}>Apply this plan to live?</div>
                <div style={{ fontSize: '0.82rem', color: th.muted, marginTop: '0.3rem', lineHeight: 1.5 }}>These changes go to the real Locations data and DM accounts. Alerts, reports and DM views follow the new districts from their next run.</div>
              </div>
              <div style={{ padding: '0.4rem 1.4rem', overflowY: 'auto' }}>
                {section(`Stores moving (${applyPlan.storeMoves.length})`, applyPlan.storeMoves.map(m => <><strong>{m.name}</strong> <span style={{ color: th.muted }}>({m.pc})</span> · {dLabel(m.from)} → <strong>{dLabel(m.to)}</strong>{dmOf(m.to) ? <span style={{ color: th.muted }}> ({dmOf(m.to)})</span> : null}{m.editedSinceDraft ? <span style={{ color: '#d97706', fontWeight: 600 }}> · edited in Locations after this draft</span> : null}</>))}
                {section('DM accounts', [
                  ...applyPlan.dmLinks.map(l => <>Link <strong>{l.name}</strong> to <strong>{dLabel(l.to)}</strong>{l.from ? <span style={{ color: th.muted }}> (was {dLabel(l.from)})</span> : null}</>),
                  ...applyPlan.dmUnlinks.map(u => <>Unlink <strong>{u.name}</strong> from {dLabel(u.from)} <span style={{ color: th.muted }}>— the account stays active; deactivate it in Admin → Users if they've left</span></>),
                  ...applyPlan.keptLinks.map(k => <span style={{ color: th.muted }}><strong style={{ color: th.text }}>{k.name}</strong> stays linked to {dLabel(k.district)} — the plan has no DM there, so nothing changes for them</span>),
                ])}
                {section('District DM names in Locations', applyPlan.nameChanges.map(([n, dm]) => <>{dLabel(Number(n))}: {districts?.[n]?.name || <em style={{ color: th.muted }}>none</em>} → <strong>{dm.name || 'none'}</strong></>))}
                {section('Needs attention', [
                  ...(applyPlan.storeMoves.some(m => m.editedSinceDraft) ? [<>Some stores were changed in Locations <strong>after this draft was started</strong> (marked above). Applying puts them where the draft has them — if that's not what you want, Cancel and press <strong>Reset to live data</strong> to start from today's Locations.</>] : []),
                  ...applyPlan.noAccount.map(a => a.keeps
                    ? <><strong>{a.name}</strong> doesn't match any DM account, so <strong>{a.keeps}</strong> stays linked to {dLabel(a.district)}. If {a.name} is a new DM, create their account in Admin → Users first, then pick them with "Change district manager".</>
                    : <><strong>{a.name}</strong> ({dLabel(a.district)}) has no DM account — create one in Admin → Users and link it to {dLabel(a.district)}, or DM alerts for those stores reach nobody.</>),
                  ...noDm.map(n => <>{dLabel(n)} has no DM — DM alerts for its stores reach nobody until one is assigned.</>),
                ], '#d97706')}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', padding: '0.9rem 1.4rem 1.2rem', borderTop: `1px solid ${th.cardBorder}` }}>
                <button onClick={() => setApplyPlan(null)} disabled={applying} style={{ ...outlineBtn(false) }}>Cancel</button>
                <button onClick={runApply} disabled={applying} style={{ ...solidBtn, opacity: applying ? 0.6 : 1 }}>{applying ? 'Applying…' : 'Apply to live'}</button>
              </div>
            </div>
          </div>
        );
      })()}
      {confirmAction && (
        <PortalConfirmModal th={th}
          title={confirmAction.title}
          message={confirmAction.message}
          confirmLabel={confirmAction.confirmLabel}
          onConfirm={() => { confirmAction.run(); setConfirmAction(null); }}
          onCancel={() => setConfirmAction(null)} />
      )}
    </div>
  );
}
