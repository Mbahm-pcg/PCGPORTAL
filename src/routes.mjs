// src/routes.mjs — every screen has its own web address (v23.24, user 2026-11-24: "it should be
// /labor or /tool/missing hours"). The browser's Back / Forward move between screens, a refresh
// stays put, and a screen can be bookmarked or sent as a link.
//
//   dashboard            → /
//   a tool (Tools hub)   → /tools/<name>        e.g. /tools/missing-hours
//   anything else        → /<name>              e.g. /labor, /executive, /finance
//
// Names are the tab ids, except where the id is an old or internal name (SLUG). Reading an address
// is forgiving: any case, a trailing slash, spaces ("/tool/missing hours") and /tool/ for /tools/.

const SLUG = {
  'pay-increase': 'pay-rate-change', // renamed v23.13; the tab id stayed
  'tools-hub': 'tools', 'ops-hub': 'operations', 'team-hub': 'team', 'system-hub': 'system',
};
const ID_FOR_SLUG = Object.fromEntries(Object.entries(SLUG).map(([id, slug]) => [slug, id]));
const HOME = new Set(['dashboard', '__launcher__']);

export function pathForTab(id, toolIds) {
  if (!id || HOME.has(id)) return '/';
  const slug = SLUG[id] || id;
  return toolIds && toolIds.has(id) ? `/tools/${slug}` : `/${slug}`;
}

export function tabForPath(path) {
  let p = String(path || '/');
  try { p = decodeURIComponent(p); } catch {}
  const parts = p.toLowerCase().split('/').map(s => s.trim().replace(/\s+/g, '-')).filter(Boolean);
  if (!parts.length) return 'dashboard';
  const last = parts[parts.length - 1];
  if (parts.length === 1 && (last === 'tool' || last === 'tools')) return 'tools-hub';
  if (ID_FOR_SLUG[last]) return ID_FOR_SLUG[last];
  if (last === 'pay-increase') return 'pay-increase';
  return last;
}
