// PCG Deal Pipeline — client API helpers (ESM, bundled into app.jsx by esbuild).
// Acquires a server-signed deal token from deal-auth using the logged-in user's EXISTING
// credential proof — the portal session token (password login) or a live Google access
// token (Google login) — never a raw password. The deal token is verified server-side on
// every request; the browser only relays it and does not grant access on its own.
import { getSessionToken } from './portal-auth.mjs';

const FN = '/.netlify/functions';

/**
 * Exchange the logged-in user's session for a deal token. Access is restricted
 * server-side to IT/Exec users who are also listed in deal_access.
 * @returns {Promise<{token:string|null, role:'view'|'edit'|'admin'|null, status?:number}>}
 */
export async function dealLogin(user) {
  if (!user) return { token: null, role: null };
  const portalToken = getSessionToken();
  // Google-logged-in users carry no portal session token; the login screen attaches the
  // live Google access token onto the user object instead (see app.jsx Google callback).
  const body = portalToken ? { portalToken } : (user.googleAccessToken ? { googleAccessToken: user.googleAccessToken } : null);
  if (!body) return { token: null, role: null };
  try {
    const res = await fetch(`${FN}/deal-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { token: null, role: null, status: res.status };
    const j = await res.json();
    return { token: j.token || null, role: j.role || null };
  } catch {
    return { token: null, role: null };
  }
}

/** Call the authed deals endpoint. Throws on non-2xx (caller surfaces the error). */
export async function dealApi(token, body) {
  const res = await fetch(`${FN}/deals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`deals ${body && body.action} → ${res.status}`);
  return res.json();
}

/** Call the authed deal-docs endpoint (confidential document store). */
export async function dealDocsApi(token, body) {
  const res = await fetch(`${FN}/deal-docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`deal-docs ${body && body.action} → ${res.status}`);
  return res.json();
}

const DOC_CHUNK = 4 * 1024 * 1024; // 4 MB base64 per chunk (under the function size limit)

/**
 * Upload a File as a new version of a deal document (creates the logical doc if needed).
 * Reads → base64 → chunks → uploadChunk×N → finalizeVersion. Returns { document_id, version }.
 */
export async function dealUploadDoc(token, { deal_id, document_id, doc_type, title, file }) {
  let docId = document_id;
  if (!docId) {
    const r = await dealDocsApi(token, { action: 'createDoc', deal_id, doc_type, title: title || file.name });
    docId = r.doc.id;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  const base64 = String(dataUrl).split(',')[1] || '';
  const prefix = String(dataUrl).split(',')[0] + ',';
  const total = Math.ceil(base64.length / DOC_CHUNK) || 1;
  const blobKey = 'dealup_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  for (let i = 0; i < total; i++) {
    await dealDocsApi(token, { action: 'uploadChunk', blobKey, index: i, chunk: base64.slice(i * DOC_CHUNK, (i + 1) * DOC_CHUNK) });
  }
  const r = await dealDocsApi(token, {
    action: 'finalizeVersion', document_id: docId, blobKey, chunks: total,
    filename: file.name, type: file.type, size: file.size, prefix,
  });
  return { document_id: docId, version: r.version };
}

/** Download a specific document version (assembled server-side) and trigger a browser save. */
export async function dealDownloadVersion(token, version_id) {
  const r = await dealDocsApi(token, { action: 'download', version_id });
  const a = document.createElement('a');
  a.href = r.dataUrl; a.download = r.filename || 'document';
  document.body.appendChild(a); a.click(); a.remove();
  return r;
}
