// PCG Deal Pipeline — client API helpers (ESM, bundled into app.jsx by esbuild).
// Acquires a server-signed deal token from deal-auth using the logged-in user's
// credentials, then calls the authenticated deals endpoints. The token is verified
// server-side on every request — the browser only relays it; it does not grant access.
const FN = '/.netlify/functions';

/**
 * Exchange the logged-in user's credentials for a deal session token.
 * @returns {Promise<{token:string|null, role:'view'|'edit'|'admin'|null, status?:number}>}
 */
export async function dealLogin(user) {
  if (!user || !user.username) return { token: null, role: null };
  try {
    const res = await fetch(`${FN}/deal-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password: user.password || '' }),
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
