// competitor.js — Roadmap 10.5 Competitive Intelligence (server-side, Orion).
// Detects nearby competitor openings/closings via Google Places, logs events,
// runs ImpactRadar-style before/after sales analysis as post-event data accrues,
// and emails Exec + the affected store's DM (or a test inbox while validating).
//
// No UI tab — all output is the event log blob (competitor/events_v1) + email.
import https from 'node:https';
import { STORES } from './analyst-data.mjs';
import { STORE_COORDS } from './store-coords.mjs';
import { cacheLoad, cacheSave, cacheList } from './analyst-cache.mjs';
import { sendEmail, wrapEmail, loadReportSettings } from './analyst-reports.mjs';
import { haversineMiles, beforeAfter, pickControls } from './impact-math.mjs';
import { callClaudeWithWebSearch } from './analyst-claude.mjs';
import { saveReport } from './analyst-reports-gen.mjs';
import { createCaseFromAnomaly } from './analyst-cases.mjs';
import { weekStart as weekOfMonday } from '../labor-cron.mjs';

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
const DM_SNAP_KEY = (pc) => `competitor/dm_snap_${pc}`; // wider-radius snapshot, separate from the exec trade-area one
const MARKET_SHARE_KEY = 'competitor/market_share_v1';
const METERS_PER_MILE = 1609.34;

// Competitor type → the sales-mix category group(s) it plausibly competes with
// (group names match classifyItem()/pcg_item_history_{pc}.categories keys).
const TYPE_TO_CATEGORY = {
  coffee_shop: ['hot_beverages', 'cold_beverages'],
  cafe: ['hot_beverages', 'cold_beverages'],
  bakery: ['bakery'],
};

// Competitor types relevant to a Dunkin' (coffee + bakery/donut). Google Places v1 types.
const COMPETITOR_TYPES = ['coffee_shop', 'cafe', 'bakery'];
// Our own brand — never flag ourselves or a sister Baskin as a "competitor".
const OWN_BRAND = /dunkin|baskin/i;

function defaultSettings() {
  return {
    enabled: true,
    testMode: true,                              // route ALL email to testEmails while validating
    testEmails: ['ahmed@peoplecapitalgroup.com', 'mike@peoplecapitalgroup.com'],
    radiusMeters: 1600,                          // ~1 mile trade area (exec digest)
    weeksBefore: 8,
    minWeeksAfter: 3,                            // need this many post-event weeks before first analyzing
    weeksAfterCap: 8,                            // keep refreshing impact until this many post-event weeks, then finalize
    promosEnabled: true,
    independentPromoCap: 5,                      // max per-run web-search lookups for non-branded (local/independent) new competitors
    marketShareEnabled: true,                    // estimate local market share from Places review data (10.5 bullet 3)
    emailOnlyWhenNew: false,                     // weekly cadence → send the digest every run; set true to suppress quiet weeks
    driveTimeEnabled: true,                      // attach real drive-time (not just straight-line) to newly-detected events
    caseThreshold: 5000,                         // |adjustedAnnual| $ that files a Business Case for follow-up
    // ── DM digest — separate, wider-radius, district-scoped email (not the exec one) ──
    dmDigestEnabled: true,
    dmRadiusMeters: Math.round(5 * METERS_PER_MILE), // 5 miles — DMs want the broader territory view
    dmTestMode: true,                             // validate DM-formatted emails before they go to real DMs
    dmTestEmails: ['ahmed@peoplecapitalgroup.com', 'mike@peoplecapitalgroup.com'],
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
        lat: loc?.lat ?? null, lng: loc?.lng ?? null,
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

// Real driving distance/time via the portal's own drive-time function (OSRM-backed,
// no API key). Only ever called for the small number of newly-detected events, never
// per-place-per-store, to keep this cheap. Fails soft (returns null) — the caller falls
// back to the straight-line haversine distance already computed.
const SITE_BASE_URL = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://pcg-ops.netlify.app';
async function driveTimeMiles(from, to) {
  try {
    const res = await fetch(`${SITE_BASE_URL}/.netlify/functions/drive-time`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.error || typeof data.minutes !== 'number') return null;
    return { miles: data.miles, minutes: data.minutes };
  } catch { return null; }
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
          driveMinutes: null, driveMiles: null,
        };
        // Real drive-time for the handful of brand-new events (never for the whole sweep).
        if (settings.driveTimeEnabled !== false && ev.lat != null && ev.lng != null) {
          const dt = await driveTimeMiles(STORE_COORDS[store.pc], { lat: ev.lat, lng: ev.lng });
          if (dt) { event.driveMinutes = dt.minutes; event.driveMiles = dt.miles; }
        }
        log.push(event);
        newEvents.push(event);
        existingIds.add(id);
      }
    }
    // Rolling competitor-density history (date + count), capped ~1yr of weekly runs, so
    // "competitor pressure" can be reported as a trend, not just this week's snapshot.
    const history = [...(Array.isArray(prevWrap?.history) ? prevWrap.history : []), { date: today, count: curr.length }].slice(-52);
    await cacheSave(SNAP_KEY(store.pc), { asOf: today, items: curr, history });
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

// weekOfMonday = labor-cron.mjs's weekStart(), imported above — same Monday-rollback
// convention, so the guest-count series lines up with the $ sales weekOf keys used by
// beforeAfter() without maintaining a second copy of the same date math.

// Best-effort weekly GUEST COUNT series from the daily hourly-history blob (guests aren't
// in the weekly labor blob at all). Lets impact analysis say whether a competitor cost
// traffic (fewer guests) vs. ticket size (same guests, less spend) — reuses beforeAfter()
// by relabeling the guest total as its "sales" field (that function only reads .sales).
function weeklyGuestsFromHourlyHistory(blob) {
  const days = Array.isArray(blob) ? blob : [];
  const byWeek = new Map();
  for (const d of days) {
    if (!d?.date || !Array.isArray(d.hours)) continue;
    const checks = d.hours.reduce((s, h) => s + (Number(h?.checks) || 0), 0);
    if (!checks) continue;
    const wk = weekOfMonday(d.date);
    byWeek.set(wk, (byWeek.get(wk) || 0) + checks);
  }
  return [...byWeek.entries()].map(([weekOf, sales]) => ({ weekOf, sales }));
}

// Best-effort sales-mix category cross-reference: is the competitor's own category (coffee,
// bakery) hit harder than the store's overall sales? Directional only — pcg_item_history_{pc}
// retains just 90 days, so this silently returns null once an event is older than that.
async function categoryImpactNote(pc, competitorType, eventDate, weeksBefore, weeksAfterUsed) {
  const categories = TYPE_TO_CATEGORY[competitorType];
  if (!categories || !weeksAfterUsed) return null;
  const history = await cacheLoad(`pcg_item_history_${pc}`);
  if (!Array.isArray(history) || !history.length) return null;

  const sum = (e) => categories.reduce((s, c) => s + (Number(e?.categories?.[c]?.sales) || 0), 0);
  // `history` is newest-first. For "before" that's already right — filtering to <=eventDate
  // then taking the first N gives the N days closest to (and before) the event. For "after"
  // the filtered subset is STILL newest-first, so slice(0,N) would grab the N most-recent
  // calendar days (closest to today) rather than the N days right after the event — wrong
  // once an event is more than a few weeks old. slice(-N) takes the tail of that descending
  // subset, i.e. the oldest entries within it — the days immediately following the event.
  const before = history.filter((e) => e?.date && e.date <= eventDate).slice(0, weeksBefore * 7).map(sum).filter((v) => v > 0);
  const after = history.filter((e) => e?.date && e.date > eventDate).slice(-(weeksAfterUsed * 7)).map(sum).filter((v) => v > 0);
  if (before.length < 5 || after.length < 5) return null; // not enough same-window coverage to be meaningful

  const avgBefore = before.reduce((a, b) => a + b, 0) / before.length;
  const avgAfter = after.reduce((a, b) => a + b, 0) / after.length;
  if (avgBefore <= 0) return null;
  const deltaPct = Math.round(((avgAfter - avgBefore) / avgBefore) * 1000) / 10;
  return { category: categories.join('/'), deltaPct };
}

// ── Impact analysis ──────────────────────────────────────────────────────────
// Analyzes events that have enough post-event data, and KEEPS refreshing each
// event's impact every run (as more post-event weeks accrue) until the window
// reaches `weeksAfterCap`, at which point it's marked 'final' and left alone.
// Returns the events whose figure is new or changed this run (for the email).
async function analyzeEvents(log, settings) {
  const updated = [];
  let caseFiledThisRun = false; // must independently force the log save below — see the case-filing block
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

    // Traffic vs. ticket-size split — best-effort, from the daily hourly-history blob
    // (guests aren't in the weekly labor blob). Tells a DM whether the hit is fewer
    // visits or smaller tickets, not just a blended $ delta.
    let guests = null;
    try {
      const hourlyBlob = await cacheLoad(`pcg_hourly_history_${ev.pc}`);
      const guestWeekly = weeklyGuestsFromHourlyHistory(hourlyBlob);
      const gba = beforeAfter(guestWeekly, ev.detectedDate, settings.weeksBefore, null);
      if (gba.weeksBeforeUsed > 0 && gba.weeksAfterUsed > 0) {
        guests = { avgBefore: gba.avgBefore, avgAfter: gba.avgAfter, deltaPct: gba.deltaPct };
      }
    } catch (e) { console.warn(`[competitor] guest delta failed ${ev.pc}:`, e.message); }

    // Sales-mix cross-reference — is the competitor's own category (coffee/bakery) hit
    // harder than the store overall? Silently null once outside the 90-day item-history window.
    let categoryNote = null;
    try { categoryNote = await categoryImpactNote(ev.pc, ev.type, ev.detectedDate, settings.weeksBefore, ba.weeksAfterUsed); }
    catch (e) { console.warn(`[competitor] category cross-ref failed ${ev.pc}:`, e.message); }

    const prev = ev.impact;
    ev.impact = {
      avgBefore: ba.avgBefore, avgAfter: ba.avgAfter, storeDeltaPct: ba.deltaPct,
      controlAvgDeltaPct: Math.round(controlAvgDeltaPct * 100) / 100, adjustedDeltaPct,
      adjustedAnnual, weeksBeforeUsed: ba.weeksBeforeUsed, weeksAfterUsed: ba.weeksAfterUsed,
      controls: controls.map((c) => c.pc), guests, categoryNote,
    };
    ev.analyzedAt = new Date().toISOString();
    // Finalize once the post-event window matures; otherwise keep it open to refine.
    ev.status = ba.weeksAfterUsed >= cap ? 'final' : 'analyzed';
    // Email on first analysis or whenever the figure actually moved.
    const changed = !prev || prev.adjustedAnnual !== ev.impact.adjustedAnnual || prev.weeksAfterUsed !== ev.impact.weeksAfterUsed;
    if (changed) updated.push(ev);

    // File a Business Case once a material impact first crosses the threshold — not on
    // every subsequent refinement (would spam duplicate follow-ups as the estimate matures).
    const threshold = settings.caseThreshold ?? 5000;
    if (!ev.caseFiledAt && Math.abs(adjustedAnnual) >= threshold) {
      try {
        const verb = adjustedAnnual < 0 ? 'pressuring sales down' : 'boosting sales up';
        const anomaly = {
          type: 'competitor_impact',
          description: `${ev.competitor} (${labelType(ev.type)}) ${ev.eventType === 'open' ? 'opened' : 'closed'} ~${ev.distanceMi ?? '?'} mi from ${ev.storeName} — ${verb} by an estimated ${fmt$(Math.abs(adjustedAnnual))}/yr (control-adjusted, ${ba.weeksAfterUsed} wks post-event).`,
          storeName: ev.storeName, storePC: ev.pc, pc: ev.pc, district: ev.district,
          severity: Math.abs(adjustedAnnual) >= threshold * 2 ? 'high' : 'medium',
          metric: 'competitor_sales_impact_annual', value: adjustedAnnual,
        };
        const created = await createCaseFromAnomaly(anomaly, JSON.stringify({ event: ev, impact: ev.impact }));
        // caseFiledAt gates re-filing (line above), so it MUST be persisted this run —
        // `updated`/`changed` above tracks a different thing (whether to email the impact
        // figure) and can be false here (e.g. caseThreshold lowered while impact is otherwise
        // unchanged), which would silently drop this write and cause a duplicate case next run.
        if (created) { ev.caseFiledAt = new Date().toISOString(); caseFiledThisRun = true; }
      } catch (e) { console.warn(`[competitor] case creation failed ${ev.pc}:`, e.message); }
    }
  }
  if (updated.length || caseFiledThisRun) await cacheSave(EVENTS_KEY, log);
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

// Independent/local competitors (a brand-new corner cafe, not a national chain) get ZERO
// coverage from fetchPromos — it only researches the fixed BRAND_PATTERNS list. But those
// are exactly the businesses "New competitor activity" just flagged, so do a small, capped,
// per-competitor web-search lookup for the newest non-branded events only (never for the
// whole historical log — that would be an unbounded number of searches).
async function fetchIndependentPromos(newEvents, today, cap = 5) {
  const independents = newEvents.filter((e) => e.eventType === 'open' && !brandOf(e.competitor)).slice(0, cap);
  if (!independents.length) return [];
  const results = [];
  for (const ev of independents) {
    try {
      const prompt = `A new local business, "${ev.competitor}" (${labelType(ev.type)}), just opened near ${ev.storeName} in the Philadelphia / PA-NJ area, as of ${today}.
Research whether this specific business has any published opening promotions, loyalty program, or notable menu/pricing angle (check its website, Google Business listing, Instagram/Facebook if findable).
Output ONLY a JSON object (no prose): {"offer": "short description, or empty string if nothing found", "source": "URL if found, else empty string"}.
If you find no real evidence of anything, return {"offer":"","source":""}.`;
      const { text } = await callClaudeWithWebSearch({
        system: 'You are a competitive-intelligence researcher for a Dunkin\' franchise operator. Only report what you find real evidence for — an empty result is fine and expected for small local businesses.',
        userPrompt: prompt, maxUses: 4, maxTokens: 1200, userId: 'system',
      });
      let parsed = null;
      try { const m = text.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch { parsed = null; }
      if (parsed?.offer) results.push({ brand: ev.competitor, offer: parsed.offer, ends: 'unknown', source: parsed.source || '', isNew: true, independent: true });
    } catch (e) { console.warn(`[competitor] independent promo lookup failed for ${ev.competitor}:`, e.message); }
  }
  return results;
}

// ── Market share estimation (data proxy) ────────────────────────────────────
// Roadmap 10.5 bullet 3. No survey data exists, so we proxy local demand with
// public Google review signal: a place's "pull" ≈ review volume scaled by its
// star rating (rating/5). Our estimated share within a store's trade area =
// our brand's pull ÷ (our pull + every nearby coffee/café/bakery competitor's
// pull). Directional, not exact — review counts under-represent drive-thru and
// app-order volume, so treat as a relative-pressure signal, not a true %.
const placeProxy = (p) => {
  const rc = Number(p.ratingCount) || 0;
  const r = Number(p.rating) || 0;
  return r > 0 ? rc * (r / 5) : rc; // fall back to raw review count when unrated
};

// One Places call per store (same endpoint detection uses) — but here we KEEP the
// own-brand entries, since our own Dunkin's review pull is the numerator.
async function estimateMarketShare(today, settings) {
  const stores = [];
  let eligible = 0; // stores with coords we attempted to fetch
  for (const store of STORES) {
    const coords = STORE_COORDS[store.pc];
    if (!coords) continue;
    eligible++;
    let data;
    try { data = await placesNearby({ lat: coords.lat, lng: coords.lng, radiusMeters: settings.radiusMeters }); }
    catch (e) { console.warn(`[competitor] market-share places failed ${store.pc}:`, e.message); continue; }
    const places = (Array.isArray(data.places) ? data.places : [])
      .map((p) => ({
        name: p.displayName?.text || '',
        rating: p.rating || 0,
        ratingCount: p.userRatingCount || 0,
        status: p.businessStatus || 'OPERATIONAL',
      }))
      .filter((p) => p.name && p.status === 'OPERATIONAL');

    const own = places.filter((p) => OWN_BRAND.test(p.name));
    const comp = places.filter((p) => !OWN_BRAND.test(p.name));
    const ourProxy = own.reduce((s, p) => s + placeProxy(p), 0);
    const competitorProxy = comp.reduce((s, p) => s + placeProxy(p), 0);
    const denom = ourProxy + competitorProxy;
    // Need our own store visible in Places to estimate a share; otherwise report density only.
    const sharePct = (own.length && denom > 0) ? Math.round((ourProxy / denom) * 1000) / 10 : null;
    const top = comp.slice().sort((a, b) => placeProxy(b) - placeProxy(a))[0] || null;
    stores.push({
      pc: store.pc, storeName: store.name, district: store.district,
      sharePct, competitorCount: comp.length,
      topCompetitor: top ? { name: top.name, rating: top.rating, ratingCount: top.ratingCount } : null,
    });
  }
  const withShare = stores.filter((s) => s.sharePct != null);
  const avgShare = withShare.length
    ? Math.round((withShare.reduce((s, x) => s + x.sharePct, 0) / withShare.length) * 10) / 10 : null;
  const totalCompetitors = stores.reduce((s, x) => s + x.competitorCount, 0);
  // Guard against reporting a "network" average from a thin sample (e.g. an API key /
  // quota failure dropping most stores). Flag low coverage so consumers can caveat it.
  const lowSample = withShare.length < Math.max(3, Math.ceil(eligible * 0.5));
  const result = {
    asOf: today, avgShare, totalCompetitors,
    storesAnalyzed: stores.length, storesWithShare: withShare.length, storesEligible: eligible, lowSample,
    radiusMi: Math.round((settings.radiusMeters / 1609) * 10) / 10, stores,
  };
  await cacheSave(MARKET_SHARE_KEY, result);
  return result;
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
  const driveNote = ev.driveMinutes != null ? ` (~${esc(ev.driveMinutes)} min drive)` : '';
  const head = `<strong>${esc(ev.competitor)}</strong> (${esc(labelType(ev.type))}) ${verb} ~${esc(ev.distanceMi ?? '?')} mi from <strong>${esc(ev.storeName)}</strong> (PC ${esc(ev.pc)}, District ${esc(ev.district)})${driveNote}`;
  let impactHtml = `<div style="color:#888;font-size:13px;margin-top:4px;">Detected ${ev.detectedDate} · auto-detected candidate — please verify. Impact analysis pending (${'monitoring'}).</div>`;
  if (ev.impact) {
    const i = ev.impact;
    const dir = i.adjustedDeltaPct < 0 ? 'down' : 'up';
    let extra = '';
    if (i.guests) {
      const gdir = i.guests.deltaPct < 0 ? 'down' : 'up';
      extra += `<br/>Guest count ${gdir} <strong>${i.guests.deltaPct}%</strong> over the same window — ${Math.abs(i.guests.deltaPct) >= Math.abs(i.storeDeltaPct) ? 'looks like a traffic hit, not just ticket size' : 'traffic held up better than $ sales — likely a ticket-size effect'}.`;
    }
    if (i.categoryNote) {
      const cdir = i.categoryNote.deltaPct < 0 ? 'down' : 'up';
      extra += `<br/><span style="color:#888;">${esc(i.categoryNote.category)} category specifically ${cdir} ${i.categoryNote.deltaPct}% vs its own baseline.</span>`;
    }
    impactHtml = `<div style="font-size:13px;margin-top:6px;line-height:1.5;">
      Sales <strong style="color:${i.adjustedDeltaPct < 0 ? '#c0392b' : '#27ae60'}">${i.adjustedDeltaPct}%</strong> ${dir} vs the ${i.weeksBeforeUsed}-wk pre-event baseline
      (store ${i.storeDeltaPct}% vs control stores ${i.controlAvgDeltaPct}% — control-adjusted).<br/>
      Est. annualized impact: <strong>${fmt$(i.adjustedAnnual)}</strong> over ${i.weeksAfterUsed} post-event weeks. Controls: ${i.controls.join(', ')}.${extra}
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

// Shared selection logic for the two market-share renderers (HTML email + plain-text
// report). Returns the picked stores + flags, or null when there's nothing to say —
// so the single-store case, runner-up filter, and low-sample flag live in ONE place.
function marketShareFacts(ms) {
  if (!ms || !Array.isArray(ms.stores)) return null;
  const withShare = ms.stores.filter((s) => s.sharePct != null);
  if (!withShare.length) return null;
  const asc = withShare.slice().sort((a, b) => a.sharePct - b.sharePct);
  return {
    avg: ms.avgShare, radiusMi: ms.radiusMi, storesAnalyzed: ms.storesAnalyzed,
    totalCompetitors: ms.totalCompetitors, lowSample: !!ms.lowSample,
    worst: asc[0], best: asc[asc.length - 1],
    single: asc.length === 1, // only one store has a share → no worst-vs-best contrast
    runnersUp: asc.slice(1, 3).filter((s) => ms.avgShare == null || s.sharePct < ms.avgShare),
  };
}
const topCompText = (s) => s.topCompetitor
  ? `${s.topCompetitor.name} (${s.topCompetitor.ratingCount} reviews)` : 'a nearby independent';

// Narrative summary of the market-share estimate. Built deterministically from the
// computed figures (no LLM call) so every number in the prose is real — an exec email
// can't risk hallucinated shares. Reads like a short Orion note.
function marketShareSection(ms) {
  const f = marketShareFacts(ms);
  if (!f) return '';
  const compStr = (s) => s.topCompetitor ? `${esc(s.topCompetitor.name)} (${esc(s.topCompetitor.ratingCount)} reviews)` : 'a nearby independent';

  const paras = [];
  paras.push(`Across ${esc(f.storesAnalyzed)} stores, estimated local share averages <strong>~${esc(f.avg)}%</strong> within a ~${esc(f.radiusMi)} mi trade area, against ${esc(f.totalCompetitors)} nearby coffee, café and bakery competitors.`);

  let pressure = `<strong>${esc(f.worst.storeName)}</strong> (District ${esc(f.worst.district)}) is under the most pressure at <strong>~${esc(f.worst.sharePct)}%</strong> share — ${esc(f.worst.competitorCount)} competitors within range, led by ${compStr(f.worst)}.`;
  if (!f.single && f.runnersUp.length) {
    pressure += ` ${f.runnersUp.map((s) => `${esc(s.storeName)} (~${esc(s.sharePct)}%)`).join(' and ')} ${f.runnersUp.length > 1 ? 'are' : 'is'} also below the network average.`;
  }
  paras.push(pressure);

  // Only contrast a best-positioned store when it's a DIFFERENT store from the worst.
  if (!f.single) {
    paras.push(`By contrast, <strong>${esc(f.best.storeName)}</strong> looks best-positioned at <strong>~${esc(f.best.sharePct)}%</strong> with only ${esc(f.best.competitorCount)} competitor${f.best.competitorCount === 1 ? '' : 's'} nearby.`);
  }

  const body = paras.map((p) => `<p style="margin:0 0 8px;line-height:1.55;">${p}</p>`).join('');
  const sampleNote = f.lowSample ? ` Based on partial data (${esc(ms.storesWithShare)} of ${esc(ms.storesEligible)} stores) — interpret with caution.` : '';
  return `<h3 style="margin:18px 0 8px;">📈 Estimated local market share</h3>
    ${body}
    <div style="color:#888;font-size:12px;margin-top:4px;">Estimate from public Google review data (review volume × star rating) — directional, not exact; it under-counts drive-thru and app orders.${sampleNote}</div>`;
}

// Plain-text market-share summary for the portal report's "Orion's Take" / callout
// (the reports UI renders narrative text as plain text, not HTML — so no markup here).
function marketShareNarrativeText(ms) {
  const f = marketShareFacts(ms);
  if (!f) return '';
  const parts = [
    `Estimated local share averages ~${f.avg}% across ${f.storesAnalyzed} stores within a ~${f.radiusMi} mi trade area, against ${f.totalCompetitors} nearby coffee, café and bakery competitors.`,
    `${f.worst.storeName} (District ${f.worst.district}) is under the most pressure at ~${f.worst.sharePct}% — ${f.worst.competitorCount} competitors nearby, led by ${topCompText(f.worst)}.`,
  ];
  if (!f.single) {
    parts.push(`${f.best.storeName} is best-positioned at ~${f.best.sharePct}% with only ${f.best.competitorCount} competitor${f.best.competitorCount === 1 ? '' : 's'} nearby.`);
  }
  if (f.lowSample) parts.push(`(Partial data: ${ms.storesWithShare} of ${ms.storesEligible} stores — interpret with caution.)`);
  return parts.join(' ');
}

// Build a structured Orion report artifact (for the portal Reports tab) from the same
// weekly data the email uses. The reports renderer escapes all values (React), so these
// are plain objects — no HTML. Returns null when there's nothing worth a report.
function buildReportArtifact(newEvents, analyzed, promos, marketShare, today) {
  const hasShare = !!(marketShare && Array.isArray(marketShare.stores) && marketShare.stores.length);
  if (!newEvents.length && !analyzed.length && !promos.length && !hasShare) return null;

  const components = [];
  components.push({ type: 'kpi-grid', data: { items: [
    { label: 'New events', value: String(newEvents.length) },
    { label: 'Impact updates', value: String(analyzed.length) },
    { label: 'Promotions', value: String(promos.length) },
    { label: 'Network share', value: marketShare?.avgShare != null ? `~${marketShare.avgShare}%` : '—' },
  ] } });

  if (newEvents.length) components.push({ type: 'table', data: {
    title: 'New competitor activity',
    columns: [{ key: 'competitor', label: 'Competitor' }, { key: 'event', label: 'Event' }, { key: 'dist', label: 'Distance' }, { key: 'store', label: 'Store' }, { key: 'district', label: 'District' }],
    rows: newEvents.map((ev) => ({
      competitor: ev.competitor, event: ev.eventType === 'open' ? 'Opened' : 'Closed',
      dist: ev.distanceMi != null ? `${ev.distanceMi} mi` : '—', store: ev.storeName, district: `D${ev.district}`,
    })),
  } });

  if (analyzed.length) components.push({ type: 'table', data: {
    title: 'Impact analysis (control-adjusted)',
    columns: [{ key: 'store', label: 'Store' }, { key: 'competitor', label: 'Event' }, { key: 'adj', label: 'Adj Δ%' }, { key: 'annual', label: 'Annualized' }, { key: 'weeks', label: 'Wks after' }],
    rows: analyzed.map((ev) => ({
      store: ev.storeName, competitor: ev.competitor, adj: `${ev.impact.adjustedDeltaPct}%`,
      annual: fmt$(ev.impact.adjustedAnnual), weeks: ev.impact.weeksAfterUsed,
    })),
  } });

  if (promos.length) components.push({ type: 'table', data: {
    title: 'Competitor promotions',
    columns: [{ key: 'brand', label: 'Brand' }, { key: 'offer', label: 'Offer' }, { key: 'ends', label: 'Ends' }],
    rows: promos.map((p) => ({ brand: `${p.brand}${p.isNew ? ' ● NEW' : ''}`, offer: p.offer, ends: p.ends || '—' })),
  } });

  const msText = marketShareNarrativeText(marketShare);
  if (msText) components.push({ type: 'narrative', data: { style: 'callout', text: `Estimated local market share — ${msText}` } });

  const headline = `Orion's weekly competitive scan: ${newEvents.length} new competitor event(s), ${analyzed.length} impact update(s), and ${promos.length} active promotion(s) across the network${marketShare?.avgShare != null ? `. Estimated network market share ~${marketShare.avgShare}%.` : '.'} Auto-detected — verify before acting.`;

  return {
    type: 'brief',
    title: `Competitive Intelligence — ${today}`,
    scope: 'network',
    createdBy: 'orion',
    trigger: 'scheduled',
    narrative: headline,
    components,
  };
}

function buildEmailHtml(newEvents, analyzed, promos, marketShare) {
  const parts = [];
  if (newEvents.length) {
    parts.push(`<h3 style="margin:0 0 8px;">🆕 New competitor activity (${newEvents.length})</h3><ul style="padding-left:18px;margin:0 0 18px;">${newEvents.map(eventRow).join('')}</ul>`);
  }
  if (analyzed.length) {
    parts.push(`<h3 style="margin:0 0 8px;">📊 Impact analysis — new / updated (${analyzed.length})</h3><ul style="padding-left:18px;margin:0 0 18px;">${analyzed.map(eventRow).join('')}</ul>`);
  }
  parts.push(promoSection(promos));
  parts.push(marketShareSection(marketShare));
  return parts.join('');
}

// Resolve recipients. testMode → single test inbox. Otherwise Exec list + the
// affected districts' DMs (from the portal users blob, with a graceful fallback).
// `users` may be pre-loaded by the caller (runCompetitorIntel loads it once and shares
// it with runDmDigests) to avoid fetching the same blob twice in one run.
async function resolveRecipients(events, settings, users = null) {
  if (settings.testMode) {
    // Accept either testEmails (array) or a legacy testEmail (string).
    const test = Array.isArray(settings.testEmails) ? settings.testEmails : (settings.testEmail ? [settings.testEmail] : []);
    return { to: [...new Set(test.filter(Boolean))], cc: [] };
  }
  const report = await loadReportSettings();
  const exec = Array.isArray(report.execReportCC) ? report.execReportCC : [];
  if (!users) users = (await cacheLoad('pcg_portal_users')) || [];
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

  // Loaded once and shared with resolveRecipients + runDmDigests below, rather than
  // each independently re-fetching the same portal-users blob.
  const portalUsers = (await cacheLoad('pcg_portal_users')) || [];

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
    // Independent/local competitors (not in the fixed brand list) — capped, per new event only.
    try {
      const indie = await fetchIndependentPromos(newEvents, today, settings.independentPromoCap ?? 5);
      if (indie.length) promos = [...promos, ...indie];
    } catch (e) {
      console.warn('[competitor] independent promo fetch failed:', e.message);
    }
  }

  // Market share estimation (Places review-data proxy) — refreshed on the weekly detection run.
  let marketShare = null;
  if (doDetection && settings.marketShareEnabled !== false) {
    try { marketShare = await estimateMarketShare(today, settings); }
    catch (e) { console.warn('[competitor] market-share failed:', e.message); }
  }

  // emailOnlyWhenNew:true suppresses quiet runs (email only on a new opening/closing,
  // a new/updated impact analysis, or a newly-detected promo). Default false → send the
  // full weekly digest every run.
  // NOTE: market share is a near-static review-data proxy that barely moves week to week,
  // so it must NOT independently trigger an email — it rides along on emails the real
  // signals (events / impact / promos) already justify. Otherwise execs get a content-free
  // email every week and tune the digest out. The portal report below still captures the
  // share figure on quiet weeks.
  const newPromos = promos.filter((p) => p.isNew).length;
  const hasNews = newEvents.length || analyzed.length || newPromos;
  const shouldEmail = settings.emailOnlyWhenNew === false ? (newEvents.length || analyzed.length || promos.length) : hasNews;

  let emailed = false;
  if (shouldEmail) {
    const { to, cc } = await resolveRecipients([...newEvents, ...analyzed], settings, portalUsers);
    if (to.length) {
      const shareNote = marketShare?.avgShare != null ? ` · ~${marketShare.avgShare}% avg share` : '';
      const subject = `🏪 Competitor Intel — ${newEvents.length} new, ${analyzed.length} analyzed, ${promos.length} promos (${today})`;
      const html = wrapEmail(
        'Competitive Intelligence',
        `${newEvents.length} new event(s) · ${analyzed.length} impact update(s) · ${promos.length} promo(s)${newPromos ? ` (${newPromos} new)` : ''}${shareNote}`,
        buildEmailHtml(newEvents, analyzed, promos, marketShare),
        settings.testMode ? 'TEST MODE — routed to test inbox. Auto-detected events & promos are candidates; verify before acting.' : 'Auto-detected events & promos are candidates; verify before acting.',
      );
      await sendEmail({ to, cc, subject, html });
      emailed = true;
    }
  }
  // Surface the same digest in the portal Reports tab (Orion 'brief', network scope).
  // Saved every weekly detection run that has content — independent of email/test mode.
  let reportId = null;
  if (doDetection) {
    const artifact = buildReportArtifact(newEvents, analyzed, promos, marketShare, today);
    if (artifact) {
      try { reportId = await saveReport(artifact); }
      catch (e) { console.warn('[competitor] save report failed:', e.message); }
    }
  }

  // District-scoped, wider-radius digest for DMs — separate from the exec email above
  // (different content, different recipients). Only on the weekly detection run.
  let dmDigests = 0;
  if (doDetection && settings.dmDigestEnabled !== false) {
    try { dmDigests = await runDmDigests(today, settings, portalUsers); }
    catch (e) { console.warn('[competitor] DM digest run failed:', e.message); }
  }

  return { newEvents: newEvents.length, analyzed: analyzed.length, promos: promos.length, marketShare: marketShare ? marketShare.storesAnalyzed : 0, emailed, dmDigests, reportId, testMode: settings.testMode };
}

// ── DM digest — wider radius (default 5 mi), scoped to just that DM's district ──────
// Exec/IT get the tight ~1mi trade-area digest with $ impact modeling above; DMs asked
// for a broader "what's happening in my territory" view instead, so this runs a SEPARATE
// snapshot (its own blob key/history — never mixed with the exec trade-area snapshot) at
// settings.dmRadiusMeters for each store in the DM's district, and emails just that DM.
async function snapshotAndDiffForDigest(store, radiusMeters, snapKeyFn, today) {
  const curr = await snapshotStore(store, radiusMeters);
  if (!curr) return { events: [], curr: null };
  const prevWrap = await cacheLoad(snapKeyFn(store.pc));
  const prev = prevWrap?.items || null;
  const events = prev ? diffSnapshots(prev, curr) : []; // first run per store: baseline only
  // Same shape as the exec-path SNAP_KEY blob (asOf/items/history) so any future generic
  // reader of a competitor snapshot (e.g. a density-trend view) works for both radii, not
  // just the exec one. Same `today` the exec-path snapshot uses (not a fresh new Date())
  // so both blobs from the same weekly pass agree, even across a UTC midnight.
  const history = [...(Array.isArray(prevWrap?.history) ? prevWrap.history : []), { date: today, count: curr.length }].slice(-52);
  await cacheSave(snapKeyFn(store.pc), { asOf: today, items: curr, history });
  return { events, curr };
}

function dmEventRow(ev, storeName) {
  const verb = ev.eventType === 'open' ? 'opened' : 'closed';
  const driveNote = ev.driveMinutes != null ? ` (~${esc(ev.driveMinutes)} min drive)` : '';
  return `<li style="margin-bottom:10px;"><strong>${esc(ev.name)}</strong> (${esc(labelType(ev.type))}) ${verb} ~${esc(ev.distanceMi ?? '?')} mi from <strong>${esc(storeName)}</strong>${driveNote}</li>`;
}

// `users` may be pre-loaded by the caller (see resolveRecipients' same param) to avoid
// fetching the pcg_portal_users blob twice in one runCompetitorIntel execution.
async function runDmDigests(today, settings, users = null) {
  if (!users) users = (await cacheLoad('pcg_portal_users')) || [];
  const dms = (Array.isArray(users) ? users : []).filter((u) => u.userType === 'dm' && u.active);
  if (!dms.length) return 0;

  const radiusMi = Math.round((settings.dmRadiusMeters / METERS_PER_MILE) * 10) / 10;
  let sent = 0;

  for (const dm of dms) {
    const district = Number(dm.district);
    if (!district) continue;
    const myStores = STORES.filter((s) => Number(s.district) === district && STORE_COORDS[s.pc]);
    if (!myStores.length) continue;

    const byStore = [];
    for (const store of myStores) {
      let res;
      try { res = await snapshotAndDiffForDigest(store, settings.dmRadiusMeters, DM_SNAP_KEY, today); }
      catch (e) { console.warn(`[competitor] DM snapshot failed ${store.pc}:`, e.message); continue; }
      if (res.events.length) {
        for (const ev of res.events) {
          if (settings.driveTimeEnabled !== false && ev.lat != null && ev.lng != null) {
            const dt = await driveTimeMiles(STORE_COORDS[store.pc], { lat: ev.lat, lng: ev.lng });
            if (dt) ev.driveMinutes = dt.minutes;
          }
          byStore.push({ ev, storeName: store.name });
        }
      }
    }
    if (!byStore.length) continue; // quiet week for this DM — no email

    const opens = byStore.filter((r) => r.ev.eventType === 'open');
    const closes = byStore.filter((r) => r.ev.eventType === 'close');
    const bodyParts = [];
    if (opens.length) bodyParts.push(`<h3 style="margin:0 0 8px;">🆕 New competitor activity (${opens.length})</h3><ul style="padding-left:18px;margin:0 0 18px;">${opens.map((r) => dmEventRow(r.ev, r.storeName)).join('')}</ul>`);
    if (closes.length) bodyParts.push(`<h3 style="margin:0 0 8px;">📉 Competitor closures (${closes.length})</h3><ul style="padding-left:18px;margin:0 0 18px;">${closes.map((r) => dmEventRow(r.ev, r.storeName)).join('')}</ul>`);
    bodyParts.push(`<div style="color:#888;font-size:12px;margin-top:8px;">Scanned within ~${radiusMi} mi of each of your ${myStores.length} store(s) — wider than the network trade-area radius, so this may include competitors too far out to move your numbers. Verify before acting.</div>`);

    const to = settings.dmTestMode !== false
      ? (Array.isArray(settings.dmTestEmails) ? settings.dmTestEmails : [])
      : [dm.email].filter(Boolean);
    if (!to.length) continue;

    const subject = `🏪 Competitor Intel — District ${district} (~${radiusMi} mi radius) — ${opens.length} new, ${closes.length} closed (${today})`;
    const html = wrapEmail(
      `Competitive Intelligence — District ${district}`,
      `${opens.length} new competitor(s) · ${closes.length} closure(s) across ${myStores.length} store(s) within ~${radiusMi} mi`,
      bodyParts.join(''),
      settings.dmTestMode !== false ? `TEST MODE — routed to test inbox (would go to ${dm.name || dm.email || 'the district DM'}). Auto-detected — verify before acting.` : 'Auto-detected — verify before acting.',
    );
    try { await sendEmail({ to, cc: [], subject, html }); sent++; }
    catch (e) { console.warn(`[competitor] DM digest send failed (district ${district}):`, e.message); }
  }
  return sent;
}

export { runCompetitorIntel, runDetection, analyzeEvents, snapshotStore, diffSnapshots, deriveBrands, fetchPromos, fetchIndependentPromos, estimateMarketShare, buildEmailHtml, buildReportArtifact, runDmDigests, driveTimeMiles, categoryImpactNote, weeklyGuestsFromHourlyHistory };
