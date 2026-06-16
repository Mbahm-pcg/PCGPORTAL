// competitor.js — Roadmap 10.5 Competitive Intelligence (server-side, Orion).
// Detects nearby competitor openings/closings via Google Places, logs events,
// runs ImpactRadar-style before/after sales analysis as post-event data accrues,
// and emails Exec + the affected store's DM (or a test inbox while validating).
//
// No UI tab — all output is the event log blob (competitor/events_v1) + email.
const https = require('https');
const { STORES } = require('./analyst-data');
const { STORE_COORDS } = require('./store-coords');
const { cacheLoad, cacheSave, cacheList } = require('./analyst-cache');
const { sendEmail, wrapEmail, loadReportSettings } = require('./analyst-reports');
const { haversineMiles, beforeAfter, pickControls } = require('./impact-math');
const { callClaudeWithWebSearch } = require('./analyst-claude');

const PROMOS_KEY = 'competitor/promos_v1';
// Known competitor brands we can meaningfully research promotions for (national/regional
// chains with published deals). Generic independent cafes are skipped for promo research.
const BRAND_PATTERNS = [
  ['Starbucks', /starbucks/i],
  ['Wawa', /wawa/i],
  ["McDonald's", /mc\s?donald/i],
  ['7-Eleven', /7-?eleven/i],
  ['Sheetz', /sheetz/i],
  ['Royal Farms', /royal\s?farm/i],
  ['Saxbys', /saxby/i],
  ['Tim Hortons', /tim\s?horton/i],
  ['Krispy Kreme', /krispy\s?kreme/i],
  ['Panera', /panera/i],
  ['Honeygrow', /honeygrow/i],
  ['QuickChek', /quick\s?chek/i],
];
const brandOf = (name) => { for (const [b, re] of BRAND_PATTERNS) if (re.test(name || '')) return b; return null; };
const promoKey = (p) => `${p.brand}|${p.offer}`.toLowerCase().replace(/\s+/g, ' ').trim();

const EVENTS_KEY = 'competitor/events_v1';
const SNAP_KEY = (pc) => `competitor/snap_${pc}`;

// Competitor types relevant to a Dunkin' (coffee + bakery/donut). Google Places v1 types.
const COMPETITOR_TYPES = ['coffee_shop', 'cafe', 'bakery'];
// Our own brand — never flag ourselves or a sister Baskin as a "competitor".
const OWN_BRAND = /dunkin|baskin/i;

function defaultSettings() {
  return {
    enabled: true,
    testMode: true,                              // route ALL email to testEmails while validating
    testEmails: ['ahmed@peoplecapitalgroup.com', 'mike@peoplecapitalgroup.com'],
    radiusMeters: 1600,                          // ~1 mile trade area
    weeksBefore: 8,
    minWeeksAfter: 3,                            // need this many post-event weeks before first analyzing
    weeksAfterCap: 8,                            // keep refreshing impact until this many post-event weeks, then finalize
    promosEnabled: true,
    emailOnlyWhenNew: false,                     // weekly cadence → send the digest every run; set true to suppress quiet weeks
  };
}
async function loadSettings() {
  const s = await cacheLoad('analyst/competitor-settings');
  return { ...defaultSettings(), ...(s || {}) };
}

// ── Google Places: Nearby Search (POST, Places API v1) ───────────────────────
function placesNearby({ lat, lng, radiusMeters }) {
  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) return Promise.reject(new Error('GOOGLE_PLACES_API_KEY not set'));
  const body = JSON.stringify({
    includedTypes: COMPETITOR_TYPES,
    maxResultCount: 20,
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusMeters } },
  });
  const fieldMask = 'places.id,places.displayName,places.primaryType,places.location,places.businessStatus,places.userRatingCount,places.rating';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'places.googleapis.com', port: 443, path: '/v1/places:searchNearby', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': fieldMask,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => {
        try { resolve(JSON.parse(raw || '{}')); }
        catch { reject(new Error('Invalid JSON from Places')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Places timeout')); });
    req.write(body);
    req.end();
  });
}

// One store's current competitor snapshot.
async function snapshotStore(store, radiusMeters) {
  const coords = STORE_COORDS[store.pc];
  if (!coords) return null;
  const data = await placesNearby({ lat: coords.lat, lng: coords.lng, radiusMeters });
  const places = Array.isArray(data.places) ? data.places : [];
  return places
    .map((p) => {
      const name = p.displayName?.text || '';
      const loc = p.location ? { lat: p.location.latitude, lng: p.location.longitude } : null;
      return {
        placeId: p.id,
        name,
        type: p.primaryType || '',
        businessStatus: p.businessStatus || 'OPERATIONAL',
        ratingCount: p.userRatingCount || 0,
        rating: p.rating || 0,
        distanceMi: loc ? Math.round(haversineMiles(coords, loc) * 100) / 100 : null,
      };
    })
    .filter((c) => c.placeId && c.name && !OWN_BRAND.test(c.name));
}

// Diff a prior snapshot vs current → opening/closing candidate events.
// Conservative to limit false positives:
//   open  = a place present now but absent in the prior snapshot (and OPERATIONAL)
//   close = a place present in both, now flagged CLOSED_* by Google
// (Places dropping out of results is NOT treated as a closing — too noisy.)
function diffSnapshots(prev, curr) {
  const events = [];
  const prevById = new Map((prev || []).map((c) => [c.placeId, c]));
  for (const c of curr) {
    if (!prevById.has(c.placeId) && c.businessStatus === 'OPERATIONAL') {
      events.push({ ...c, eventType: 'open' });
    }
  }
  for (const c of curr) {
    const before = prevById.get(c.placeId);
    if (before && before.businessStatus === 'OPERATIONAL' && /CLOSED/.test(c.businessStatus)) {
      events.push({ ...c, eventType: 'close' });
    }
  }
  return events;
}

// ── Detection pass across all stores with coordinates ────────────────────────
async function runDetection(today, settings) {
  const newEvents = [];
  const log = (await cacheLoad(EVENTS_KEY)) || [];
  const existingIds = new Set(log.map((e) => e.id));

  for (const store of STORES) {
    if (!STORE_COORDS[store.pc]) continue;
    let curr;
    try { curr = await snapshotStore(store, settings.radiusMeters); }
    catch (e) { console.warn(`[competitor] snapshot failed ${store.pc}:`, e.message); continue; }
    if (!curr) continue;

    const prevWrap = await cacheLoad(SNAP_KEY(store.pc));
    const prev = prevWrap?.items || null;
    // First run for this store: baseline only, emit nothing (avoids flagging the whole map as "new").
    if (prev) {
      for (const ev of diffSnapshots(prev, curr)) {
        const id = `${store.pc}_${ev.placeId}_${ev.eventType}`;
        if (existingIds.has(id)) continue;
        const event = {
          id, pc: store.pc, storeName: store.name, district: store.district,
          competitor: ev.name, type: ev.type, eventType: ev.eventType,
          distanceMi: ev.distanceMi, ratingCount: ev.ratingCount, rating: ev.rating,
          detectedDate: today, status: 'monitoring', impact: null, analyzedAt: null,
        };
        log.push(event);
        newEvents.push(event);
        existingIds.add(id);
      }
    }
    await cacheSave(SNAP_KEY(store.pc), { asOf: today, items: curr });
  }
  await cacheSave(EVENTS_KEY, log);
  return { newEvents, log };
}

// Normalize a store's weekly labor blob into {weekOf, sales}[] for the impact math.
function weeklyFromLaborBlob(blob) {
  const weekly = Array.isArray(blob?.weekly) ? blob.weekly : [];
  return weekly
    .map((w) => ({ weekOf: w.weekOf || w.weekStart || null, sales: Number(w.sales) }))
    .filter((w) => w.weekOf && Number.isFinite(w.sales) && w.sales > 0);
}

// ── Impact analysis ──────────────────────────────────────────────────────────
// Analyzes events that have enough post-event data, and KEEPS refreshing each
// event's impact every run (as more post-event weeks accrue) until the window
// reaches `weeksAfterCap`, at which point it's marked 'final' and left alone.
// Returns the events whose figure is new or changed this run (for the email).
async function analyzeEvents(log, settings) {
  const updated = [];
  const cap = settings.weeksAfterCap ?? 8;
  const ripe = log.filter((e) =>
    e.status === 'monitoring' ||
    (e.status === 'analyzed' && (e.impact?.weeksAfterUsed ?? 0) < cap));
  for (const ev of ripe) {
    const coords = STORE_COORDS[ev.pc];
    if (!coords) continue;
    const storeBlob = await cacheLoad(`pcg_labor_store_${ev.pc}`);
    const storeWeekly = weeklyFromLaborBlob(storeBlob);
    const ba = beforeAfter(storeWeekly, ev.detectedDate, settings.weeksBefore, null);
    if (ba.weeksAfterUsed < settings.minWeeksAfter || ba.weeksBeforeUsed === 0) continue; // not ready

    // Control stores: nearest/mid/farthest peers by distance from the affected store.
    const ranked = STORES
      .filter((s) => STORE_COORDS[s.pc] && s.pc !== ev.pc)
      .map((s) => ({ pc: s.pc, distance: haversineMiles(coords, STORE_COORDS[s.pc]) }))
      .sort((a, b) => a.distance - b.distance);
    const controls = pickControls(ranked, ev.pc, 3);
    const controlDeltas = [];
    for (const c of controls) {
      const cBlob = await cacheLoad(`pcg_labor_store_${c.pc}`);
      const cba = beforeAfter(weeklyFromLaborBlob(cBlob), ev.detectedDate, settings.weeksBefore, null);
      if (cba.weeksAfterUsed > 0 && cba.weeksBeforeUsed > 0) controlDeltas.push(cba.deltaPct);
    }
    const controlAvgDeltaPct = controlDeltas.length ? controlDeltas.reduce((s, x) => s + x, 0) / controlDeltas.length : 0;
    const adjustedDeltaPct = Math.round((ba.deltaPct - controlAvgDeltaPct) * 100) / 100;
    // Annualized $ impact attributable to the event = control-adjusted weekly change × 52.
    const adjustedAnnual = Math.round((ba.avgBefore * (adjustedDeltaPct / 100)) * 52);

    const prev = ev.impact;
    ev.impact = {
      avgBefore: ba.avgBefore, avgAfter: ba.avgAfter, storeDeltaPct: ba.deltaPct,
      controlAvgDeltaPct: Math.round(controlAvgDeltaPct * 100) / 100, adjustedDeltaPct,
      adjustedAnnual, weeksBeforeUsed: ba.weeksBeforeUsed, weeksAfterUsed: ba.weeksAfterUsed,
      controls: controls.map((c) => c.pc),
    };
    ev.analyzedAt = new Date().toISOString();
    // Finalize once the post-event window matures; otherwise keep it open to refine.
    ev.status = ba.weeksAfterUsed >= cap ? 'final' : 'analyzed';
    // Email on first analysis or whenever the figure actually moved.
    const changed = !prev || prev.adjustedAnnual !== ev.impact.adjustedAnnual || prev.weeksAfterUsed !== ev.impact.weeksAfterUsed;
    if (changed) updated.push(ev);
  }
  if (updated.length) await cacheSave(EVENTS_KEY, log);
  return updated;
}

// ── Competitor promotions (web-search) ──────────────────────────────────────
// Which known brands actually appear in our stored Places snapshots — so we only
// research promos for chains that are genuinely near our stores.
async function deriveBrands() {
  const keys = await cacheList('competitor/snap_');
  const counts = {};
  for (const k of keys) {
    const wrap = await cacheLoad(k);
    for (const item of (wrap?.items || [])) {
      const b = brandOf(item.name);
      if (b) counts[b] = (counts[b] || 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([b]) => b);
}

// Ask Claude (with web search) for current/upcoming deals for the given brands.
// Returns marked promos ({brand, offer, ends, source, isNew}). Throws are caught upstream.
async function fetchPromos(brands, today) {
  if (!brands.length) return [];
  const list = brands.join(', ');
  const prompt = `Research current and upcoming limited-time offers, app/loyalty deals, and promotions for these coffee & QSR brands in the Philadelphia / PA-NJ area as of ${today}: ${list}.
Focus on deals a Dunkin' operator would care about (coffee, espresso, breakfast sandwiches, app/rewards offers, BOGO, value menus).
After researching, output ONLY a JSON array (no surrounding prose) where each element is {"brand","offer","ends","source"}:
- "offer": short description of the deal
- "ends": end date if known, else "ongoing" or "unknown"
- "source": the URL you found it on
Only include deals you found actual evidence for.`;
  const { text } = await callClaudeWithWebSearch({
    system: 'You are a competitive-intelligence researcher for a Dunkin\' franchise operator. Be precise; only report promotions you find real evidence for, and always include the source URL.',
    userPrompt: prompt, maxUses: 6, maxTokens: 2800, userId: 'system',
  });
  let promos = [];
  try { const m = text.match(/\[[\s\S]*\]/); if (m) promos = JSON.parse(m[0]); } catch { promos = []; }
  promos = Array.isArray(promos) ? promos.filter((p) => p && p.brand && p.offer) : [];

  const prevWrap = await cacheLoad(PROMOS_KEY);
  const prevKeys = new Set((prevWrap?.promos || []).map(promoKey));
  const marked = promos.map((p) => ({ ...p, isNew: !prevKeys.has(promoKey(p)) }));
  await cacheSave(PROMOS_KEY, { week: today, promos });
  return marked;
}

// ── Email composition ────────────────────────────────────────────────────────
const fmt$ = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
const labelType = (t) => (t || 'business').replace(/_/g, ' ');
// HTML-escape any external/AI-sourced string before interpolating it into the email
// body. Competitor names (Google Places) and promo fields (Claude web search) are
// partially untrusted, so everything user/external-facing must be escaped.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// Only emit a link when the URL is a well-formed http(s) URL; returns an escaped,
// safe href or '' (blocks javascript:/data: schemes and attribute breakout).
const safeHref = (u) => {
  try { const url = new URL(String(u)); return (url.protocol === 'http:' || url.protocol === 'https:') ? esc(url.href) : ''; }
  catch { return ''; }
};

function eventRow(ev) {
  const verb = ev.eventType === 'open' ? 'opened' : 'closed';
  const head = `<strong>${esc(ev.competitor)}</strong> (${esc(labelType(ev.type))}) ${verb} ~${esc(ev.distanceMi ?? '?')} mi from <strong>${esc(ev.storeName)}</strong> (PC ${esc(ev.pc)}, District ${esc(ev.district)})`;
  let impactHtml = `<div style="color:#888;font-size:13px;margin-top:4px;">Detected ${ev.detectedDate} · auto-detected candidate — please verify. Impact analysis pending (${'monitoring'}).</div>`;
  if (ev.impact) {
    const i = ev.impact;
    const dir = i.adjustedDeltaPct < 0 ? 'down' : 'up';
    impactHtml = `<div style="font-size:13px;margin-top:6px;line-height:1.5;">
      Sales <strong style="color:${i.adjustedDeltaPct < 0 ? '#c0392b' : '#27ae60'}">${i.adjustedDeltaPct}%</strong> ${dir} vs the ${i.weeksBeforeUsed}-wk pre-event baseline
      (store ${i.storeDeltaPct}% vs control stores ${i.controlAvgDeltaPct}% — control-adjusted).<br/>
      Est. annualized impact: <strong>${fmt$(i.adjustedAnnual)}</strong> over ${i.weeksAfterUsed} post-event weeks. Controls: ${i.controls.join(', ')}.
    </div>`;
  }
  return `<li style="margin-bottom:14px;">${head}${impactHtml}</li>`;
}

function promoSection(promos) {
  if (!promos || !promos.length) return '';
  // New deals first, then the rest.
  const ordered = [...promos].sort((a, b) => (b.isNew ? 1 : 0) - (a.isNew ? 1 : 0));
  const rows = ordered.map((p) => {
    const tag = p.isNew ? ' <span style="color:#fff;background:#27ae60;font-size:11px;padding:1px 6px;border-radius:8px;">NEW</span>' : '';
    const ends = p.ends && !/unknown|ongoing/i.test(p.ends) ? ` <span style="color:#888;">(ends ${esc(p.ends)})</span>` : (p.ends && /ongoing/i.test(p.ends) ? ' <span style="color:#888;">(ongoing)</span>' : '');
    const href = safeHref(p.source);
    const src = href ? ` <a href="${href}" style="color:#888;font-size:12px;">source</a>` : '';
    return `<li style="margin-bottom:8px;"><strong>${esc(p.brand)}:</strong> ${esc(p.offer)}${ends}${tag}${src}</li>`;
  }).join('');
  return `<h3 style="margin:18px 0 8px;">🎯 Competitor promotions (${promos.length})</h3><ul style="padding-left:18px;margin:0 0 6px;">${rows}</ul><div style="color:#888;font-size:12px;">AI-gathered via web search — verify before acting.</div>`;
}

function buildEmailHtml(newEvents, analyzed, promos) {
  const parts = [];
  if (newEvents.length) {
    parts.push(`<h3 style="margin:0 0 8px;">🆕 New competitor activity (${newEvents.length})</h3><ul style="padding-left:18px;margin:0 0 18px;">${newEvents.map(eventRow).join('')}</ul>`);
  }
  if (analyzed.length) {
    parts.push(`<h3 style="margin:0 0 8px;">📊 Impact analysis — new / updated (${analyzed.length})</h3><ul style="padding-left:18px;margin:0 0 18px;">${analyzed.map(eventRow).join('')}</ul>`);
  }
  parts.push(promoSection(promos));
  return parts.join('');
}

// Resolve recipients. testMode → single test inbox. Otherwise Exec list + the
// affected districts' DMs (from the portal users blob, with a graceful fallback).
async function resolveRecipients(events, settings) {
  if (settings.testMode) {
    // Accept either testEmails (array) or a legacy testEmail (string).
    const test = Array.isArray(settings.testEmails) ? settings.testEmails : (settings.testEmail ? [settings.testEmail] : []);
    return { to: [...new Set(test.filter(Boolean))], cc: [] };
  }
  const report = await loadReportSettings();
  const exec = Array.isArray(report.execReportCC) ? report.execReportCC : [];
  const users = (await cacheLoad('pcg_portal_users')) || [];
  const districts = [...new Set(events.map((e) => Number(e.district)).filter(Boolean))];
  const dmEmails = [];
  for (const d of districts) {
    const dm = (Array.isArray(users) ? users : []).find((u) => u.userType === 'dm' && Number(u.district) === d && u.active && u.email);
    if (dm?.email) dmEmails.push(dm.email);
  }
  const to = [...new Set([...exec, ...dmEmails])].filter(Boolean);
  return { to: to.length ? to : exec, cc: [] };
}

// ── Orchestrator (called from analyst-cron) ──────────────────────────────────
async function runCompetitorIntel({ today, doDetection }) {
  const settings = await loadSettings();
  if (!settings.enabled) return { skipped: 'disabled' };

  let newEvents = [];
  let log;
  if (doDetection) {
    const res = await runDetection(today, settings);
    newEvents = res.newEvents;
    log = res.log;
  } else {
    log = (await cacheLoad(EVENTS_KEY)) || [];
  }

  const analyzed = await analyzeEvents(log, settings);

  // Competitor promotions (web-search) — refreshed on the weekly detection run.
  let promos = [];
  if (doDetection && settings.promosEnabled !== false) {
    try {
      const brands = await deriveBrands();
      promos = await fetchPromos(brands, today);
    } catch (e) {
      console.warn('[competitor] promo fetch failed (web search may be unavailable):', e.message);
    }
  }

  // emailOnlyWhenNew:true suppresses quiet runs (email only on a new opening/closing,
  // a new/updated impact analysis, or a newly-detected promo). Default false → send the
  // full weekly digest every run.
  const newPromos = promos.filter((p) => p.isNew).length;
  const hasNews = newEvents.length || analyzed.length || newPromos;
  const shouldEmail = settings.emailOnlyWhenNew === false ? (newEvents.length || analyzed.length || promos.length) : hasNews;

  let emailed = false;
  if (shouldEmail) {
    const { to, cc } = await resolveRecipients([...newEvents, ...analyzed], settings);
    if (to.length) {
      const subject = `🏪 Competitor Intel — ${newEvents.length} new, ${analyzed.length} analyzed, ${promos.length} promos (${today})`;
      const html = wrapEmail(
        'Competitive Intelligence',
        `${newEvents.length} new event(s) · ${analyzed.length} impact update(s) · ${promos.length} promo(s)${newPromos ? ` (${newPromos} new)` : ''}`,
        buildEmailHtml(newEvents, analyzed, promos),
        settings.testMode ? 'TEST MODE — routed to test inbox. Auto-detected events & promos are candidates; verify before acting.' : 'Auto-detected events & promos are candidates; verify before acting.',
      );
      await sendEmail({ to, cc, subject, html });
      emailed = true;
    }
  }
  return { newEvents: newEvents.length, analyzed: analyzed.length, promos: promos.length, emailed, testMode: settings.testMode };
}

module.exports = { runCompetitorIntel, runDetection, analyzeEvents, snapshotStore, diffSnapshots, deriveBrands, fetchPromos, buildEmailHtml };
