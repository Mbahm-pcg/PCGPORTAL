// src/violation-collect-ui.jsx — after HR approves a Violation Notice (new flow, v22.98): get the
// employee's signature (here on this screen, by emailed link, or "refused to sign") and, optionally,
// a witness's. Used on the Waiting on signatures list by the supervisor who wrote it, HR, exec and
// IT. The server stamps each signature onto the approved PDF and files it once the employee is done
// and no link is still open (violation-notice.mjs: signHere / refused / sendLink).
import { O, FONTS } from './theme.js';
import { FinBanner, finStyles } from './finance-ui.jsx';
import { SignatureModal } from './transfer-notice-ui.jsx';

const { useState } = React;
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const phoneOk = (p) => { const d = String(p || '').replace(/\D/g, ''); return !d || d.length === 10 || (d.length === 11 && d[0] === '1'); };

export function VnCollect({ th, item, call, onDone }) {
  const S = finStyles(th);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [signing, setSigning] = useState(null); // 'employee' | 'witness'
  const [linkFor, setLinkFor] = useState(null); // 'employee' | 'witness'
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [witnessName, setWitnessName] = useState(item.witnessName || '');
  const empDone = item.employeeSigned || item.employeeRefused;

  const run = async (body, okText) => {
    setBusy(true); setMsg(null);
    try {
      const b = await call({ id: item.id, ...body });
      if (body.action === 'sendLink') {
        const s = b.sign || {};
        setMsg({ tone: s.sent ? 'success' : 'error', text: s.sent ? `Link emailed${s.texted ? ', with a reminder text' : s.phone ? '' : ' (no cell number, so no reminder text)'}. It expires ${new Date(s.expiresAt).toLocaleDateString('en-US')}.` : 'The email did not go through. Check the address.' });
        setLinkFor(null);
      } else setMsg({ tone: 'success', text: b.filed ? `${okText} The notice is complete and filed.` : okText });
      onDone && onDone();
    } catch (e) { setMsg({ tone: 'error', text: e.message }); }
    setBusy(false);
  };
  const btn = (label, onClick, opts = {}) => (
    <button type="button" className="fin-btn" disabled={busy || opts.disabled} onClick={onClick}
      style={{ ...(opts.primary ? S.primary : S.ghost), minHeight: 34, padding: '0.35rem 0.8rem', fontSize: '0.85rem', ...(opts.danger ? { color: '#b91c1c' } : {}), opacity: busy || opts.disabled ? 0.5 : 1 }}>{label}</button>
  );
  const inputStyle = { ...S.input, padding: '0.45rem 0.6rem', fontSize: '0.9rem' };
  const linkForm = (role) => linkFor === role && (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '0.5rem' }}>
      <label style={{ ...S.fieldLabel, flex: '1 1 14em' }}>{role === 'witness' ? 'Witness' : 'Employee'} email<input type="email" inputMode="email" autoComplete="off" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} /></label>
      <label style={{ ...S.fieldLabel, flex: '1 1 10em' }}>Cell (optional)<input type="tel" inputMode="tel" autoComplete="off" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(215) 555-0100" style={inputStyle} /></label>
      {btn('Send link', () => run({ action: 'sendLink', role, email: email.trim(), phone, witnessName }), { primary: true, disabled: !emailOk(email) || !phoneOk(phone) || (role === 'witness' && !witnessName.trim()) })}
      <span style={{ flexBasis: '100%', fontSize: '0.8rem', color: th.muted }}>With a cell number they also get a reminder text and confirm its last 4 digits before signing. Without one, the email link alone opens it, and the signed notice says so.</span>
    </div>
  );

  return (
    <div style={{ marginTop: '0.7rem', padding: '0.8rem 0.9rem', borderRadius: 10, background: th.card3, fontFamily: FONTS.body, fontSize: '0.9rem' }}>
      {msg && <div style={{ marginBottom: '0.6rem' }}><FinBanner th={th} tone={msg.tone}>{msg.text}</FinBanner></div>}
      <div style={{ fontWeight: 700, marginBottom: '0.35rem' }}>Witness <span style={{ fontWeight: 400, color: th.muted }}>(optional: add them before the employee signs)</span></div>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={witnessName} onChange={e => setWitnessName(e.target.value)} placeholder="Witness name" aria-label="Witness name" maxLength={80} style={{ ...inputStyle, width: '13em' }} />
        {btn('Witness signs here', () => setSigning('witness'), { disabled: !witnessName.trim() })}
        {btn('Email the witness a link', () => { setLinkFor(linkFor === 'witness' ? null : 'witness'); setEmail(''); setPhone(''); }, { disabled: !witnessName.trim() })}
      </div>
      {linkForm('witness')}

      <div style={{ fontWeight: 700, margin: '0.9rem 0 0.35rem' }}>Employee: {item.employeeName}</div>
      {empDone
        ? <div style={{ color: '#16a34a', fontWeight: 600 }}>{item.employeeRefused ? 'Recorded as refused to sign.' : 'Signed.'}</div>
        : (<>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {btn('Employee signs here', () => setSigning('employee'), { primary: true })}
            {btn('Email the employee a link', () => { setLinkFor(linkFor === 'employee' ? null : 'employee'); setEmail(''); setPhone(''); })}
            {btn('Employee refused to sign', () => { if (window.confirm(`Record that ${item.employeeName} refused to sign? The notice will be filed with "Refused to sign".`)) run({ action: 'refused', role: 'employee' }, 'Recorded as refused to sign.'); }, { danger: true })}
          </div>
          {linkForm('employee')}
        </>)}
      {signing && <SignatureModal th={th} title={signing === 'employee' ? `Employee signature — ${item.employeeName}` : `Witness signature — ${witnessName}`} onCancel={() => setSigning(null)}
        onDone={(image) => { const role = signing; setSigning(null); run({ action: 'signHere', role, signature: image, witnessName }, role === 'employee' ? 'Employee signed.' : 'Witness signed.'); }} />}
    </div>
  );
}
