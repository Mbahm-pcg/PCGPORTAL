// src/leader-terminations-ui.jsx — Tools · Leader Terminations (v23.27).
// Store Managers / DMs / Directors terminated in Paycor: who was asked, who answered YES / NO (by text
// or here), whether their portal login was turned off, and IT's checklist (Crunch Time, WorkPulse…).
// Exec / IT: the Live switch, "Check Paycor now" and "Send a test".
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';
import { FinBanner, finStyles } from './finance-ui.jsx';

const { useState, useEffect } = React;
const day = (iso) => (iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const when = (ts) => (ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

async function call(body) {
  const res = await fetch('/.netlify/functions/leader-terminations', {
    method: body ? 'POST' : 'GET', credentials: 'include', cache: 'no-store',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
  return b;
}

const STATUS = {
  waiting: ['Not asked yet', '#6b7280'],
  asking: ['Waiting for a YES or NO', '#d97706'],
  approved: ['Approved', '#16a34a'],
  declined: ['Skipped (NO)', '#6b7280'],
};

export function LeaderTerminations({ th, isMobile, onBack }) {
  const S = finStyles(th);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(null);
  const [delivery, setDelivery] = useState({}); // v23.29: id → [{ phone, accepted, error, status }]
  const load = () => call().then(b => { setData(b); setErr(null); }).catch(e => setErr(e.message));
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => clearInterval(t);
  }, []);
  const act = async (key, body, done) => {
    setBusy(key); setErr(null);
    try { const b = await call(body); setMsg(done(b)); await load(); } catch (e) { setErr(e.message); }
    setBusy(null);
  };

  const rows = data?.rows || [];
  const open = rows.filter(r => !r.doneAt && r.status !== 'declined');
  const closed = rows.filter(r => r.doneAt || r.status === 'declined');
  const chip = (r) => { const [l, c] = STATUS[r.status] || [r.status, th.muted]; return <span style={{ color: c, fontWeight: 700 }}>{r.doneAt ? 'Done' : l}</span>; };

  const card = (r) => {
    const checks = data.checklist.map(item => ({ item, ...(r.checklist?.[item] || {}) }));
    const doneCount = checks.filter(c => c.done).length;
    return (
      <div key={r.id} style={{ ...S.panel, padding: '0.9rem 1rem', display: 'grid', gap: '0.55rem', borderLeft: `4px solid ${r.status === 'asking' ? '#d97706' : r.status === 'approved' && !r.doneAt ? O : th.cardBorder}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div style={{ fontWeight: 800, fontSize: '1.02rem', color: th.text }}>{r.isTest && <span style={{ color: '#7c3aed' }}>TEST · </span>}{r.name}
            <span style={{ fontWeight: 500, color: th.muted }}> {r.title}{r.store ? `, ${r.store}` : r.district ? `, District ${r.district}` : ''}</span></div>
          <span style={{ fontSize: '0.85rem' }}>{chip(r)}</span>
        </div>
        <div style={{ color: th.muted, fontSize: '0.84rem', lineHeight: 1.5 }}>
          Terminated in Paycor {day(r.terminationDate)} · found {when(r.detectedAt)}{r.source === 'daily' ? ' (morning list)' : ''}
          {r.askedAt && <> · asked {r.askedOk} of {r.askedCount} by text {when(r.askedAt)}</>}
          {r.answeredBy && <><br /><b style={{ color: th.text }}>{r.answeredBy}</b> answered <b style={{ color: r.answer === 'yes' ? '#16a34a' : th.text }}>{String(r.answer).toUpperCase()}</b> {r.answeredVia === 'portal' ? 'in the portal' : 'by text'}, {when(r.answeredAt)}</>}
          {r.status === 'approved' && <><br />Portal login: {r.isTest ? 'test, not touched' : r.portalOff === 'Turned off automatically' ? 'turned off automatically' : r.portalOff || (r.hasAccount ? '...' : 'no portal account found')}</>}
          {r.doneAt && <><br />Done by {r.doneBy}, {when(r.doneAt)}</>}
        </div>
        {data.canAdmin && (r.sends || []).length > 0 && (
          <div style={{ fontSize: '0.8rem', color: th.muted, display: 'grid', gap: '0.15rem' }}>
            {(delivery[r.id] || r.sends.map(x => ({ phone: x.phone, accepted: x.ok, error: x.error, status: null }))).map((x, i) => (
              <span key={i}>Text to {x.phone}: {x.accepted
                ? <b style={{ color: x.status === 'DELIVERED' ? '#16a34a' : x.status && x.status !== 'SENT' && x.status !== 'SENDING' ? '#dc2626' : th.text }}>{x.status ? x.status.toLowerCase() : 'accepted by Textbelt'}</b>
                : <b style={{ color: '#dc2626' }}>refused by Textbelt{x.error ? `: ${x.error}` : ''}</b>}</span>
            ))}
            <button type="button" className="fin-btn" disabled={busy === `v${r.id}`} style={{ ...S.link, color: O, justifySelf: 'start', fontSize: '0.8rem', fontWeight: 700 }}
              onClick={async () => { setBusy(`v${r.id}`); try { const b = await call({ action: 'delivery', id: r.id }); setDelivery(d => ({ ...d, [r.id]: b.delivery })); } catch (e) { setErr(e.message); } setBusy(null); }}>{busy === `v${r.id}` ? 'Asking Textbelt…' : 'Check delivery'}</button>
          </div>
        )}
        {r.status === 'asking' && data.canAnswer && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="fin-btn" disabled={busy === `a${r.id}`} style={{ ...S.primary, minHeight: 38 }}
              onClick={() => window.confirm(`Deactivate ${r.name}'s accounts? Their portal login is turned off now and IT is told.`) && act(`a${r.id}`, { action: 'answer', id: r.id, answer: 'yes' }, () => `YES for ${r.name}. IT has been told.`)}>Yes, deactivate</button>
            <button type="button" className="fin-btn" disabled={busy === `a${r.id}`} style={{ ...S.ghost, minHeight: 38 }}
              onClick={() => act(`a${r.id}`, { action: 'answer', id: r.id, answer: 'no' }, () => `NO for ${r.name}. Nothing will be done.`)}>No, skip</button>
          </div>
        )}
        {r.status === 'approved' && (
          <div style={{ display: 'grid', gap: '0.3rem', padding: '0.6rem 0.75rem', borderRadius: 10, background: th.card3 }}>
            <div style={{ fontWeight: 700, fontSize: '0.86rem', color: th.text }}>Deactivate ({doneCount}/{checks.length})</div>
            {checks.map(c => (
              <label key={c.item} style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', fontSize: '0.9rem', color: th.text, cursor: data.canCheck && !r.doneAt ? 'pointer' : 'default' }}>
                <input type="checkbox" checked={!!c.done} disabled={!data.canCheck || !!r.doneAt || busy === `c${r.id}${c.item}`} style={{ accentColor: O, width: 18, height: 18 }}
                  onChange={e => act(`c${r.id}${c.item}`, { action: 'check', id: r.id, item: c.item, done: e.target.checked }, () => null)} />
                <span>{c.item}</span>{c.done && <span style={{ color: th.muted, fontSize: '0.76rem' }}>{c.by === 'automatic' ? 'automatic' : c.by}{c.at ? `, ${when(c.at)}` : ''}</span>}
              </label>
            ))}
            {data.canCheck && !r.doneAt && (
              <button type="button" className="fin-btn" disabled={busy === `d${r.id}`} style={{ ...S.primary, justifySelf: 'end', minHeight: 36, opacity: doneCount === checks.length ? 1 : 0.85 }}
                onClick={() => (doneCount === checks.length || window.confirm('Not everything is ticked. Mark it done anyway?')) && act(`d${r.id}`, { action: 'done', id: r.id }, () => `Done: ${r.name}.`)}>Mark done</button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', fontFamily: FONTS.body }}>
      {onBack && <button type="button" className="fin-btn" onClick={onBack} style={{ ...S.link, color: th.muted, fontWeight: 600, marginBottom: '0.4rem' }}>Back to Tools</button>}
      <h2 style={S.title}>Leader Terminations</h2>
      <p style={S.lede}>When a Store Manager, DM or Director is terminated in Paycor, the people on Admin · Notifications · Leader termination are texted. The first to reply YES turns off their portal login and sends IT the checklist below; NO skips it. Checked every 15 minutes; texts go out 7am–9pm.</p>
      {err && <FinBanner th={th} tone="error">{err}</FinBanner>}
      {msg && <FinBanner th={th} tone="success">{msg}</FinBanner>}
      {!data ? <p style={{ color: th.muted }}>Loading…</p> : (<>
        {data.canAdmin && (
          <div style={{ ...S.panel, padding: '0.75rem 0.9rem', display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
            <button type="button" className="fin-btn" disabled={busy === 'live'}
              onClick={() => { const on = !data.live; if (on && !window.confirm('Switch Live ON? From now on, a terminated leader texts the Leader termination list, and a YES turns off their portal login.')) return; act('live', { action: 'live', enabled: on }, () => `Live is ${on ? 'ON' : 'OFF'}.`); }}
              style={{ ...S.ghost, minHeight: 38, borderColor: data.live ? '#16a34a' : th.cardBorder, color: data.live ? '#16a34a' : th.muted, fontWeight: 800 }}>Live: {data.live ? 'ON' : 'OFF'}</button>
            <button type="button" className="fin-btn" disabled={busy === 'test'} style={{ ...S.ghost, minHeight: 38 }}
              onClick={() => act('test', { action: 'test' }, (b) => `Test sent to ${b.sent || 0} phone${b.sent === 1 ? '' : 's'}${b.emails ? ` and ${b.emails} email${b.emails === 1 ? '' : 's'}` : ''}. Reply YES or NO to the text to try it; nothing real is touched.`)}>{busy === 'test' ? 'Sending…' : 'Send a test'}</button>
            {rows.some(r => r.isTest) && <button type="button" className="fin-btn" disabled={busy === 'clear'} style={{ ...S.ghost, minHeight: 38, color: '#7c3aed', borderColor: '#7c3aed' }}
              onClick={() => act('clear', { action: 'clearTests' }, (b) => `Removed ${b.removed} test case${b.removed === 1 ? '' : 's'}.`)}>Remove test cases</button>}
            <button type="button" className="fin-btn" disabled={busy === 'run'} style={{ ...S.ghost, minHeight: 38 }}
              onClick={() => act('run', { action: 'runNow' }, (b) => `Checked ${b.checked || 0} of ${b.leaders || 0} linked leaders in Paycor${b.errors ? ` (${b.errors} couldn't be read)` : ''}. ${b.created ? `${b.created} new.` : 'Nothing new.'}${b.held === 'live-off' && b.created ? ' Not texted: Live is OFF.' : ''}`)}>{busy === 'run' ? 'Checking…' : 'Check Paycor now'}</button>
            {data.textbelt && <span style={{ fontSize: '0.82rem', fontWeight: 700, color: data.textbelt.error ? '#dc2626' : th.text }}>{data.textbelt.error ? `Textbelt: ${data.textbelt.error}` : `Textbelt credits left: ${data.textbelt.left ?? '?'}`}</span>}
            <span style={{ color: th.muted, fontSize: '0.82rem' }}>{data.live ? 'Texts go out.' : 'OFF: terminations are only recorded here, nobody is texted.'}{!data.askListSize ? ' Nobody is on the Leader termination list yet, so the executives are asked.' : ''}</span>
          </div>
        )}
        <div style={{ display: 'grid', gap: '0.7rem' }}>
          {open.length ? open.map(card) : <p style={{ color: th.muted }}>Nothing open.</p>}
        </div>
        {closed.length > 0 && (<>
          <div style={{ fontWeight: 800, color: th.text, margin: '1.4rem 0 0.6rem' }}>Finished</div>
          <div style={{ display: 'grid', gap: '0.7rem' }}>{closed.slice(0, 30).map(card)}</div>
        </>)}
      </>)}
    </div>
  );
}
