// src/update-check.mjs — notice when a new Portal release is live (v22.94).
//
// Why: an iPhone home-screen app or a desktop tab stays open for days. After a deploy it keeps
// running the OLD app.js against the NEW server until someone force-quits it — which is how
// people were "fixing" being logged out after an update (user, 2026-11-13). This compares the
// ETag of /app.js (it changes with every build) against the one this page loaded with.
//
// startUpdateWatch({ onUpdate }) → stop(). onUpdate(info) is called once a newer build is live,
// with info.hiddenMs = how long the page was in the background when it was noticed (0 if visible).

const URL_ = '/app.js';
const EVERY_MS = 5 * 60 * 1000;

async function currentTag() {
  try {
    const res = await fetch(URL_, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return null;
    return res.headers.get('etag') || res.headers.get('last-modified') || null;
  } catch { return null; }
}

export function startUpdateWatch({ onUpdate }) {
  let base = null, done = false, hiddenAt = null, timer = null;
  const check = async (hiddenMs = 0) => {
    if (done) return;
    const tag = await currentTag();
    if (!tag) return;
    if (!base) { base = tag; return; }
    if (tag !== base) { done = true; onUpdate({ hiddenMs }); }
  };
  const onVis = () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    const hiddenMs = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    check(hiddenMs);
  };
  check();
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('focus', onVis);
  timer = setInterval(() => check(0), EVERY_MS);
  return () => { done = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('focus', onVis); };
}

// Reload onto the new build, at most once a minute (guards against a reload loop if the
// CDN briefly serves mixed versions right after a deploy).
export function reloadForUpdate() {
  try {
    const last = Number(sessionStorage.getItem('pcg_update_reload_at') || 0);
    if (Date.now() - last < 60000) return false;
    sessionStorage.setItem('pcg_update_reload_at', String(Date.now()));
  } catch { /* storage blocked — still reload */ }
  window.location.reload();
  return true;
}
