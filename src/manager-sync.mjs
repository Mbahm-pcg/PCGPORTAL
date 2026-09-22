// src/manager-sync.mjs
// Pure Paycor-driven manager-detection logic — no I/O. Used by labor-cron.mjs.
// See docs/superpowers/specs/2026-09-22-manager-sync-design.md for the full rules.

const WEEK_MS = 7 * 86400000;
export const VACANT_WEEKS_THRESHOLD = 3;
export const PASSWORD_RULE = { minLength: 12 };

/** Title contains "manager" but not "assistant" (case-insensitive). */
export function isManagerTitle(title) {
  const t = String(title || '').toLowerCase();
  return t.includes('manager') && !t.includes('assistant');
}

/** Active employees (caller has already filtered to Active) whose title matches. */
export function managerMatches(employees) {
  const out = [];
  for (const emp of employees || []) {
    const employeeId = emp.id || emp.employeeId;
    if (!employeeId) continue;
    const jobTitle = emp.jobTitle || emp.department || '';
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

/** Track consecutive zero-match weeks for the "vacant" flag. Weeks are counted in whole
 *  WEEK_MS increments of elapsed time since the last run that had a match (or since the
 *  streak started); shouldQueue is true only on the run that first reaches the threshold,
 *  so the caller never re-queues an already-queued vacant item every subsequent run. */
export function advanceVacantStreak({ prevWeeks, zeroMatchThisRun, nowMs, lastRunMs }) {
  if (!zeroMatchThisRun) return { weeks: 0, shouldQueue: false };
  const elapsedWeeks = Math.max(1, Math.round((nowMs - lastRunMs) / WEEK_MS) || 1);
  const weeks = prevWeeks + (nowMs - lastRunMs >= WEEK_MS ? elapsedWeeks : (prevWeeks === 0 ? 1 : 0));
  const crossedNow = prevWeeks < VACANT_WEEKS_THRESHOLD && weeks >= VACANT_WEEKS_THRESHOLD;
  return { weeks, shouldQueue: crossedNow };
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
