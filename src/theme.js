const BRAND_CONFIG = {
  name: 'People Capital Group',
  shortName: 'PCG',
  portalName: 'PCG Company Portal',
  portalUrl: 'https://pcg-ops.netlify.app',
  primary: '#FF671F',
  primaryDark: '#cc4f12',
  googleDomain: '@peoplecapitalgroup.com',
};
const O = BRAND_CONFIG.primary, Od = BRAND_CONFIG.primaryDark, W = "#fff";

const DARK = {
  dark: true,
  bg: "#0f0f0f",
  sidebar: "#0f0f0f",
  sidebarBorder: "#1e1e1e",
  card: "#1c1c1c",
  card2: "#242424",
  card3: "#2e2e2e",
  cardBorder: "#2a2a2a",
  text: "#e8e8e8",
  muted: "#a0a0a0",
  subtle: "#555",
  inputBg: "#242424",
  inputBorder: "#333",
  ob: "#FF671F18",
  headerBg: "#0f0f0f",
  headerBorder: "#1e1e1e",
  logoSeal: "dark_seal",
  logoWide: "wide_dark",
};

const LIGHT = {
  dark: false,
  bg: "#f0ede8",
  sidebar: "#ffffff",
  sidebarBorder: "#e8e5e0",
  card: "#ffffff",
  card2: "#f8f6f3",
  card3: "#ede9e3",
  cardBorder: "#e0ddd8",
  text: "#1a1710",
  muted: "#6b6560",
  subtle: "#aaa",
  inputBg: "#f8f6f3",
  inputBorder: "#dedad4",
  ob: "#FF671F15",
  headerBg: "#ffffff",
  headerBorder: "#e0ddd8",
  logoSeal: "light_seal",
  logoWide: "wide_dark",
};

function getTheme(dark) { return dark ? DARK : LIGHT; }

// ── Design tokens — the single source of truth for the consistency pass ──────
// Radii: card = outer containers · inner = nested cards/grid cells · control =
// buttons/inputs · chip = small tags · pill = fully rounded badges
const RADIUS = { card: "1rem", inner: "0.625rem", control: "0.6rem", chip: "0.375rem", pill: 999 };

/** Page-level title — one per view (e.g. "Labor", "Projects") */
function pageTitle(th, extra = {}) {
  return { fontFamily: "'Raleway'", fontWeight: 900, fontSize: "1.4rem", color: th.text, letterSpacing: -0.5, ...extra };
}
/** Card/section header — titles inside cards ("Store Breakdown", "Open Tickets") */
function sectionTitle(th, extra = {}) {
  return { fontFamily: "'Raleway'", fontWeight: 800, fontSize: "0.95rem", color: th.text, ...extra };
}
/** Uppercase micro-label — KPI captions, table headers, eyebrow text */
function microLabel(th, extra = {}) {
  return { fontSize: "0.68rem", color: th.muted, textTransform: "uppercase", letterSpacing: 0.8, fontWeight: 700, ...extra };
}
/** Table header cell */
function thCell(th, extra = {}) {
  return { padding: "0.45rem 0.65rem", fontFamily: "'Raleway'", fontWeight: 700, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: 0.8, color: th.muted, whiteSpace: "nowrap", textAlign: "left", ...extra };
}
/** Table data cell */
function tdCell(th, extra = {}) {
  return { padding: "0.5rem 0.65rem", fontSize: "0.78rem", color: th.text, verticalAlign: "middle", ...extra };
}
/** Status pill/badge — pass the accent color */
function pill(color, extra = {}) {
  return { display: "inline-flex", alignItems: "center", gap: "0.25rem", fontSize: "0.65rem", fontWeight: 700, color, background: `${color}18`, border: `1px solid ${color}33`, borderRadius: RADIUS.pill, padding: "0.15rem 0.5rem", whiteSpace: "nowrap", ...extra };
}

function btn(th, extra = {}) {
  return { background: O, color: W, border: "none", borderRadius: RADIUS.control, padding: "0.7rem 1.4rem", cursor: "pointer", fontFamily: "'Source Sans 3'", fontWeight: 600, fontSize: "1rem", transition: "all .15s", ...extra };
}
function inp(th, extra = {}) {
  return { background: th.inputBg, border: "1px solid "+th.inputBorder, borderRadius: "0.6rem", padding: "0.72rem 1rem", color: th.text, fontSize: "1rem", outline: "none", width: "100%", fontFamily: "'Source Sans 3'", ...extra };
}
function card(th, extra = {}) {
  return { background: th.card, borderRadius: "1rem", border: "1px solid "+th.cardBorder, ...extra };
}
function accentCard(th, accentColor, extra = {}) {
  return { background: th.card, borderRadius: "1rem", borderTop: `1px solid ${th.cardBorder}`, borderRight: `1px solid ${th.cardBorder}`, borderBottom: `1px solid ${th.cardBorder}`, borderLeft: `3px solid ${accentColor}`, ...extra };
}

export { BRAND_CONFIG, O, Od, W, DARK, LIGHT, getTheme, btn, inp, card, accentCard, RADIUS, pageTitle, sectionTitle, microLabel, thCell, tdCell, pill };
