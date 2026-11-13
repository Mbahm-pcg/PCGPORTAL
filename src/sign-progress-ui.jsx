// src/sign-progress-ui.jsx — where each signing link stands (v22.91), shown on the Waiting on
// signature lists of Violation Notice / warning letters and Resignation Letter.
//
//   Emailed → Delivered (or Bounced) → Opened email (a hint) → Opened link → Signed
//
// "Delivered", "Bounced" and "Opened email" come from Resend's webhook (resend-webhook.mjs) and
// only exist for links sent after v22.91. "Opened email" is a hint: some mail apps load it on their
// own and some block it. "Opened link" is recorded by the signing page itself and is reliable.
// A bounced email gets Fix email: type the right address and a new link goes to it.
import { O, FONTS } from './theme.js';

const { useState } = React;
const when = (d) => (d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function Step({ th, label, at, state, title }) {
  // state: 'done' | 'bad' | 'hint' | 'todo'
  const color = state === 'done' ? '#16a34a' : state === 'bad' ? '#dc2626' : state === 'hint' ? '#0369a1' : th.muted;
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3em', color, fontWeight: state === 'todo' ? 500 : 700, whiteSpace: 'nowrap' }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: state === 'todo' ? 'transparent' : color, border: `1.5px solid ${color}`, flexShrink: 0 }} />
      {label}{at ? <span style={{ fontWeight: 500, color: th.muted }}>{when(at)}</span> : null}
    </span>
  );
}

function SignerRow({ th, s, showRole, onFix, busy }) {
  const [fixing, setFixing] = useState(false);
  const [email, setEmail] = useState('');
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const arrow = <span aria-hidden="true" style={{ color: th.muted }}>›</span>;
  const steps = [];
  steps.push(<Step key="e" th={th} label="Emailed" at={s.sentAt} state="done" title={s.email ? `Sent to ${s.email}` : undefined} />);
  if (s.bouncedAt) steps.push(<Step key="b" th={th} label={`Bounced${s.bounceReason ? `: ${s.bounceReason}` : ''}`} state="bad" title="The email did not reach them. Fix the address and send a new link." />);
  else steps.push(<Step key="d" th={th} label="Delivered" at={s.deliveredAt} state={s.deliveredAt ? 'done' : 'todo'} title={s.emailed ? undefined : 'Delivery tracking started with v22.91'} />);
  if (s.emailOpenedAt && !s.seenAt && !s.signedAt) steps.push(<Step key="o" th={th} label="Opened email (hint)" at={s.emailOpenedAt} state="hint" title="Some email apps report this on their own; it's only a hint." />);
  steps.push(<Step key="l" th={th} label={s.seenAt && !s.openedAt ? 'Opened link, stopped at the phone check' : 'Opened link'} at={s.openedAt || s.seenAt} state={s.openedAt ? 'done' : s.seenAt ? 'hint' : 'todo'} />);
  steps.push(<Step key="s" th={th} label={s.signedAt ? 'Signed' : s.expired ? 'Link expired' : s.locked ? 'Locked (wrong digits)' : 'Not signed'} at={s.signedAt} state={s.signedAt ? 'done' : s.expired || s.locked ? 'bad' : 'todo'} />);
  return (
    <div style={{ marginTop: 6, fontFamily: FONTS.body, fontSize: '0.78rem' }}>
      {showRole && <span style={{ fontWeight: 700, color: th.text, marginRight: '0.5em' }}>{s.role === 'witness' ? 'Witness' : 'Employee'}{s.signer ? ` (${s.signer})` : ''}:</span>}
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35em 0.55em' }}>
        {steps.flatMap((x, i) => (i ? [<span key={`a${i}`}>{arrow}</span>, x] : [x]))}
      </span>
      {s.bouncedAt && !s.signedAt && onFix && (fixing ? (
        <span style={{ display: 'flex', gap: '0.5em', alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <input type="email" inputMode="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} placeholder="the right email address" aria-label="Correct email address"
            style={{ fontFamily: FONTS.body, fontSize: '0.85rem', padding: '0.3rem 0.5rem', borderRadius: 6, border: `1px solid ${th.cardBorder}`, background: th.card, color: th.text, minWidth: 0, width: '16em', maxWidth: '100%' }} />
          <button type="button" className="fin-btn" disabled={!ok || busy} onClick={() => onFix(s.role, email.trim())}
            style={{ background: O, color: '#fff', border: 'none', borderRadius: 6, padding: '0.35rem 0.75rem', fontWeight: 700, fontSize: '0.8rem', cursor: ok && !busy ? 'pointer' : 'not-allowed', opacity: ok && !busy ? 1 : 0.5 }}>{busy ? 'Sending…' : 'Send new link'}</button>
          <button type="button" className="fin-btn" onClick={() => setFixing(false)} style={{ background: 'none', border: 'none', color: th.muted, cursor: 'pointer', fontSize: '0.8rem' }}>Cancel</button>
        </span>
      ) : <button type="button" className="fin-btn" onClick={() => setFixing(true)} style={{ background: 'none', border: 'none', color: O, fontWeight: 700, cursor: 'pointer', padding: 0, marginLeft: '0.6em', fontSize: '0.8rem' }}>Fix email</button>)}
    </div>
  );
}

// signing: [{ role, signer, email, sentAt, deliveredAt, bouncedAt, bounceReason, emailOpenedAt, seenAt, openedAt, signedAt, expired, locked }]
export function SignProgress({ th, signing, onFix, busy }) {
  if (!signing || !signing.length) return null;
  const many = signing.length > 1;
  return <div>{signing.map(s => <SignerRow key={s.role} th={th} s={s} showRole={many} onFix={onFix} busy={busy} />)}</div>;
}
