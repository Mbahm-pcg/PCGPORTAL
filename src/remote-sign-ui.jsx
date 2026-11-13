// src/remote-sign-ui.jsx — the page an employee opens from a Violation Notice signing link
// (`<portal>/?sign=<code>`, v22.81). No portal account and no login: the code in the link plus the
// last 4 digits of their phone open exactly one notice (violation-sign.mjs). They read it, sign,
// and the server stamps their signature on the original — they never edit the form.
import { O, FONTS, getTheme } from './theme.js';
import { FIN_CSS, FinBanner, finStyles } from './finance-ui.jsx';
import { SignatureModal } from './transfer-notice-ui.jsx';

const { useState, useEffect, useRef } = React;

const call = async (body) => {
  const res = await fetch('/.netlify/functions/violation-sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(b.error || `HTTP ${res.status}`); e.done = !!b.done; throw e; }
  return b;
};
const b64ToBytes = (b64) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

function PdfPages({ b64, width }) {
  const ref = useRef(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const lib = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
      if (!lib) throw new Error('The viewer did not load — refresh the page.');
      lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const doc = await lib.getDocument({ data: b64ToBytes(b64) }).promise;
      const host = ref.current;
      if (!live || !host) return;
      host.innerHTML = '';
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const dpr = window.devicePixelRatio || 1;
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (width / base.width) * dpr });
        const c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        c.style.width = `${width}px`; c.style.height = `${vp.height / dpr}px`; c.style.display = 'block'; c.style.background = '#fff';
        c.setAttribute('aria-label', `Page ${n}`);
        host.appendChild(c);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      }
    })().catch(e => live && setErr(e.message));
    return () => { live = false; };
  }, [b64, width]);
  if (err) return <p style={{ color: '#dc2626' }}>{err}</p>;
  return <div ref={ref} style={{ borderRadius: 6, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 12px 32px rgba(0,0,0,0.08)' }} />;
}

export function RemoteSignPage({ token }) {
  const th = getTheme(false);
  const S = finStyles(th);
  const [hello, setHello] = useState(null);
  const [error, setError] = useState(null);
  const [fatal, setFatal] = useState(null); // link can't be used at all
  const [last4, setLast4] = useState('');
  const [doc, setDoc] = useState(null); // { employeeName, storeName, pdf }
  const [read, setRead] = useState(false);
  const [consent, setConsent] = useState(false); // v22.92: consent to sign electronically (ESIGN / PA UETA)
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // { url }
  const width = Math.min(820, (typeof window !== 'undefined' ? window.innerWidth : 820) - 32);

  useEffect(() => { document.title = 'Review and sign · PCG'; call({ token, action: 'hello' }).then(setHello).catch(e => setFatal(e.message)); }, []);

  const open = async (e) => {
    e.preventDefault();
    if (!/^\d{4}$/.test(last4)) { setError('Enter the last 4 digits of your phone number.'); return; }
    setBusy(true); setError(null);
    try { setDoc(await call({ token, last4, action: 'open' })); }
    catch (err) { if (/locked|expired|replaced|signed/.test(err.message)) setFatal(err.message); else setError(err.message); }
    setBusy(false);
  };
  const sign = async (signature) => {
    setSigning(false); setBusy(true); setError(null);
    try {
      const b = await call({ token, last4, action: 'sign', signature, esignConsent: consent });
      setDone({ url: URL.createObjectURL(new Blob([b64ToBytes(b.pdf)], { type: 'application/pdf' })) });
    } catch (err) { if (err.done) setDone({}); else setError(err.message); }
    setBusy(false);
  };

  const shell = (children) => (
    <div className="fin-root" style={{ minHeight: '100vh', background: th.bg, color: th.text, fontFamily: FONTS.body, padding: '20px 16px 48px', boxSizing: 'border-box' }}>
      <style>{FIN_CSS(th)}</style>
      <div style={{ maxWidth: 820, margin: '0 auto' }}>
        <img src="/pcg-logo-form.jpg" alt="People Capital Group" style={{ height: 56, display: 'block', margin: '0 auto 1rem' }} />
        {children}
        <p style={{ textAlign: 'center', fontSize: '0.8rem', color: th.muted, marginTop: '2rem' }}>
          <a href="/terms.html" target="_blank" rel="noreferrer" style={{ color: th.muted }}>Terms of Use</a>{'  ·  '}<a href="/privacy-policy.html" target="_blank" rel="noreferrer" style={{ color: th.muted }}>Privacy Policy</a>
        </p>
      </div>
    </div>
  );

  if (done) return shell(<>
    <h1 style={{ ...S.title, textAlign: 'center' }}>Thank you, it's signed</h1>
    <p style={{ ...S.lede, textAlign: 'center', margin: '0 auto 1.2rem' }}>Your signature was added and your supervisor has the signed copy. You can close this page.</p>
    {done.url && <p style={{ textAlign: 'center' }}><a href={done.url} target="_blank" rel="noreferrer" style={{ ...S.ghost, textDecoration: 'none', display: 'inline-flex' }}>Open your signed copy</a></p>}
  </>);
  if (fatal) return shell(<><h1 style={{ ...S.title, textAlign: 'center' }}>This link can't be used</h1><p style={{ ...S.lede, textAlign: 'center', margin: '0 auto' }}>{fatal}</p></>);
  if (!hello) return shell(<p style={{ color: th.muted, textAlign: 'center' }}>Loading…</p>);

  if (!doc) return shell(
    <form onSubmit={open} style={{ ...S.panel, padding: '1.3rem 1.2rem', maxWidth: 440, margin: '0 auto' }}>
      <h1 style={{ ...S.title, fontSize: '1.3rem' }}>Hi {hello.firstName}</h1>
      <p style={{ ...S.lede, marginBottom: '1rem' }}>{hello.kind === 'resignation'
        ? `People Capital Group has your resignation letter for ${hello.storeName} ready for you to review and sign.`
        : hello.kind === 'letter'
        ? `People Capital Group has a warning letter from ${hello.storeName} for you to read and acknowledge.`
        : hello.role === 'witness'
        ? `People Capital Group asks you to sign as witness on ${hello.employeeName}'s Violation Notice from ${hello.storeName}.`
        : `People Capital Group has a Violation Notice from ${hello.storeName} for you to review and sign.`} To open it, enter the last 4 digits of the cell number your supervisor has for you.</p>
      <label style={S.fieldLabel}>Last 4 digits of your phone
        <input style={{ ...S.input, fontSize: '1.3rem', letterSpacing: '0.3em', textAlign: 'center', fontVariantNumeric: 'lining-nums tabular-nums' }} value={last4} onChange={e => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
          inputMode="numeric" autoComplete="off" maxLength={4} aria-label="Last 4 digits of your phone" autoFocus />
      </label>
      {error && <div style={{ marginTop: '0.8rem' }}><FinBanner th={th} tone="error">{error}</FinBanner></div>}
      <button type="submit" className="fin-btn" disabled={busy} style={{ ...S.primary, width: '100%', marginTop: '1rem' }}>{busy ? 'Checking…' : hello.kind === 'resignation' || hello.kind === 'letter' ? 'Open the letter' : 'Open the notice'}</button>
    </form>
  );

  return shell(<>
    <h1 style={S.title}>{doc.kind === 'resignation' ? 'Your resignation letter' : doc.kind === 'letter' ? 'Your warning letter' : doc.role === 'witness' ? `Witness: ${doc.employeeName}'s Violation Notice` : 'Your Violation Notice'}</h1>
    <p style={S.lede}>{doc.kind === 'resignation'
      ? 'Read your resignation letter below. If it is correct, sign it at the bottom. If anything is wrong (your position, store or last day), do not sign; tell your supervisor so they can fix it and send a new one.'
      : doc.kind === 'letter'
      ? 'Read the letter below. The last page is an acknowledgment of receipt; sign it at the bottom. Signing confirms you received the letter; it does not mean you agree with it.'
      : doc.role === 'witness'
      ? 'Read the notice below, then sign at the bottom as the witness.'
      : 'Read the notice below, then sign at the bottom. Signing confirms you received it and discussed it with your manager; it does not mean you agree with it.'}</p>
    <PdfPages b64={doc.pdf} width={width} />
    <div style={{ ...S.panel, padding: '1.1rem 1.2rem', marginTop: '1.2rem' }}>
      <section aria-labelledby="esign-h" style={{ fontSize: '0.86rem', lineHeight: 1.5, color: th.text, background: th.card3, borderRadius: 10, padding: '0.85rem 1rem', marginBottom: '1rem' }}>
        <h2 id="esign-h" style={{ fontSize: '0.95rem', margin: '0 0 0.4rem', fontWeight: 700 }}>Signing electronically</h2>
        <p style={{ margin: '0 0 0.4rem' }}>People Capital Group asks you to sign this document electronically. Your electronic signature has the same effect as signing on paper. Before you agree:</p>
        <ul style={{ margin: '0 0 0.2rem', paddingLeft: '1.2rem' }}>
          <li>You don't have to sign electronically. If you'd rather sign on paper, don't sign here; tell your supervisor or HR and they will give you a paper copy to sign.</li>
          <li>You can ask HR for a free paper copy of this document at any time, signed or not.</li>
          <li>After you sign you can open and save your signed copy (PDF) on this page. You need a phone or computer with a web browser that can open PDF files.</li>
          <li>This agreement covers this one document only. You can withdraw it any time before you sign by closing this page and telling your supervisor or HR.</li>
        </ul>
      </section>
      <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', fontSize: '0.95rem', lineHeight: 1.45, cursor: 'pointer', marginBottom: '0.7rem' }}>
        <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ accentColor: O, width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
        I agree to receive and sign this document electronically.
      </label>
      <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', fontSize: '0.95rem', lineHeight: 1.45, cursor: 'pointer' }}>
        <input type="checkbox" checked={read} onChange={e => setRead(e.target.checked)} style={{ accentColor: O, width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
        {doc.kind === 'resignation' ? `I, ${doc.signerName}, have read this resignation letter and it is correct.` : doc.kind === 'letter' ? `I, ${doc.signerName}, have read this warning letter.` : doc.role === 'witness' ? `I, ${doc.signerName}, witnessed this Violation Notice for ${doc.employeeName}.` : `I, ${doc.signerName}, have read this Violation Notice.`}
      </label>
      {error && <div style={{ marginTop: '0.8rem' }}><FinBanner th={th} tone="error">{error}</FinBanner></div>}
      <button type="button" className="fin-btn" disabled={!read || !consent || busy} onClick={() => setSigning(true)}
        style={{ ...S.primary, width: '100%', marginTop: '1rem', opacity: read && consent && !busy ? 1 : 0.5, cursor: read && consent && !busy ? 'pointer' : 'not-allowed' }}>{busy ? 'Signing…' : doc.kind === 'resignation' ? 'Sign the letter' : doc.kind === 'letter' ? 'Sign the acknowledgment' : 'Sign the notice'}</button>
    </div>
    {signing && <SignatureModal th={th} title={`Your signature — ${doc.signerName}`} onCancel={() => setSigning(false)} onDone={sign} />}
  </>);
}
