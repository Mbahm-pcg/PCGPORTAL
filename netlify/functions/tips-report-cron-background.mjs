// tips-report-cron-background.mjs — Runs nightly, 3am ET (moved from 12am ET
// — confirmed directly, 2026-08-11, that some stores' Pulse guest checks
// aren't fully closed/settled at exactly midnight, e.g. Montgomeryville's tip
// pool grew from $18.69 at a 12am capture to $19.75 checking Pulse later that
// same morning; 3am gives every store's last late-closing transactions time
// to settle first). Always sends a DAILY tips report; on the
// Sunday each Sun–Sat pay week closes, also sends a WEEKLY rollup; every other
// Sunday (anchored to the real Aug 2–15, 2026 period, confirmed against
// Paycor's own "Bi-weekly" pay-group frequency) also sends a BIWEEKLY rollup
// meant for keying straight into Paycor payroll. All three share the exact
// same report shape (single "By Employee" sheet, see buildWorkbook) — weekly/
// biweekly just aggregate more days' worth of data.
//
// Kept as one function rather than three separate ones: this Netlify site's
// total env vars sit right at AWS Lambda's 4KB-per-function cap, so creating
// any brand-new function fails outright (hit this directly earlier). Folding
// weekly/biweekly into the already-existing nightly function sidesteps that.
//
// Each store's tip pool is divided by total hours worked in the period (crew
// only) to get a per-hour rate, then multiplied by each person's own hours —
// hours-weighted, not equal split. Hours come from real Paycor punches (summed
// per employee) — NOT Pulse's per-check employee ID, which was tested against
// live data and found to reflect whoever is logged into the register, not
// who's actually working; one store showed 191 checks all attributed to just
// 2 IDs, one of them a non-person "TransSvcs" system account. Punches are
// matched to Paycor's own employee list by GUID (employeeId), so no
// cross-system name-matching is needed. Only General Managers / Store
// Managers are excluded (jobTitle-based) — Asst Managers, Shift Leaders, and
// Crew Member all stay in the pool, per explicit instruction.
//
// Weekly/biweekly reuse each day's own nightly snapshot (pcg_tips_snapshot_*
// blobs) rather than re-fetching a week or two of Paycor data fresh — that
// would take way longer than the 15-min budget allows (46 stores sequential
// already takes minutes for ONE day). Known tradeoff: a punch a manager
// corrects AFTER that day's snapshot was taken won't retroactively show up in
// a later weekly/biweekly rollup unless that day's daily report is re-run
// (POST {"busDt":"YYYY-MM-DD"} regenerates and re-saves that day's snapshot).
// Known limitation (accepted): Paycor punch data has been sparse for some
// stores/days in this environment even after the labor-cron retry fix, so any
// of these reports may undercount crew until that's resolved — same
// underlying data gap, not a bug in this file.

import https from 'node:https';
import XLSX from 'xlsx';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '0 7 * * *' };

export const APIS = {
  p227: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p227',
    xkey:   'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL',
    apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
  p228: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p228',
    xkey:   'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP',
    apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
};

// Keep in sync with schedule-alerts.mjs / labor-cron.mjs / pos-negative-cron.mjs (CLAUDE.md gotcha #9).
export const STORES = [
  { pc:'339616', paycor:'193919', name:'Wadsworth',       district:1 },
  { pc:'340794', paycor:'193904', name:'Front',           district:1 },
  { pc:'351099', paycor:'193900', name:'Sonic',           district:2 },
  { pc:'351259', paycor:'193892', name:'Rosemore',        district:2 },
  { pc:'302642', paycor:'193914', name:'County Line',     district:2 },
  { pc:'352894', paycor:'193890', name:'Street Rd',       district:2 },
  { pc:'341350', paycor:'193920', name:'Yardley',         district:2 },
  { pc:'337839', paycor:'193888', name:'Warrington',      district:2 },
  { pc:'365953', paycor:'200540', name:'Hatboro',         district:2 },
  { pc:'330338', paycor:'193887', name:'Drexel Hill',     district:3 },
  { pc:'337063', paycor:'193902', name:'Sharon Hill',     district:3 },
  { pc:'343832', paycor:'193876', name:'Lansdowne',       district:3 },
  { pc:'304669', paycor:'193894', name:'Collingdale',     district:3 },
  { pc:'355146', paycor:'193895', name:'Gallery',         district:3 },
  { pc:'300496', paycor:'193906', name:'Cobbs Creek',     district:3 },
  { pc:'304863', paycor:'193885', name:'18th St',         district:3 },
  { pc:'354561', paycor:'193910', name:'Carlisle',        district:3 },
  { pc:'332393', paycor:'193907', name:'Lindbergh',       district:3 },
  { pc:'341167', paycor:'193893', name:'5th Street',      district:4 },
  { pc:'340870', paycor:'193912', name:'Hunting Park',    district:4 },
  { pc:'335981', paycor:'193873', name:'Lehigh',          district:4 },
  { pc:'353150', paycor:'193903', name:'Bakers Square',   district:4 },
  { pc:'351050', paycor:'193877', name:'Allegheny',       district:4 },
  { pc:'345985', paycor:'193916', name:'Wissahickon',     district:4 },
  { pc:'356374', paycor:'193898', name:'Montgomeryville', district:5 },
  { pc:'353843', paycor:'193891', name:'Tollgate',        district:5 },
  { pc:'353047', paycor:'193875', name:'Silverdale',      district:5 },
  { pc:'340538', paycor:'193879', name:'Easton',          district:5 },
  { pc:'343079', paycor:'193901', name:'Downingtown',     district:6 },
  { pc:'342144', paycor:'193908', name:'Westchester',     district:6 },
  { pc:'364295', paycor:'193881', name:'Lionville',       district:6 },
  { pc:'365361', paycor:'194373', name:'Little Welsh',    district:7 },
  { pc:'310382', paycor:'193899', name:'Grant',           district:7 },
  { pc:'332941', paycor:'193884', name:'Bustleton',       district:7 },
  { pc:'343497', paycor:'193874', name:'Red Lion',        district:7 },
  { pc:'302446', paycor:'193878', name:'Little Red Lion', district:7 },
  { pc:'337079', paycor:'193911', name:'Holme Circle',    district:7 },
  { pc:'345986', paycor:'193896', name:'Willits',         district:7 },
  { pc:'364412', paycor:'193905', name:'8200',            district:7 },
  { pc:'345489', paycor:'193880', name:'Oxford',          district:7 },
  { pc:'336372', paycor:'193897', name:'Elkins Park',     district:7 },
  { pc:'358933', paycor:'193886', name:'Brace Rd',        district:8 },
  { pc:'354865', paycor:'193915', name:'Quakertown',      district:8 },
  { pc:'353689', paycor:'193883', name:'Fort Washington', district:8 },
  { pc:'342184', paycor:'193917', name:'Lansdale',        district:8 },
  { pc:'356316', paycor:'193889', name:"BJ's",            district:8 },
];

export function callUpstream(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: cfg.host, port: 443, path: `${cfg.path}/${endpoint}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.xkey, 'Api-Key': cfg.apikey, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(raw));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('upstream request timed out')));
    req.write(data);
    req.end();
  });
}

// Calls our own deployed paycor.mjs proxy (handles OAuth/token refresh) rather
// than reimplementing that here — same site, internal HTTPS call. Retries once
// on failure/5xx — Paycor's own gateway genuinely returns transient 504s (seen
// directly: same store, same call, succeeded on one attempt and 504'd on the
// next), same real-world flakiness labor-cron.mjs already retries around.
// Timeout kept short (15s, was 45s) on purpose: confirmed via a real overnight
// run (2026-08-08/09) that when Paycor goes genuinely unresponsive, it hangs
// the FULL timeout on every call, not just a few — 85 consecutive calls each
// ate the old 45s before failing. With Phase 2's fixed wall-clock budget below,
// every extra second a hung store burns is a store later in the list that
// never gets attempted at all. A shorter timeout means more stores get a shot
// within the same budget when Paycor is having a bad night.
function callPaycorProxyOnce(action, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, ...payload });
    const req = https.request({
      hostname: 'pcg-ops.netlify.app', port: 443, path: '/.netlify/functions/paycor', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      const err = new Error('paycor proxy request timed out');
      err.isTimeout = true;
      req.destroy(err);
    });
    req.write(body);
    req.end();
  });
}
export async function callPaycorProxy(action, payload) {
  let result;
  try {
    result = await callPaycorProxyOnce(action, payload);
  } catch (err) {
    // A hang gets ONE fast attempt, not a retry — a store that's genuinely
    // unresponsive is very likely to hang again immediately, and retrying
    // just doubles the wasted time on that one store for nothing. A real
    // (non-hang) network error still gets retried once, since those tend to
    // clear up immediately (confirmed: same store/call succeeded on retry).
    if (err.isTimeout) throw err;
    result = await callPaycorProxyOnce(action, payload); // retry once on network error
    return result.raw;
  }
  if (result.status >= 500) {
    result = await callPaycorProxyOnce(action, payload); // retry once on 5xx
  }
  return result.raw;
}

// Paycor paginates /employees via continuationToken (same as labor-cron.mjs's
// fetchAllPages for this identical endpoint) — loop until it stops returning one.
export async function fetchAllEmployees(legalEntityId) {
  let records = [];
  let continuationToken;
  do {
    const raw = await callPaycorProxy('employees', continuationToken ? { legalEntityId, continuationToken } : { legalEntityId });
    const body = JSON.parse(raw || '{}');
    // Same disguised-error pattern already fixed for punches in
    // fetchStoreCrew — a Paycor error response (valid JSON, no `records`
    // array, has Title/CorrelationId) was silently treated as "empty page,
    // stop paginating" instead of a real failure. Confirmed real (2026-08-19,
    // Westchester 8/12): a transient hiccup truncated the employee list
    // mid-fetch, leaving 11 real active employees unresolved and printed as
    // "Unknown Employee (guid)" in the actual tips report. Throwing here
    // instead means the caller's existing try/catch marks the whole store's
    // crewStatus as 'error' for a retry, rather than silently shipping a
    // report with real people mislabeled as unknown.
    if (!Array.isArray(body.records) && !Array.isArray(body) && (body.Title || body.CorrelationId)) {
      throw new Error(`Paycor error response fetching employees: ${body.Title || 'unknown'} — ${body.Detail || ''}`);
    }
    const page = Array.isArray(body.records) ? body.records : (Array.isArray(body) ? body : []);
    records = records.concat(page);
    continuationToken = body.continuationToken || body.nextToken || null;
    if (!page.length) continuationToken = null;
  } while (continuationToken);
  return records;
}

// Same fallback chain as labor-cron.mjs's computeHoursFromPunches — not every
// punch carries a pre-computed hours field.
export function punchHours(p) {
  if (p.hourAmount != null) return p.hourAmount;
  if (p.hoursAmount != null) return p.hoursAmount;
  const inMs = new Date(p.punchIn || p.inActualPunch || 0).getTime();
  const outMs = new Date(p.punchOut || p.outActualPunch || 0).getTime();
  return (inMs && outMs && outMs > inMs) ? (outMs - inMs) / 3600000 : 0;
}

export function etDate(offsetDays) {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - offsetDays);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

export function toET(utc) {
  try { return new Date(utc.endsWith('Z') ? utc : utc + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }); }
  catch { return '--'; }
}

// ── Weekly / biweekly period helpers ─────────────────────────────────────────
// Pay weeks run Sunday–Saturday (not the Mon-start week the Labor page uses),
// so two weekly periods line up exactly with one biweekly pay period. Biweekly
// is anchored to the real period the user gave us: Sun Aug 2 – Sat Aug 15,
// 2026 (confirmed against Paycor's own pay-group frequency: "Bi-weekly").
const BIWEEKLY_ANCHOR_END = '2026-08-15'; // Saturday closing the first known period

function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function dayOfWeek(dateStr) { return parseDateOnly(dateStr).getDay(); } // 0=Sun..6=Sat
function addDaysStr(dateStr, days) {
  const d = parseDateOnly(dateStr);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Weekly/biweekly rollups fire on the Tuesday-night run (busDt = Tuesday),
// not Sunday morning — confirmed directly (2026-08-19) that a Sunday-morning
// report is built from timecards payroll hasn't locked yet, so any late punch
// correction (like Shyam Patel's) is baked in as wrong before it ever has a
// chance to be fixed. Payroll locks Tuesday night, so reporting 3 days after
// the week's Saturday close — instead of the morning right after — means the
// week's data has already had 3 days (and 3 daily reconcile passes) to settle.
function isWeekBoundary(busDt) { return dayOfWeek(busDt) === 2; } // Tuesday, 3 days after Saturday close
// The actual Sun-Sat week this Tuesday's rollup reports on (the Saturday 3
// days before the trigger date) — NOT busDt itself, which is the send day.
function weekEndForTrigger(busDt) { return addDaysStr(busDt, -3); }
function isBiweekBoundary(busDt) {
  if (!isWeekBoundary(busDt)) return false;
  const weekEnd = weekEndForTrigger(busDt);
  const diffDays = Math.round((parseDateOnly(weekEnd) - parseDateOnly(BIWEEKLY_ANCHOR_END)) / 86400000);
  return diffDays >= 0 && diffDays % 14 === 0;
}
// Inclusive date range of `days` dates ending at endDateStr, ascending.
export function dateRangeEndingAt(endDateStr, days) {
  const end = parseDateOnly(endDateStr);
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const dd = new Date(end);
    dd.setDate(end.getDate() - i);
    dates.push(`${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`);
  }
  return dates;
}

export async function saveDaySnapshot(busDt, storeResults) {
  try {
    await getBlobStore().setJSON(`pcg_tips_snapshot_${busDt}`, { savedAt: new Date().toISOString(), data: storeResults });
    // Keep the memoized cache below coherent with what was just written —
    // confirmed via audit (2026-08-20) that snapshotCache is module-scoped,
    // so (despite its own comment) it can survive across separate warm-
    // instance invocations, not just within one. Without this, a manual
    // backfill re-run followed by a weekly/biweekly rollup landing on the
    // same warm instance could read a stale pre-backfill copy.
    snapshotCache.set(busDt, storeResults);
  } catch (e) { console.warn('[tips-report-cron] snapshot save failed:', e.message); }
}
// Cache lifetime is best-effort, not guaranteed single-invocation (see
// saveDaySnapshot above) — used so that on a biweekly-boundary Saturday, the
// weekly (7-day) and biweekly (14-day) rollups overlap on 7 of those days;
// without this they'd each re-fetch those same 7 snapshot blobs separately.
const snapshotCache = new Map();
export async function loadDaySnapshot(busDt) {
  if (snapshotCache.has(busDt)) return snapshotCache.get(busDt);
  let result;
  try {
    const raw = await getBlobStore().get(`pcg_tips_snapshot_${busDt}`, { type: 'json' });
    result = raw?.data || null;
  } catch { result = null; }
  snapshotCache.set(busDt, result);
  return result;
}

// Combine N days of saved per-store snapshots into one period-long storeResults
// array — used for weekly/biweekly rollups. Re-fetching a full week or two of
// Paycor data fresh in a single run isn't feasible inside the 15-min budget
// (46 stores sequential already takes minutes for ONE day), so weekly/biweekly
// reuse each day's own nightly snapshot instead. Employees are matched across
// days by payrollId (falls back to name) so split/multi-day hours sum correctly.
// Correct hours-weighted split computed PER DAY (this day's pool ÷ this
// day's total hours), then summed across days into `share` — NOT a single
// period-blended rate. Confirmed real bug (2026-08-19): the previous version
// summed pool and hours across all 14 days FIRST, then divided once, silently
// blending every day's very different pool-per-hour ratio into one flat
// average — someone who only worked one big-tip day and someone who only
// worked one small-tip day ended up paid the identical rate, which is wrong,
// even though the STORE TOTAL still netted out correctly (that's computed
// separately from `rows`, real Pulse data, untouched by this). This is
// exactly why the bug went unnoticed for as long as it did — only the
// per-employee split was ever wrong, never the total.
//
// Pulled out as its own pure function (rather than left inline in
// buildPeriodStoreResults's loop) so selfTestShareMath() below can exercise
// this EXACT production code with a synthetic fixture — a hand-copied shadow
// implementation in a test would keep "passing" even after the real logic
// regressed, since it wouldn't be testing the real code at all.
// A period spans MULTIPLE days' saved snapshots — any day saved before the
// guid field existed keys the same employee by name/payrollId while a later
// day (once re-saved with the field) keys them by guid, and the reverse can
// also happen (guid present one day, missing the next — e.g. a rehire).
// Either direction can otherwise split one real person into two separate
// crewMap rows on a report explicitly built "for keying straight into
// Paycor payroll." accumulateDayShare below handles both directions by
// treating guid/payrollId as trustworthy "strong" identifiers and name as a
// weak fallback that gets disabled the moment it's found to be shared by
// two different people (see AMBIGUOUS_NAME_KEYS) — a naive version that
// aliased every entry under its name unconditionally was tested and found
// to incorrectly merge two different same-named employees, which is exactly
// the collision class guid-based matching exists to avoid.
//
// Symbol key (not a string) so it's automatically invisible to
// Object.keys/Object.values(crewMap) — lets a per-store crewMap carry a
// persistent "names we've learned are ambiguous" Set alongside the real
// guid/payrollId/name entries without needing to filter it out anywhere
// that reads the map's normal contents.
const AMBIGUOUS_NAME_KEYS = Symbol('ambiguousNameKeys');

function accumulateDayShare(crewMap, dayPool, dayCrew) {
  const dayTotalHours = (dayCrew || []).reduce((sum, c) => sum + c.hours, 0);
  const dayRate = dayTotalHours > 0 ? dayPool / dayTotalHours : 0;
  if (!crewMap[AMBIGUOUS_NAME_KEYS]) crewMap[AMBIGUOUS_NAME_KEYS] = new Set();
  const ambiguousNames = crewMap[AMBIGUOUS_NAME_KEYS];
  // Tracks which entry has already claimed each name WITHIN today's crew
  // list specifically (reset every call) — this is what makes a same-day
  // collision detectable: every entry in one day's crew list already has a
  // distinct guid (fetchStoreCrew builds it from Object.keys(hoursByGuid)),
  // so two different entries claiming the same name on the SAME day is a
  // certain signal of two different people, not a data-format transition.
  const nameClaimedToday = new Map();

  (dayCrew || []).forEach(c => {
    // guid/payrollId are treated as "strong" — always safe to match/alias
    // on, since they're specific to one person. Name is "weak" — used only
    // as a fallback when no strong key is available, and only trusted while
    // it isn't known to be ambiguous. Confirmed necessary via direct testing
    // (2026-08-21): an earlier version of this fix aliased every entry under
    // its name unconditionally, which correctly solved the guid/payrollId
    // instability case this function exists for, but incorrectly MERGED two
    // different real employees who happen to share a full name — exactly
    // the class of collision risk guid-based matching exists to avoid.
    const strongKeys = [];
    if (c.guid) strongKeys.push('g:' + c.guid);
    if (c.payrollId) strongKeys.push('p:' + c.payrollId);
    const nameKey = c.name ? 'n:' + c.name : null;

    let entry = null;
    for (const k of strongKeys) { if (crewMap[k]) { entry = crewMap[k]; break; } }
    if (!entry && nameKey && !ambiguousNames.has(nameKey)) {
      if (nameClaimedToday.has(nameKey)) {
        // Someone ELSE today already claimed this name via their own strong
        // keys (or lack thereof) — since today's entries are guaranteed
        // distinct people, this name can never be trusted again.
        ambiguousNames.add(nameKey);
        delete crewMap[nameKey];
      } else if (crewMap[nameKey]) {
        entry = crewMap[nameKey];
      }
    }
    if (!entry) entry = { name: c.name, payrollId: c.payrollId, guid: c.guid, hours: 0, share: 0 };

    strongKeys.forEach(k => { crewMap[k] = entry; });
    if (nameKey && !ambiguousNames.has(nameKey)) {
      const claimedBy = nameClaimedToday.get(nameKey);
      if (claimedBy && claimedBy !== entry) {
        ambiguousNames.add(nameKey);
        delete crewMap[nameKey];
      } else {
        nameClaimedToday.set(nameKey, entry);
        crewMap[nameKey] = entry;
      }
    }

    entry.hours += c.hours;
    entry.share += dayRate * c.hours;
  });
  return dayTotalHours;
}

// A pure checksum (sum-of-shares == pool) CANNOT distinguish a correct
// per-day split from the historical period-blended-rate bug — any
// proportional split share_i = rate * hours_i satisfies sum(shares) == pool
// regardless of whether `rate` was computed correctly per day or incorrectly
// as one period-blended average (confirmed via adversarial review,
// 2026-08-20, with a worked counterexample). A live-data checksum alone gives
// false confidence against exactly the bug it exists to catch. This runs the
// REAL accumulateDayShare against a fixture where the two days have very
// different pool-per-hour rates ($10/hr vs $1/hr) specifically chosen so a
// period-blended computation produces a DIFFERENT, WRONG answer — if the
// per-day logic ever regresses back to blended, this fails loudly on every
// single invocation instead of only occasionally producing wrong output that
// happens to look plausible. (Expected values below were themselves verified
// independently in a standalone script before shipping — an earlier draft of
// this exact fixture had the arithmetic wrong, which would have made the
// self-test worthless without ever failing loudly to say so.)
//
// Self-defending, confirmed necessary via adversarial review (2026-08-20):
// "different pool-per-hour rates" alone does NOT guarantee this fixture
// discriminates — algebraically, if every employee's SHARE OF DAILY HOURS
// stays constant across days (even with wildly different pool sizes),
// correct-per-day math and period-blended math produce IDENTICAL results
// for any pool amounts. A future "cleanup" of these numbers that preserves
// constant hour-ratios (e.g. same crew, same schedule, just bigger/smaller
// pool) would silently turn this whole self-test into a no-op that always
// passes. The check below verifies the FIXTURE ITSELF still discriminates,
// independent of whatever gets hardcoded as "expected" — so changing the
// fixture without understanding why fails loudly instead of silently.
function selfTestShareMath() {
  const fixtureDays = [
    { pool: 100, crew: [{ payrollId: 'A', name: 'A', hours: 8 }, { payrollId: 'B', name: 'B', hours: 2 }] }, // $10/hr day
    { pool: 10, crew: [{ payrollId: 'A', name: 'A', hours: 2 }, { payrollId: 'B', name: 'B', hours: 8 }] },  // $1/hr day
  ];

  const totalPool = fixtureDays.reduce((sum, d) => sum + d.pool, 0);
  const totalHoursByKey = {};
  fixtureDays.forEach(d => d.crew.forEach(c => { totalHoursByKey[c.payrollId] = (totalHoursByKey[c.payrollId] || 0) + c.hours; }));
  const totalHoursAll = Object.values(totalHoursByKey).reduce((sum, h) => sum + h, 0);
  const blendedRate = totalHoursAll > 0 ? totalPool / totalHoursAll : 0;
  const blendedA = blendedRate * (totalHoursByKey.A || 0);

  const crewMap = {};
  fixtureDays.forEach(d => accumulateDayShare(crewMap, d.pool, d.crew));
  // Keyed 'p:<payrollId>' now (a "strong" key — this fixture has no guid,
  // and payrollId always registers when present, per accumulateDayShare
  // above), not a bare 'A'/'B'.
  const gotA = Number((crewMap['p:A']?.share || 0).toFixed(2));
  const gotB = Number((crewMap['p:B']?.share || 0).toFixed(2));

  if (Math.abs(blendedA - gotA) < 1) {
    throw new Error(`Share-math self-test fixture is no longer discriminating: a naive period-blended calculation (A=$${blendedA.toFixed(2)}) would produce nearly the same result as the correct per-day calculation (A=$${gotA.toFixed(2)}), so this fixture can no longer detect a regression to the historical period-blended-rate bug. It needs each employee's HOUR RATIO (not just the pool size) to differ across the fixture days — do not "clean up" these numbers without preserving that.`);
  }

  // Correct per-day answer: A = 8*10 + 2*1 = 82; B = 2*10 + 8*1 = 28.
  // A period-blended rate would instead give (100+10)/(8+2+2+8)=5.5/hr for
  // everyone: A=10*5.5=55, B=10*5.5=55 — clearly different from the above.
  if (Math.abs(gotA - 82) > 0.01 || Math.abs(gotB - 28) > 0.01) {
    throw new Error(`Share-math self-test FAILED: expected A=$82.00 B=$28.00 (correct per-day split), got A=$${gotA.toFixed(2)} B=$${gotB.toFixed(2)} — accumulateDayShare appears to have regressed to a period-blended rate (the historical 2026-08-19 bug class). Refusing to build weekly/biweekly reports until this is fixed.`);
  }
}

async function buildPeriodStoreResults(endDateStr, days) {
  selfTestShareMath();
  const dates = dateRangeEndingAt(endDateStr, days);
  const snapshots = await Promise.all(dates.map(loadDaySnapshot));
  const missingDates = dates.filter((d, i) => !snapshots[i]);
  // Store-days where real tips were collected but zero eligible (non-excluded)
  // crew hours were recorded — confirmed real (2026-08-20): BJ's, Grant, and
  // Red Lion all hit this from a Paycor fetch hiccup dropping a real
  // employee's punch, not a genuine "only the manager worked" day. Tracked
  // per-day here (before days get merged into one period total below) since
  // a single bad day gets washed out once merged with the rest of a good period.
  const zeroEligibleDays = [];
  // Mirror image of the above on the Pulse side, and NOT caught by the
  // sanity gate in buildWorkbook (confirmed via adversarial review,
  // 2026-08-20): if a day's Pulse fetch fails (status:'error', tipPool stays
  // at 0) while that same day's Paycor crew fetch succeeds with real hours,
  // both the period pool AND every eligible employee's share for that day
  // silently shrink by the same unflagged amount — the checksum still
  // balances because both sides lost the same money, so this needs its own
  // explicit flag rather than relying on the sanity gate to notice.
  const pulseGapDays = [];
  // A third case, distinct from both above: the day's Paycor crew fetch
  // failed ENTIRELY (crewStatus:'error', not "ok with zero eligible hours")
  // while Pulse succeeded with a real pool. Confirmed via adversarial review
  // (2026-08-20): zeroEligiblePool only ever excluded the
  // crewStatus:'ok'-but-zero-hours case, never this one — so a persistent,
  // unrecovered Paycor failure for one store-day (exactly the class of
  // failure tips-reconcile-cron.mjs explicitly defers rather than fixes, per
  // its own "only reconcile days that already succeeded" comment) added real
  // dollars to the period pool with nothing subtracted, tripping the sanity
  // gate and blocking the ENTIRE 46-store report with a misleading "math
  // doesn't add up" alert instead of correctly naming a known data gap.
  const crewErrorDays = [];

  const byStore = {};
  for (let di = 0; di < snapshots.length; di++) {
    const dayResults = snapshots[di];
    const dayBusDt = dates[di];
    if (!dayResults) continue;
    for (const s of dayResults) {
      if (!byStore[s.pc]) {
        byStore[s.pc] = { pc: s.pc, name: s.name, district: s.district, rows: [], tipPool: 0, crewMap: {}, hadTips: false, hadCrew: false, zeroEligiblePool: 0 };
      }
      const agg = byStore[s.pc];
      if (s.status === 'ok') {
        agg.hadTips = true;
        agg.rows.push(...s.rows);
        agg.tipPool += s.tipPool || 0;
      }
      if (s.crewStatus === 'ok') {
        agg.hadCrew = true;
        const dayPool = Number((s.tipPool || 0).toFixed(2));
        const dayHasCrewHours = (s.crew || []).some(c => c.hours > 0);
        if (s.status !== 'ok' && dayHasCrewHours) {
          pulseGapDays.push({ pc: s.pc, name: s.name, date: dayBusDt });
        }
        const dayTotalHours = accumulateDayShare(agg.crewMap, dayPool, s.crew);
        if (dayTotalHours === 0 && dayPool > 0) {
          zeroEligibleDays.push({ pc: s.pc, name: s.name, date: dayBusDt, pool: dayPool });
          agg.zeroEligiblePool += dayPool;
        }
      } else if (s.status === 'ok') {
        const dayPool = Number((s.tipPool || 0).toFixed(2));
        if (dayPool > 0) {
          crewErrorDays.push({ pc: s.pc, name: s.name, date: dayBusDt, pool: dayPool });
          agg.zeroEligiblePool += dayPool;
        }
      }
    }
  }

  const storeResults = STORES.map(s => {
    const agg = byStore[s.pc];
    if (!agg) return { pc: s.pc, name: s.name, district: s.district, status: 'error', crewStatus: 'error', rows: [], tipPool: 0, crew: [], zeroEligiblePool: 0 };
    return {
      pc: s.pc, name: s.name, district: s.district,
      status: agg.hadTips ? 'ok' : 'error',
      crewStatus: agg.hadCrew ? 'ok' : 'error',
      rows: agg.rows, tipPool: agg.tipPool,
      // Deduped by object identity — accumulateDayShare now aliases one
      // crew entry under multiple keys (guid/payrollId/name), so a plain
      // Object.values would return the same person's entry more than once.
      crew: [...new Set(Object.values(agg.crewMap))],
      zeroEligiblePool: agg.zeroEligiblePool,
    };
  });
  return { storeResults, missingDates, zeroEligibleDays, pulseGapDays, crewErrorDays };
}

// ── Build the workbook (single sheet: per-employee distribution) ──
// periodLabel is display text for the title row (e.g. "2026-08-05" for daily,
// "Week of Aug 3–9, 2026" for weekly, "Pay Period Aug 2–15, 2026" for biweekly).
function buildWorkbook(periodLabel, storeResults) {
  let grandTotal = 0;
  let grandCount = 0;
  for (const s of storeResults) {
    grandTotal += s.rows.reduce((sum, r) => sum + r.tip, 0);
    grandCount += s.rows.length;
  }

  // Employee distribution: each store's tip pool is divided by the total hours
  // worked in the period (crew only, managers excluded) to get a per-hour tip
  // rate, then each person's share = that rate × their own hours worked —
  // hours feed the calculation but aren't shown as their own column, matching
  // the exact 5-column layout requested (District / Store(PC) / Employee /
  // Total Tips / Share), with District, Store(PC), and Total Tips merged down
  // each store's employee rows. Payroll ID is intentionally omitted per that
  // same request.
  const empAoa = [
    [`PCG Tips — Employee Distribution — ${periodLabel} (hours-weighted, GM/Store Managers excluded)`],
    [],
    ['District', 'Store Name (PC)', 'Employee', 'Total Tips for Store', 'Per-Employee Share'],
  ];
  const empMerges = [];
  // Sanity gate: per-employee shares must sum back to the store's own tip pool
  // (within a few cents of ordinary rounding) before this report is allowed
  // out the door. Confirmed real (2026-08-19): a period-blended-rate bug once
  // produced a report where every STORE TOTAL was still correct (computed
  // independently from raw Pulse `rows`, untouched by the per-employee split
  // logic) while every individual employee's dollar amount was wrong — that
  // combination is exactly what let it ship unnoticed for two full weeks.
  // Tolerance of $0.25/store is generous on purpose: real accumulated
  // rounding-order noise across a 14-day period topped out at a few cents per
  // EMPLOYEE in direct verification (see verify_fix.js from that
  // investigation), so a store-level sum could plausibly drift a bit further
  // than that on a big roster — but nowhere near this. An actual logic bug
  // (like the one that motivated this check) produces dollars of drift, not
  // cents, so this threshold has wide margin on both sides without being
  // loose enough to miss a real regression.
  const SHARE_MISMATCH_TOLERANCE = 0.25;
  const shareMismatches = [];
  for (const s of storeResults) {
    const pool = Number((s.tipPool || 0).toFixed(2));
    const storeLabel = `${s.name} (${s.pc})`;
    const startRow = empAoa.length;

    if (s.crewStatus === 'error') {
      empAoa.push([s.district, storeLabel, '(Paycor data unavailable)', pool, '']);
      continue;
    }
    if (s.crew.length === 0) {
      empAoa.push([s.district, storeLabel, '(no crew punches found)', pool, '']);
      continue;
    }

    // Period reports (weekly/biweekly, via buildPeriodStoreResults) arrive
    // with each employee's `share` already correctly summed day-by-day — use
    // it directly. Daily reports (single day, storeResults built inline in
    // the main loop below) have no `share` field, so fall back to the
    // original single-day hourlyRate×hours math, which is already correct
    // for exactly one day.
    const totalHours = s.crew.reduce((sum, c) => sum + c.hours, 0);
    const hourlyRate = totalHours > 0 ? pool / totalHours : 0;
    let sumShares = 0;
    s.crew.forEach(c => {
      const share = c.share != null ? Number(c.share.toFixed(2)) : Number((hourlyRate * c.hours).toFixed(2));
      sumShares += share;
      empAoa.push([s.district, storeLabel, c.name, pool, share]);
    });
    sumShares = Number(sumShares.toFixed(2));
    // Compare against the pool MINUS whatever's already separately explained
    // by this store's own zero-eligible-crew days (see buildPeriodStoreResults)
    // — otherwise a known, already-flagged data gap (real pool, nobody
    // eligible to pay it) gets misdiagnosed here as a per-employee-split
    // logic bug and blocks the ENTIRE report for all stores, while the real
    // explanation (zeroEligibleNote, below) never even reaches the resulting
    // alert email. Confirmed via adversarial review, 2026-08-20. Not present
    // on daily reports (s.zeroEligiblePool is undefined there) since a
    // zero-eligible day in a single-day report already takes the separate
    // `s.crew.length === 0` branch above and never reaches this code at all.
    const expectedPool = Number((pool - (s.zeroEligiblePool || 0)).toFixed(2));
    const diff = Number((sumShares - expectedPool).toFixed(2));
    // Fail CLOSED on non-finite input (e.g. a future bug feeding NaN hours/
    // pool into the share math) — Math.abs(NaN) > threshold is false, so an
    // unguarded comparison would let the most severe "numbers don't add up"
    // case pass silently. Confirmed via adversarial review, 2026-08-20.
    if (!Number.isFinite(diff) || Math.abs(diff) > SHARE_MISMATCH_TOLERANCE) {
      shareMismatches.push({ pc: s.pc, name: s.name, pool, sumShares, expectedPool, diff });
    }

    // Merge District/Store/Total-Tips down across this store's rows (only when
    // it spans more than one row — a single-row block needs no merge).
    const endRow = empAoa.length - 1;
    if (endRow > startRow) {
      empMerges.push({ s: { r: startRow, c: 0 }, e: { r: endRow, c: 0 } }); // District
      empMerges.push({ s: { r: startRow, c: 1 }, e: { r: endRow, c: 1 } }); // Store Name (PC)
      empMerges.push({ s: { r: startRow, c: 3 }, e: { r: endRow, c: 3 } }); // Total Tips for Store
    }
  }
  const empWs = XLSX.utils.aoa_to_sheet(empAoa);
  empWs['!cols'] = [{ wch: 9 }, { wch: 24 }, { wch: 24 }, { wch: 18 }, { wch: 16 }];
  empWs['!merges'] = empMerges;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, empWs, 'By Employee');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), grandTotal, grandCount, shareMismatches };
}

// ── Email (attachment) ───────────────────────────────────────────────────────
async function sendReportEmail(to, subject, html, buffer, filename) {
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; } catch {}

  if (nodemailer && process.env.GOOGLE_SMTP_USER) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.GOOGLE_SMTP_HOST || 'smtp-relay.gmail.com',
        port: parseInt(process.env.GOOGLE_SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.GOOGLE_SMTP_USER, pass: process.env.GOOGLE_SMTP_PASSWORD },
      });
      const FROM_DOMAIN = process.env.SMTP_FROM_DOMAIN || 'peoplecapitalgroup.com';
      await transporter.sendMail({
        from: `PCG Portal <ops@${FROM_DOMAIN}>`,
        to, subject, html,
        attachments: [{ filename, content: buffer }],
      });
      return { sent: true, method: 'smtp' };
    } catch (e) {
      console.warn('[tips-report-cron] SMTP failed:', e.message);
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const payload = JSON.stringify({
        from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>',
        to: Array.isArray(to) ? to : [to],
        subject, html,
        attachments: [{ filename, content: buffer.toString('base64') }],
      });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => resolve(raw)); });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      return { sent: true, method: 'resend' };
    } catch (e) {
      console.warn('[tips-report-cron] Resend failed:', e.message);
    }
  }

  return { sent: false };
}

// Same SMTP/Resend fallback as sendReportEmail, minus the xlsx attachment —
// used for out-of-band alerts (sanity-check failures, zero-eligible-crew
// warnings) that need to go out even when there's no report file to attach,
// or when the report was deliberately held back from sending.
async function sendAlertEmail(to, subject, html) {
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; } catch {}

  if (nodemailer && process.env.GOOGLE_SMTP_USER) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.GOOGLE_SMTP_HOST || 'smtp-relay.gmail.com',
        port: parseInt(process.env.GOOGLE_SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.GOOGLE_SMTP_USER, pass: process.env.GOOGLE_SMTP_PASSWORD },
      });
      const FROM_DOMAIN = process.env.SMTP_FROM_DOMAIN || 'peoplecapitalgroup.com';
      await transporter.sendMail({ from: `PCG Portal <ops@${FROM_DOMAIN}>`, to, subject, html });
      return { sent: true, method: 'smtp' };
    } catch (e) {
      console.warn('[tips-report-cron] SMTP alert failed:', e.message);
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const payload = JSON.stringify({
        from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>',
        to: Array.isArray(to) ? to : [to],
        subject, html,
      });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      return { sent: true, method: 'resend' };
    } catch (e) {
      console.warn('[tips-report-cron] Resend alert failed:', e.message);
    }
  }

  return { sent: false };
}

export function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

// Employees excluded from the tip pool by explicit one-off request,
// independent of job title — e.g. someone whose Paycor title alone
// wouldn't trigger the isManager rule but who's been told to permanently
// stop receiving tips. Keyed by Paycor employee GUID (id on the employee
// record) since it survives a title/status change, unlike name (can have
// duplicates) or employeeNumber (can be reassigned) — but a GUID is NOT
// guaranteed to survive a REHIRE (this codebase's own CLAUDE.md already
// documents needing to match Paycor employees by name instead of ID for
// exactly this reason in a different context). Each entry records its
// expected store (pc) and name purely so fetchStoreCrew can warn — see
// below — if a configured GUID ever stops matching anyone at that store,
// turning a silent "exclusion quietly stopped working" into a visible one.
export const MANUALLY_EXCLUDED_EMPLOYEES = [
  { guid: '4e992115-3994-0000-0000-000076f50200', pc: '354561', name: 'Cindy Chea', excludedOn: '2026-08-20' }, // Carlisle, per Ahmed
];
const MANUALLY_EXCLUDED_EMPLOYEE_IDS = new Set(MANUALLY_EXCLUDED_EMPLOYEES.map(e => e.guid));

// Matched by Paycor's own GUID (employeeId on the punch === id on the
// employee record) — no cross-system name-matching needed. Hours are
// summed per employee (a split shift shows as multiple punch rows) so
// the tip pool can be divided by hours worked, not headcount. Module-scope
// (not a closure) so tips-report-morning-sweep.mjs can reuse it to retry a
// specific store without re-running the whole nightly function.
export async function fetchStoreCrew(s, busDt) {
  let crew = [], crewStatus = 'error';
  try {
    const punchesRaw = await callPaycorProxy('punches', { legalEntityId: s.paycor, startDate: busDt, endDate: busDt });
    const empList = await fetchAllEmployees(s.paycor);
    const punchData = JSON.parse(punchesRaw || '{}');
    // Paycor error responses (e.g. "Forbidden — this Access Token does not
    // have access to Legal Entity ID X", confirmed directly on Hatboro,
    // 2026-08-12) are valid parseable JSON with no `records` array at all —
    // NOT an empty array. Our own paycor.mjs proxy relays whatever status
    // Paycor sent, but callPaycorProxy here only retries on 5xx, so a 4xx
    // error body sails through and previously got silently treated as "zero
    // punches found" (crewStatus: 'ok', crew: []) instead of a real failure
    // — indistinguishable from a store that genuinely had nobody clock in.
    if (!Array.isArray(punchData.records) && !Array.isArray(punchData) && (punchData.Title || punchData.CorrelationId)) {
      throw new Error(`Paycor error response: ${punchData.Title || 'unknown'} — ${punchData.Detail || ''}`);
    }
    const punches = Array.isArray(punchData.records) ? punchData.records : (Array.isArray(punchData) ? punchData : []);
    const empByGuid = {};
    empList.forEach(e => { if (e && e.id) empByGuid[e.id] = e; });

    // Confirmed via audit (2026-08-20): a manual exclusion is a bare GUID
    // match with no verification it still points at a real employee — if
    // that GUID ever stops matching (rehire, record recreated), the
    // exclusion silently becomes a no-op forever with zero signal, since the
    // person's shares still sum correctly into the pool exactly like anyone
    // else's (the sanity gate can't see this either). This at least makes
    // that specific failure visible in logs instead of invisible.
    for (const excl of MANUALLY_EXCLUDED_EMPLOYEES) {
      if (excl.pc !== String(s.pc) || empByGuid[excl.guid]) continue;
      console.warn(`[tips-report-cron] MANUAL EXCLUSION MAY BE STALE: ${excl.name} (GUID ${excl.guid}, excluded ${excl.excludedOn}) not found in current employee list for ${s.name} (${s.pc}) — their Paycor GUID may have changed. Verify and update MANUALLY_EXCLUDED_EMPLOYEES if so.`);
    }

    const hoursByGuid = {};
    punches.forEach(p => {
      if (!p.employeeId) return;
      hoursByGuid[p.employeeId] = (hoursByGuid[p.employeeId] || 0) + punchHours(p);
    });
    crew = Object.keys(hoursByGuid)
      .filter(guid => !MANUALLY_EXCLUDED_EMPLOYEE_IDS.has(guid))
      .map(guid => {
      const e = empByGuid[guid];
      const jobTitle = e?.positionData?.jobTitle || '';
      return {
        name: e ? `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim() || 'Unnamed Employee' : `Unknown Employee (${guid.slice(0, 8)})`,
        // Paycor's own employeeId — the one identifier confirmed stable
        // across a routine payroll change (unlike payrollId/employeeNumber,
        // which is known to sometimes go from blank to populated during
        // onboarding, confirmed via audit 2026-08-20 to cause a same person
        // to look like a simultaneous "add + drop" between two fetches).
        // Kept alongside payrollId (not replacing it) so tips-reconcile-
        // cron.mjs and anything else correlating crew across two fetches can
        // prefer this first and only fall back to the fragile field.
        guid,
        payrollId: e?.employeeNumber || e?.alternateEmployeeNumber || '',
        hours: hoursByGuid[guid],
        // Any title containing "Manager" is excluded — General Manager,
        // Store Manager, Area Manager, District Manager, etc (updated
        // 2026-08-19: previously only General/Store Manager were excluded,
        // but confirmed the real intent is broader — literally any manager
        // title except Assistant Manager, which explicitly stays in the pool
        // along with Shift Leaders and Crew Member). The "assist"/"asst"
        // check opts Assistant Manager back in despite matching "manager".
        isManager: /manager/i.test(jobTitle) && !/assist|asst/i.test(jobTitle),
      };
    }).filter(c => !c.isManager && c.hours > 0);
    crewStatus = 'ok';
  } catch (err) {
    console.error(`[tips-report-cron] ${s.name} crew error:`, err.message);
  }
  return { crew, crewStatus };
}

export default async (request) => {
  const invocationStart = Date.now();
  // Manual catch-up runs can target a specific date: POST {"busDt":"YYYY-MM-DD"}.
  // Scheduled invocations have no body, so this falls back to yesterday-ET.
  let busDt = etDate(1);
  try {
    const body = await request.json();
    if (body?.busDt) busDt = body.busDt;
  } catch {}
  console.log(`[tips-report-cron] Building tips report for ${busDt} across ${STORES.length} stores`);

  const storeResults = new Array(STORES.length);

  // Phase 1: Pulse tip totals — safe to batch, no shared auth state involved.
  const BATCH = 6;
  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (s, j) => {
      const idx = i + j;
      const cfg = APIS[s.pc === '345986' ? 'p227' : 'p228'];
      let rows = [], tipPool = 0, checksStatus = 'error';
      try {
        const checksRaw = await callUpstream(cfg, 'getGuestChecks', { locRef: s.pc, opnBusDt: busDt, clsdGuestChecksOnly: true, include: 'guestChecks' });
        const data = JSON.parse(checksRaw || '{}');
        const checks = Array.isArray(data.guestChecks) ? data.guestChecks : [];
        rows = checks
          .filter(c => (c.tipTotal || 0) > 0)
          .map(c => ({ chkNum: c.chkNum, time: c.clsdUTC ? toET(c.clsdUTC) : (c.opnUTC ? toET(c.opnUTC) : '--'), tip: c.tipTotal }))
          .sort((a, b) => a.time.localeCompare(b.time));
        tipPool = checks.reduce((sum, c) => sum + (c.tipTotal || 0), 0);
        checksStatus = 'ok';
      } catch (err) {
        console.error(`[tips-report-cron] ${s.name} checks error:`, err.message);
      }
      storeResults[idx] = { pc: s.pc, name: s.name, district: s.district, status: checksStatus, crewStatus: 'error', rows, tipPool, crew: [] };
    }));
  }

  // Phase 2: Paycor punches/employees — SEQUENTIAL, one store at a time, AND
  // one call at a time within a store. Our own paycor.mjs proxy caches its
  // OAuth token in-memory per warm Lambda instance; firing calls concurrently
  // spins up multiple cold instances with no shared cache, all racing to
  // refresh the same (single-use) refresh token — only one wins, the rest get
  // rejected. Confirmed directly: a real overnight run failed on ~40 of 46
  // stores simultaneously with the same error the instant concurrency was
  // introduced across stores. That fix made the store loop sequential, but
  // store 0's punches+employees calls were still fired together via
  // Promise.all — the very first Paycor calls of a cold invocation, so they
  // could still race each other exactly the same way (seen directly: store 0
  // failing crewStatus while every later store succeeded once the token was
  // cached). Awaiting punches before employees removes that too.
  //
  // Time-budgeted: confirmed via a real overnight run (Netlify function logs,
  // 2026-08-08) that Paycor's own API can go unresponsive for 30+ minutes
  // straight — 85 consecutive calls to our paycor.mjs proxy each hung the
  // full ~30s before failing with a 504. At 46 stores × up to 2 sequential
  // calls each, that alone exceeds Netlify's 15-min background function
  // ceiling, and Netlify kills the whole invocation mid-loop. Because
  // saveDaySnapshot()/the email below only ran AFTER this loop fully
  // finished, that overnight run lost 100% of its work — Phase 1's Pulse
  // data included — and sent nothing. Bailing out of the loop once we're
  // within a safe margin of the ceiling guarantees whatever's done so far
  // (still saved + emailed below) survives even a total Paycor outage,
  // instead of an all-or-nothing loss.
  // Warm-up call: whichever store lands at idx 0 pays a cost none of the others
  // do — it's the very first Paycor call of a cold invocation, so our own
  // paycor.mjs proxy has no cached OAuth token yet and must fetch one before it
  // can even start the real request. Confirmed directly (Wadsworth, 2026-08-10):
  // idx-0 alone came back crewStatus:'error' while every later store that
  // night succeeded — a slow-but-legitimate cold start gets misclassified as a
  // "hang" by the 15s timeout and (correctly, for an actually-unresponsive
  // Paycor) never retried. Firing one throwaway call before the timed loop
  // starts absorbs that one-time cost outside of any store's own budget, so
  // store 0 hits the loop with an already-warm token exactly like store 1+ do.
  try {
    await callPaycorProxy('employees', { legalEntityId: STORES[0].paycor });
  } catch (err) {
    console.warn('[tips-report-cron] Paycor warm-up call failed (continuing — store 0 just loses the head start):', err.message);
  }

  const PHASE2_BUDGET_MS = 11 * 60 * 1000; // leaves ~4min for save/email/rollups
  let phase2TimedOut = false;
  for (let idx = 0; idx < STORES.length; idx++) {
    if (Date.now() - invocationStart > PHASE2_BUDGET_MS) {
      phase2TimedOut = true;
      console.warn(`[tips-report-cron] Phase 2 time budget hit at store ${idx}/${STORES.length} (${STORES[idx].name}) — saving/emailing what's done, skipping the rest`);
      break;
    }
    const { crew, crewStatus } = await fetchStoreCrew(STORES[idx], busDt);
    storeResults[idx].crew = crew;
    storeResults[idx].crewStatus = crewStatus;
  }

  // Automatic retry pass(es): individually retrying just the stores that
  // failed proved far more likely to succeed than the original batch attempt
  // (confirmed directly during manual recovery, 2026-08-11) — far fewer total
  // Paycor calls per pass gives intermittent flakiness much less surface area
  // to land on. Budget-guarded same as the main loop; stops early once
  // nothing's left to retry. Raised from 3 to 6 (2026-08-12) — manual recovery
  // that night needed up to 5 individual retries for one store, and each pass
  // only re-touches whatever's still failing (a shrinking list), so there's
  // budget headroom for more passes without risking the 15-min ceiling — a
  // store stuck for a REASON (e.g. a permissions error, not flakiness) still
  // can't hog the whole run since every store already got its first attempt
  // before any retries happen at all.
  const MAX_RETRY_PASSES = 6;
  for (let pass = 1; pass <= MAX_RETRY_PASSES; pass++) {
    const failedIdxs = storeResults.map((r, i) => r.crewStatus === 'error' ? i : -1).filter(i => i !== -1);
    if (failedIdxs.length === 0) break;
    if (Date.now() - invocationStart > PHASE2_BUDGET_MS) {
      console.warn(`[tips-report-cron] Retry pass ${pass}: time budget hit — ${failedIdxs.length} store(s) still failing, leaving as-is`);
      break;
    }
    console.log(`[tips-report-cron] Retry pass ${pass}: re-attempting ${failedIdxs.length} failed store(s): ${failedIdxs.map(i => STORES[i].name).join(', ')}`);
    for (const idx of failedIdxs) {
      if (Date.now() - invocationStart > PHASE2_BUDGET_MS) break;
      const { crew, crewStatus } = await fetchStoreCrew(STORES[idx], busDt);
      storeResults[idx].crew = crew;
      storeResults[idx].crewStatus = crewStatus;
    }
  }

  // Guard against a fresh Phase 1/2 result regressing below whatever's
  // already saved for this date — matters most for a manual backfill re-run
  // (POST {busDt}), the one path that rebuilds an already-existing day from
  // scratch. Confirmed missing via audit (2026-08-20): the sibling targeted-
  // refresh tool (tips-report-refresh-background.mjs) got this protection
  // after a real incident; this file's own equivalent re-run path never did,
  // despite its own header comment documenting POST {busDt} as a supported
  // manual catch-up mechanism. Same per-store, per-side heuristic as the
  // sibling: an outright status flip, OR a fresh result that's suspiciously
  // emptier than what's already saved. Uses an uncached read (not
  // loadDaySnapshot) since this check must see the true current blob, not a
  // possibly-stale memoized copy from an earlier invocation on a warm instance.
  let existingForBusDt = null;
  try {
    const raw = await getBlobStore().get(`pcg_tips_snapshot_${busDt}`, { type: 'json' });
    existingForBusDt = raw?.data || null;
  } catch {}
  if (Array.isArray(existingForBusDt)) {
    const existingByPc = new Map(existingForBusDt.map(s => [String(s.pc), s]));
    storeResults.forEach((fresh, idx) => {
      const existingEntry = existingByPc.get(String(fresh.pc));
      if (!existingEntry) return;
      const keepOldPulse = (existingEntry.status === 'ok' && fresh.status !== 'ok')
        || ((existingEntry.rows?.length || 0) > 0 && (fresh.rows?.length || 0) === 0);
      const keepOldCrew = (existingEntry.crewStatus === 'ok' && fresh.crewStatus !== 'ok')
        || ((existingEntry.crew?.length || 0) > 0 && (fresh.crew?.length || 0) === 0);
      if (keepOldPulse || keepOldCrew) {
        console.warn(`[tips-report-cron] ${busDt}/${fresh.pc}: fresh result regressed (pulse:${keepOldPulse}, crew:${keepOldCrew}) — keeping existing saved data instead of overwriting it`);
        storeResults[idx] = {
          ...fresh,
          ...(keepOldPulse ? { status: existingEntry.status, rows: existingEntry.rows, tipPool: existingEntry.tipPool } : {}),
          ...(keepOldCrew ? { crewStatus: existingEntry.crewStatus, crew: existingEntry.crew } : {}),
        };
      }
    });
  }

  // Cache today's snapshot BEFORE building/sending anything — weekly/biweekly
  // rollups (below) read from these, and a report failure downstream shouldn't
  // stop the day's data from being saved for next time.
  await saveDaySnapshot(busDt, storeResults);
  // Snapshots aren't needed past one biweekly cycle plus slack.
  const staleDate = dateRangeEndingAt(busDt, 40)[0];
  getBlobStore().delete(`pcg_tips_snapshot_${staleDate}`).catch(() => {});

  const recipient = (process.env.TIPS_REPORT_EMAIL || 'ahmed@peoplecapitalgroup.com').split(',').map(s => s.trim()).filter(Boolean);

  // Flag tonight's zero-eligible-crew days immediately, independent of the
  // disabled daily report email — confirmed real (2026-08-20): BJ's, Grant,
  // and Red Lion all had this happen from a Paycor fetch hiccup dropping a
  // real employee's punch, not a genuine "only the manager worked" day, and
  // it went unnoticed for days because nothing surfaced it outside a buried
  // "(no crew punches found)" spreadsheet row. Catching it the same night
  // means a one-day fix instead of a multi-day manual audit later.
  const tonightsZeroEligible = storeResults.filter(s => s.crewStatus === 'ok' && s.crew.length === 0 && Number((s.tipPool || 0).toFixed(2)) > 0);
  if (tonightsZeroEligible.length > 0) {
    console.warn(`[tips-report-cron] ${busDt}: ${tonightsZeroEligible.length} store(s) collected tips with zero eligible crew hours:`, tonightsZeroEligible.map(s => `${s.name} ($${s.tipPool.toFixed(2)})`).join(', '));
    const rows = tonightsZeroEligible.map(s => `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee;">${s.name} (${s.pc})</td><td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;">$${Number(s.tipPool).toFixed(2)}</td></tr>`).join('');
    const alertHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background:#f59f00;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="color:#fff;margin:0;font-size:18px;">⚠ Tips — ${busDt} — Unpaid Tip Pool(s)</h2>
        </div>
        <div style="padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;">
          <p style="margin:0 0 8px;font-size:14px;">${tonightsZeroEligible.length} store(s) collected real tips on ${busDt} but had zero eligible (non-excluded) crew hours recorded — nobody would get paid for that day's pool under the current split. This has previously turned out to be a Paycor fetch hiccup silently dropping a real employee's punch (confirmed at BJ's, Grant, and Red Lion), not an actual "only the manager worked" day — worth checking Paycor punches directly for each store below.</p>
          <table style="border-collapse:collapse;width:100%;margin-top:10px;font-size:13px;">
            <tr style="background:#f5f5f5;"><th style="padding:4px 10px;text-align:left;">Store</th><th style="padding:4px 10px;text-align:right;">Tip Pool</th></tr>
            ${rows}
          </table>
        </div>
      </div>`;
    await sendAlertEmail(recipient, `⚠ Tips — ${tonightsZeroEligible.length} store(s) with unpaid pool — ${busDt}`, alertHtml).catch(() => {});
  }

  async function buildAndSend(periodLabel, filenameTag, storeResultsForPeriod, subjectPrefix, missingDates, extraNote, skipEmail = false, zeroEligibleDays, pulseGapDays, crewErrorDays) {
    const { buffer, grandTotal, grandCount, shareMismatches } = buildWorkbook(periodLabel, storeResultsForPeriod);
    const filename = `PCG-Tips-Report-${filenameTag}.xlsx`;
    const storesWithTips = storeResultsForPeriod.filter(s => s.status === 'ok' && s.rows.length > 0).length;
    const storesWithErrors = storeResultsForPeriod.filter(s => s.status === 'error').length;

    // Sanity gate — see buildWorkbook for the full reasoning. A mismatch here
    // means the per-employee split logic itself is producing numbers that
    // don't add up to the store's own total, which is almost certainly a bug
    // affecting every store using the same formula, not a one-off data
    // glitch — so this holds back the WHOLE report rather than sending
    // partially-trusted numbers into what may become a payroll import.
    if (shareMismatches.length > 0) {
      console.error(`[tips-report-cron] SANITY CHECK FAILED for ${subjectPrefix} — ${periodLabel}:`, JSON.stringify(shareMismatches));
      const rows = shareMismatches.map(m => `<tr><td style="padding:4px 10px;border-bottom:1px solid #eee;">${m.name} (${m.pc})</td><td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;">$${m.pool.toFixed(2)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;">$${m.sumShares.toFixed(2)}</td><td style="padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:#e03131;">$${m.diff.toFixed(2)}</td></tr>`).join('');
      const alertHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background:#e03131;padding:16px 24px;border-radius:8px 8px 0 0;">
            <h2 style="color:#fff;margin:0;font-size:18px;">⚠ ${subjectPrefix} — ${periodLabel} — NOT SENT</h2>
          </div>
          <div style="padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;">
            <p style="margin:0 0 8px;font-size:14px;">The per-employee split didn't add up to the store total for ${shareMismatches.length} store(s), so this report was held back instead of sent with wrong numbers. This needs a look before it goes out — the attached file reflects the bad numbers for debugging, not for use.</p>
            <table style="border-collapse:collapse;width:100%;margin-top:10px;font-size:13px;">
              <tr style="background:#f5f5f5;"><th style="padding:4px 10px;text-align:left;">Store</th><th style="padding:4px 10px;text-align:right;">Pool</th><th style="padding:4px 10px;text-align:right;">Sum of shares</th><th style="padding:4px 10px;text-align:right;">Diff</th></tr>
              ${rows}
            </table>
          </div>
        </div>`;
      const alertResult = await sendReportEmail(recipient, `⚠ ${subjectPrefix} — ${periodLabel} — NOT SENT (sanity check failed)`, alertHtml, buffer, filename).catch(() => ({ sent: false }));
      console.error(`[tips-report-cron] ${subjectPrefix} — held back, alert sent:`, alertResult);
      return { grandTotal, grandCount, storesWithTips, storesWithErrors, shareMismatches, email: { sent: false, blockedBySanityCheck: true, alert: alertResult } };
    }

    const missingNote = missingDates && missingDates.length
      ? `<p style="margin:0 0 8px;font-size:13px;color:#b45309;">Note: ${missingDates.length} day(s) in this period have no saved data — either before this report existed, or that night's run didn't complete (${missingDates.join(', ')}).</p>`
      : '';
    const extraNoteHtml = extraNote
      ? `<p style="margin:0 0 8px;font-size:13px;color:#b45309;">${extraNote}</p>`
      : '';
    const zeroEligibleNote = zeroEligibleDays && zeroEligibleDays.length
      ? `<p style="margin:0 0 8px;font-size:13px;color:#e03131;">⚠ ${zeroEligibleDays.length} store-day(s) in this period collected tips with zero eligible crew hours recorded (often a Paycor fetch hiccup, not a real "manager only" day): ${zeroEligibleDays.map(d => `${d.name} ${d.date} ($${d.pool.toFixed(2)})`).join('; ')}</p>`
      : '';
    const pulseGapNote = pulseGapDays && pulseGapDays.length
      ? `<p style="margin:0 0 8px;font-size:13px;color:#e03131;">⚠ ${pulseGapDays.length} store-day(s) in this period had real crew hours worked but the Pulse tip-pool fetch failed that day — that day's dollar amount is silently treated as $0 for both the store total and every employee's share, understating both: ${pulseGapDays.map(d => `${d.name} ${d.date}`).join('; ')}</p>`
      : '';
    const crewErrorNote = crewErrorDays && crewErrorDays.length
      ? `<p style="margin:0 0 8px;font-size:13px;color:#e03131;">⚠ ${crewErrorDays.length} store-day(s) in this period collected real tips but the Paycor crew fetch failed entirely that day (not just "zero eligible" — a real fetch error) — that day's pool is excluded from the per-employee split until it's manually retried: ${crewErrorDays.map(d => `${d.name} ${d.date} ($${d.pool.toFixed(2)})`).join('; ')}</p>`
      : '';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #FF671F; padding: 16px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="color: #fff; margin: 0; font-size: 18px;">${subjectPrefix} — ${periodLabel}</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 8px 8px;">
          <p style="margin: 0 0 8px; font-size: 14px;">Total tips: <strong>$${grandTotal.toFixed(2)}</strong> across <strong>${grandCount}</strong> checks.</p>
          <p style="margin: 0 0 8px; font-size: 14px; color: #666;">${storesWithTips} of ${STORES.length} stores had tips recorded${storesWithErrors ? `; ${storesWithErrors} store(s) could not be reached` : ''}.</p>
          ${missingNote}
          ${extraNoteHtml}
          ${zeroEligibleNote}
          ${pulseGapNote}
          ${crewErrorNote}
          <p style="margin: 16px 0 0; font-size: 13px; color: #999;">Attached (${filename}): "By Employee" sheet divides each store's tip pool by hours worked in this period (GM/Store Managers excluded) and pays each person by their own hours.</p>
        </div>
      </div>
    `;
    if (skipEmail) {
      console.log(`[tips-report-cron] ${subjectPrefix} — email skipped by request, snapshot already saved`);
      return { grandTotal, grandCount, storesWithTips, storesWithErrors, email: { skipped: true } };
    }
    const emailResult = await sendReportEmail(recipient, `${subjectPrefix} — ${periodLabel} — $${grandTotal.toFixed(2)}`, html, buffer, filename);
    console.log(`[tips-report-cron] ${subjectPrefix} email result:`, emailResult, 'to', recipient);
    return { grandTotal, grandCount, storesWithTips, storesWithErrors, email: emailResult };
  }

  const phase2TimeoutNote = phase2TimedOut
    ? `Paycor was unresponsive partway through tonight's run, so employee/hours data stops partway through the store list — the dollar totals above are still complete, but the "By Employee" split is incomplete for the stores that weren't reached.`
    : undefined;
  // Daily email disabled per explicit request (2026-08-19) — the snapshot
  // save above still runs every night unconditionally (that's what the
  // in-app Tips Report and the weekly/biweekly rollups both read from), only
  // the nightly email itself is skipped.
  const dailyResult = await buildAndSend(busDt, busDt, storeResults, 'PCG Tips Report — Daily', undefined, phase2TimeoutNote, true);

  // Each wrapped in its own try/catch (confirmed missing via adversarial
  // review, 2026-08-20): previously an uncaught exception anywhere in
  // buildPeriodStoreResults/buildWorkbook/buildAndSend (including the new
  // selfTestShareMath() throw) would abort the ENTIRE handler, silently
  // dropping whatever report type came next with no alert at all — worse
  // than the sanity gate's own "NOT SENT" alert, since nobody would even
  // know a report was supposed to go out that night.
  let weeklyResult = null, biweeklyResult = null;
  if (isWeekBoundary(busDt)) {
    const weekEnd = weekEndForTrigger(busDt);
    const [weekStart] = dateRangeEndingAt(weekEnd, 7);
    const label = `Week of ${weekStart} – ${weekEnd}`;
    try {
      const { storeResults: weekResults, missingDates, zeroEligibleDays, pulseGapDays, crewErrorDays } = await buildPeriodStoreResults(weekEnd, 7);
      weeklyResult = await buildAndSend(label, `Week-${weekStart}-to-${weekEnd}`, weekResults, 'PCG Tips Report — Weekly', missingDates, undefined, false, zeroEligibleDays, pulseGapDays, crewErrorDays);
    } catch (err) {
      console.error('[tips-report-cron] Weekly report build FAILED:', err.message);
      await sendAlertEmail(recipient, `⚠ PCG Tips Report — Weekly — ${label} — FAILED TO BUILD`, `<p>The weekly tips report for <b>${label}</b> could not be built and was not sent: ${err.message}</p>`).catch(() => {});
      weeklyResult = { error: err.message };
    }
  }
  if (isBiweekBoundary(busDt)) {
    const weekEnd = weekEndForTrigger(busDt);
    const [periodStart] = dateRangeEndingAt(weekEnd, 14);
    const label = `Pay Period ${periodStart} – ${weekEnd}`;
    try {
      const { storeResults: biweekResults, missingDates, zeroEligibleDays, pulseGapDays, crewErrorDays } = await buildPeriodStoreResults(weekEnd, 14);
      biweeklyResult = await buildAndSend(label, `PayPeriod-${periodStart}-to-${weekEnd}`, biweekResults, 'PCG Tips Report — Biweekly (Payroll)', missingDates, undefined, false, zeroEligibleDays, pulseGapDays, crewErrorDays);
    } catch (err) {
      console.error('[tips-report-cron] Biweekly report build FAILED:', err.message);
      await sendAlertEmail(recipient, `⚠ PCG Tips Report — Biweekly — ${label} — FAILED TO BUILD`, `<p>The biweekly (payroll) tips report for <b>${label}</b> could not be built and was not sent: ${err.message}</p>`).catch(() => {});
      biweeklyResult = { error: err.message };
    }
  }

  try {
    const store = getBlobStore();
    await store.setJSON('pcg_tips_report_last_run', {
      savedAt: new Date().toISOString(),
      data: { ranAt: new Date().toISOString(), busDt, daily: dailyResult, weekly: weeklyResult, biweekly: biweeklyResult },
    });
  } catch {}

  const summary = { ok: true, busDt, daily: dailyResult, weekly: weeklyResult, biweekly: biweeklyResult };
  console.log('[tips-report-cron] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
