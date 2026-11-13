// src/terms-gate-ui.jsx — "Terms of Use" acceptance after sign-in (v22.92).
// Shown once per TERMS_VERSION to every person-account (shared tablets / kiosks never see it).
// Acceptance is stored on the user (terms-accept.mjs) and in audit_log. If the check itself
// can't reach the server, the Portal opens anyway and asks again next time — nobody is locked out.
import { O, FONTS } from './theme.js';
import { authHeader } from './portal-auth.mjs';

const { useState } = React;
export const TERMS_VERSION = '2026-11-13'; // keep in step with netlify/functions/terms-accept.mjs and terms.html

export async function fetchTermsStatus() {
  const res = await fetch('/.netlify/functions/terms-accept', { credentials: 'include', headers: { ...authHeader() } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function TermsGate({ th, user, onAccepted, onSignOut }) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const accept = async () => {
    setBusy(true); setErr(null);
    try {
      const res = await fetch('/.netlify/functions/terms-accept', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ version: TERMS_VERSION }) });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
      onAccepted();
    } catch (e) { setErr(e.message); setBusy(false); }
  };
  const point = (t) => <li style={{ marginBottom: '0.45rem' }}>{t}</li>;
  return (
    <div style={{ minHeight: '100vh', background: th.bg, color: th.text, fontFamily: FONTS.body, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px', boxSizing: 'border-box' }}>
      <div role="dialog" aria-labelledby="terms-h" style={{ width: '100%', maxWidth: 560, background: th.card, border: `1px solid ${th.cardBorder}`, borderRadius: 16, padding: '1.6rem 1.5rem', boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
        <h1 id="terms-h" style={{ fontFamily: FONTS.head, fontWeight: 800, fontSize: '1.35rem', margin: '0 0 0.4rem' }}>Terms of Use</h1>
        <p style={{ color: th.muted, margin: '0 0 1rem', fontSize: '0.92rem' }}>Hi {String(user?.name || '').split(' ')[0] || 'there'}. Before you continue, please read and accept the Portal's Terms of Use. The main points:</p>
        <ul style={{ margin: '0 0 1rem', paddingLeft: '1.2rem', fontSize: '0.92rem', lineHeight: 1.5 }}>
          {point('Your account is yours alone. Use the Portal only for work, and only look at what your role needs.')}
          {point('Employee, pay and sales information is confidential. Never share it outside PCG.')}
          {point('Signing a form on screen is your real signature, and you confirm what it says is true. Never sign for someone else.')}
          {point('PCG may send you work notices by email, text and phone notification.')}
          {point('Your activity in the Portal is recorded for security.')}
        </ul>
        <p style={{ fontSize: '0.92rem', margin: '0 0 1rem' }}>
          Read the full <a href="/terms.html" target="_blank" rel="noreferrer" style={{ color: O, fontWeight: 700 }}>Terms of Use</a> and <a href="/privacy-policy.html" target="_blank" rel="noreferrer" style={{ color: O, fontWeight: 700 }}>Privacy Policy</a> (they open in a new tab).
        </p>
        <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', fontSize: '0.95rem', cursor: 'pointer', marginBottom: '1rem' }}>
          <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} style={{ accentColor: O, width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
          I have read and agree to the Terms of Use, and I've read the Privacy Policy.
        </label>
        {err && <p role="alert" style={{ color: '#dc2626', fontSize: '0.88rem', margin: '0 0 0.8rem' }}>{err}</p>}
        <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" onClick={onSignOut} disabled={busy} style={{ background: 'none', border: `1px solid ${th.cardBorder}`, color: th.text, borderRadius: 10, padding: '0.6rem 1rem', fontWeight: 600, cursor: 'pointer', fontFamily: FONTS.body }}>Sign out</button>
          <button type="button" onClick={accept} disabled={!agree || busy} style={{ background: O, color: '#fff', border: 'none', borderRadius: 10, padding: '0.6rem 1.2rem', fontWeight: 700, fontFamily: FONTS.body, cursor: agree && !busy ? 'pointer' : 'not-allowed', opacity: agree && !busy ? 1 : 0.5 }}>{busy ? 'Saving…' : 'I agree, continue'}</button>
        </div>
      </div>
    </div>
  );
}
