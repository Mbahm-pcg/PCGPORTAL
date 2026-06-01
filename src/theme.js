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

function btn(th, extra = {}) {
  return { background: O, color: W, border: "none", borderRadius: "0.6rem", padding: "0.7rem 1.4rem", cursor: "pointer", fontFamily: "'Source Sans 3'", fontWeight: 600, fontSize: "1rem", transition: "all .15s", ...extra };
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

export { BRAND_CONFIG, O, Od, W, DARK, LIGHT, getTheme, btn, inp, card, accentCard };
