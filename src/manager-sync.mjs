// src/manager-sync.mjs
// Pure Paycor-driven manager-detection logic — no I/O. Used by labor-cron.mjs.
// See docs/superpowers/specs/2026-09-22-manager-sync-design.md for the full rules.

const WEEK_MS = 7 * 86400000;
export const VACANT_WEEKS_THRESHOLD = 3;
export const PASSWORD_RULE = { minLength: 12 };

/** Title contains "manager" but not "assistant" (case-insensitive). Confirmed live
 *  2026-09-22: Paycor's real convention abbreviates to "Asst Managers", not the spelled-out
 *  "Assistant Manager" originally assumed — checking only "assistant" let 5 of 6 real stores'
 *  assistant managers slip through as false "needsReview" (paired against the real manager). */
export function isManagerTitle(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('manager') && !t.includes('assistant') && !/\basst\b/.test(t);
}

/** Active employees (caller has already filtered to Active) whose title matches.
 *  Confirmed live 2026-09-22 against real Paycor data: /employees always returns a bare
 *  top-level `jobTitle: null` — the real title lives at `positionData.jobTitle`. The old
 *  `emp.jobTitle || emp.department` fallback picked up `department` (an object, not a
 *  string) instead, which stringifies to "[object Object]" and can never contain "manager"
 *  — this was the actual cause of a 0-matches-at-every-store result on the first live run,
 *  not a real title-wording mismatch. `emp.jobTitle` is kept as a last-resort fallback in
 *  case some record ever does carry it directly, but positionData is the real source. */
export function managerMatches(employees) {
  const out = [];
  for (const emp of employees || []) {
    const employeeId = emp.id || emp.employeeId;
    if (!employeeId) continue;
    const jobTitle = emp.positionData?.jobTitle || emp.jobTitle || '';
    if (!isManagerTitle(jobTitle)) continue;
    const name = `${emp.firstName || ''} ${emp.lastName || ''}`.trim();
    out.push({ employeeId, name, jobTitle });
  }
  return out;
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
}

/** Lenient first+last-token comparison — used ONLY to bootstrap-link a store's existing,
 *  already-correct manager who predates this feature. Never used for routine checks once
 *  a store has a real paycor_employee_id link (see spec). */
export function namesCorrespond(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  const ta = na.split(' '), tb = nb.split(' ');
  const [longer, shorter] = ta.length >= tb.length ? [ta, tb] : [tb, ta];
  // First token must match
  if (longer[0] !== shorter[0]) return false;
  // All tokens of shorter must appear in longer in the same order
  let j = 0;
  for (let i = 0; i < shorter.length && j < longer.length; i++) {
    while (j < longer.length && longer[j] !== shorter[i]) j++;
    if (j >= longer.length) return false;
    j++;
  }
  return true;
}

/** Decide this store's status for THIS run, given today's manager-title matches and the
 *  employeeId currently linked to this store's Portal manager account (null if none/unlinked). */
export function detectManagerCandidate({ matches, linkedEmployeeId }) {
  if (matches.length === 0) return { status: 'zeroMatch' };
  if (matches.length > 1) return { status: 'needsReview', candidates: matches };
  const only = matches[0];
  if (linkedEmployeeId && only.employeeId === linkedEmployeeId) return { status: 'ok' };
  return { status: 'replace', candidate: only };
}

/** Tracks a store's continuous zero-manager-match streak using a single persisted
 *  "streak started" timestamp, rather than an incrementing counter — much simpler and
 *  avoids the previous design's off-by-one. zeroSinceMs is the timestamp of the first
 *  run that saw zero matches in the CURRENT streak (pass null if there's no prior
 *  streak state, e.g. the first-ever zero-match run for this store, or after a match
 *  most recently reset it). alreadyQueued is whether a vacant notification has already
 *  fired for this same continuous streak (persisted by the caller; reset whenever the
 *  streak resets). Returns the (possibly newly-established) zeroSinceMs to persist, the
 *  current whole-weeks-elapsed count, shouldQueue (true exactly once, on the run that
 *  first reaches the threshold and hasn't already queued), and queued (the value to
 *  persist for alreadyQueued on the next call). */
export function advanceVacantStreak({ zeroMatchThisRun, nowMs, zeroSinceMs, alreadyQueued }) {
  if (!zeroMatchThisRun) return { zeroSinceMs: null, weeks: 0, shouldQueue: false, queued: false };
  const since = zeroSinceMs == null ? nowMs : zeroSinceMs;
  const weeks = Math.floor((nowMs - since) / WEEK_MS);
  const shouldQueue = weeks >= VACANT_WEEKS_THRESHOLD && !alreadyQueued;
  return { zeroSinceMs: since, weeks, shouldQueue, queued: alreadyQueued || shouldQueue };
}

/** "Jane Doe" -> "J.Doe"; collisions get 2, 3, ... appended (case-insensitive). */
export function suggestUsername(name, existingUsernames) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  let base;

  if (tokens.length === 0) {
    base = 'User';
  } else if (tokens.length === 1) {
    // Single word: sanitize, then capitalize
    const alnum = tokens[0].replace(/[^a-zA-Z0-9]/g, '');
    if (alnum.length === 0) {
      base = 'User';  // fallback for all-punctuation names
    } else {
      base = alnum[0].toUpperCase() + alnum.slice(1).toLowerCase();
    }
  } else {
    // Multiple tokens: first initial + "." + last token (both sanitized, capitalized)
    const firstTokenAlnum = tokens[0].replace(/[^a-zA-Z0-9]/g, '');
    const lastTokenAlnum = tokens[tokens.length - 1].replace(/[^a-zA-Z0-9]/g, '');

    if (lastTokenAlnum.length === 0 || firstTokenAlnum.length === 0) {
      // Fallback if either token is all-punctuation: use first token as whole base
      if (firstTokenAlnum.length === 0) {
        base = 'User';
      } else {
        base = firstTokenAlnum[0].toUpperCase() + firstTokenAlnum.slice(1).toLowerCase();
      }
    } else {
      const firstInitial = firstTokenAlnum[0].toUpperCase();
      const lastName = lastTokenAlnum[0].toUpperCase() + lastTokenAlnum.slice(1).toLowerCase();
      base = firstInitial + '.' + lastName;
    }
  }

  // Case-insensitive collision detection
  const existing = new Set((existingUsernames || []).map((u) => String(u).toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  let n = 2;
  while (existing.has(`${base}${n}`.toLowerCase())) n++;
  return `${base}${n}`;
}

/** A random password that always satisfies validatePasswordClient's rule (app.jsx:559):
 *  12+ chars, lowercase, uppercase, digit, special character. It's only a pre-fill the
 *  admin can change, so it doesn't need to be memorable. */
export function generatePassword() {
  const lower = 'abcdefghijkmnpqrstuvwxyz', upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789', special = '!@#$%^&*-_=+';
  const all = lower + upper + digits + special;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  let pw = pick(lower) + pick(upper) + pick(digits) + pick(special);
  while (pw.length < PASSWORD_RULE.minLength) pw += pick(all);
  return pw.split('').sort(() => Math.random() - 0.5).join('');
}
