import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  isManagerTitle, managerMatches, namesCorrespond, detectManagerCandidate,
  advanceVacantStreak, suggestUsername, generatePassword, PASSWORD_RULE,
} from './manager-sync.mjs';

describe('isManagerTitle', () => {
  test('matches plain manager titles', () => {
    assert.strictEqual(isManagerTitle('Store Manager'), true);
    assert.strictEqual(isManagerTitle('General Manager'), true);
    assert.strictEqual(isManagerTitle('manager'), true);
  });
  test('excludes assistant variants', () => {
    assert.strictEqual(isManagerTitle('Assistant Manager'), false);
    assert.strictEqual(isManagerTitle('Assistant General Manager'), false);
  });
  test('non-manager titles and empty/missing titles are false', () => {
    assert.strictEqual(isManagerTitle('Crew Member'), false);
    assert.strictEqual(isManagerTitle(''), false);
    assert.strictEqual(isManagerTitle(null), false);
    assert.strictEqual(isManagerTitle(undefined), false);
  });
});

describe('managerMatches', () => {
  // Paycor's /employees always returns a bare top-level jobTitle: null — real title data
  // lives at positionData.jobTitle. Confirmed live 2026-09-22 against Elkins Park's real
  // roster (39 employees): the store's actual manager, Dilara Begum, has top-level
  // jobTitle: null and positionData.jobTitle: "Store Managers".
  const realShapeEmp = (over) => ({
    id: 'e1', firstName: 'Dilara', lastName: 'Begum',
    jobTitle: null, // Paycor always returns this null — must not be the only field read
    department: { id: 'guid-1234', url: '/v1/legalentities/1/departments/guid-1234' }, // an OBJECT, never a usable title string
    positionData: { jobTitle: 'Store Managers', jobCode: null },
    ...over,
  });

  test('reads the real title from positionData.jobTitle, not the always-null top-level field', () => {
    const out = managerMatches([realShapeEmp()]);
    assert.deepStrictEqual(out, [{ employeeId: 'e1', name: 'Dilara Begum', jobTitle: 'Store Managers' }]);
  });
  test('the department OBJECT is never mistaken for a title string (the original 0-matches-everywhere bug)', () => {
    // Before the fix, `emp.jobTitle || emp.department` picked up this object and
    // stringified it to "[object Object]" for every single employee at every store.
    const out = managerMatches([realShapeEmp({ positionData: { jobTitle: null } })]);
    assert.strictEqual(out.length, 0); // no positionData title at all -> correctly no match, never "[object Object]"
  });
  test('a real subordinate with a non-manager positionData title is excluded', () => {
    // Irin Sultana, Elkins Park: positionData.jobTitle "Shift Leaders", reports to Dilara Begum.
    const out = managerMatches([realShapeEmp({ id: 'e2', firstName: 'Irin', lastName: 'Sultana', positionData: { jobTitle: 'Shift Leaders' } })]);
    assert.strictEqual(out.length, 0);
  });
  test('keeps only manager-titled employees, normalizing id/name fields, across several records', () => {
    const employees = [
      realShapeEmp({ id: 'e1', firstName: 'Jane', lastName: 'Doe', positionData: { jobTitle: 'Store Manager' } }),
      realShapeEmp({ id: 'e2', firstName: 'Bob', lastName: 'Smith', positionData: { jobTitle: 'Assistant Manager' } }),
      realShapeEmp({ id: 'e3', firstName: 'Ann', lastName: 'Lee', positionData: { jobTitle: 'General Manager' } }),
      realShapeEmp({ id: 'e4', firstName: 'Sam', lastName: 'Kim', positionData: { jobTitle: 'Crew Member' } }),
    ];
    const out = managerMatches(employees);
    assert.deepStrictEqual(out.map(m => m.employeeId), ['e1', 'e3']);
    assert.deepStrictEqual(out[0], { employeeId: 'e1', name: 'Jane Doe', jobTitle: 'Store Manager' });
    assert.deepStrictEqual(out[1], { employeeId: 'e3', name: 'Ann Lee', jobTitle: 'General Manager' });
  });
  test('falls back to a top-level jobTitle if positionData has none (defensive, not the normal case)', () => {
    const out = managerMatches([realShapeEmp({ jobTitle: 'Store Manager', positionData: { jobTitle: null } })]);
    assert.strictEqual(out.length, 1);
  });
  test('skips a record with no usable id', () => {
    assert.strictEqual(managerMatches([realShapeEmp({ id: undefined })]).length, 0);
  });
});

describe('namesCorrespond (bootstrap linking only)', () => {
  test('exact match', () => assert.strictEqual(namesCorrespond('MD Obaid Amin', 'MD Obaid Amin'), true));
  test('a shortened middle/last name still corresponds (first + last token)', () => {
    assert.strictEqual(namesCorrespond('MD Obaid Amin', 'MD Obaid'), true);
  });
  test('case and whitespace insensitive', () => assert.strictEqual(namesCorrespond('  jane   doe ', 'JANE DOE'), true));
  test('genuinely different people do not correspond', () => {
    assert.strictEqual(namesCorrespond('Jane Doe', 'John Smith'), false);
  });
  test('empty/missing on either side never corresponds', () => {
    assert.strictEqual(namesCorrespond('', 'Jane Doe'), false);
    assert.strictEqual(namesCorrespond('Jane Doe', null), false);
  });
  // Pinned: the comparison is a deliberate order-preserving-subsequence match, more
  // lenient than "first + last token" — a Portal account stored under just a first
  // name still bootstrap-links to the fuller Paycor name. See the design spec's
  // "Bootstrap linking" section (updated 2026-09-22 to describe this accurately).
  // Do NOT "fix" this to require an exact first+last match — it would break intended,
  // working behavior for accounts stored under a first name only.
  test('a first-name-only Portal account corresponds to the fuller Paycor name (subsequence, not first+last)', () => {
    assert.strictEqual(namesCorrespond('John Smith', 'John'), true);
  });
  test('subsequence match also works with a middle name in between', () => {
    assert.strictEqual(namesCorrespond('John Michael Smith', 'John Smith'), true);
  });
});

describe('detectManagerCandidate', () => {
  const cand = (id, name = 'Jane Doe') => ({ employeeId: id, name, jobTitle: 'Store Manager' });

  test('one match, already linked → ok', () => {
    assert.deepStrictEqual(
      detectManagerCandidate({ matches: [cand('e1')], linkedEmployeeId: 'e1' }),
      { status: 'ok' }
    );
  });
  test('one match, different from linked → replace', () => {
    assert.deepStrictEqual(
      detectManagerCandidate({ matches: [cand('e2')], linkedEmployeeId: 'e1' }),
      { status: 'replace', candidate: cand('e2') }
    );
  });
  test('one match, nothing linked yet → replace', () => {
    assert.deepStrictEqual(
      detectManagerCandidate({ matches: [cand('e1')], linkedEmployeeId: null }),
      { status: 'replace', candidate: cand('e1') }
    );
  });
  test('two matches → needsReview, regardless of link state', () => {
    const matches = [cand('e1'), cand('e2', 'Bob Smith')];
    assert.deepStrictEqual(
      detectManagerCandidate({ matches, linkedEmployeeId: 'e1' }),
      { status: 'needsReview', candidates: matches }
    );
  });
  test('zero matches → zeroMatch', () => {
    assert.deepStrictEqual(
      detectManagerCandidate({ matches: [], linkedEmployeeId: 'e1' }),
      { status: 'zeroMatch' }
    );
  });
});

describe('advanceVacantStreak', () => {
  const WEEK = 7 * 86400000;
  const HOUR = 3600000;

  test('first zero-match run (no prior state) establishes zeroSinceMs and does not queue', () => {
    const r = advanceVacantStreak({ zeroMatchThisRun: true, nowMs: 1000, zeroSinceMs: null, alreadyQueued: false });
    assert.strictEqual(r.zeroSinceMs, 1000);
    assert.strictEqual(r.weeks, 0);
    assert.strictEqual(r.shouldQueue, false);
    assert.strictEqual(r.queued, false);
  });

  test('the streak holds flat across many hourly-cadence calls short of a week (realistic labor-cron calling pattern)', () => {
    let state = { zeroSinceMs: null, alreadyQueued: false };
    for (let hour = 0; hour * HOUR < 6 * 24 * HOUR; hour++) { // ~6 days, hourly checks
      const nowMs = hour * HOUR;
      const r = advanceVacantStreak({ zeroMatchThisRun: true, nowMs, zeroSinceMs: state.zeroSinceMs, alreadyQueued: state.alreadyQueued });
      assert.strictEqual(r.shouldQueue, false);
      assert.ok(r.weeks < 1);
      state = { zeroSinceMs: r.zeroSinceMs, alreadyQueued: r.queued };
    }
    assert.strictEqual(state.zeroSinceMs, 0); // streak start, once established, never moves
  });

  test('crossing exactly 3 weeks queues exactly once, and not again on a later call with alreadyQueued: true', () => {
    const zeroSinceMs = 0;
    const justUnder = advanceVacantStreak({ zeroMatchThisRun: true, nowMs: 3 * WEEK - HOUR, zeroSinceMs, alreadyQueued: false });
    assert.strictEqual(justUnder.weeks, 2);
    assert.strictEqual(justUnder.shouldQueue, false);

    const crossing = advanceVacantStreak({ zeroMatchThisRun: true, nowMs: 3 * WEEK, zeroSinceMs, alreadyQueued: false });
    assert.strictEqual(crossing.weeks, 3);
    assert.strictEqual(crossing.shouldQueue, true);
    assert.strictEqual(crossing.queued, true);

    // A later hourly-cadence run of the SAME streak, with alreadyQueued now persisted true
    // (as the caller would persist crossing.queued) — must never re-queue.
    const later = advanceVacantStreak({ zeroMatchThisRun: true, nowMs: 3 * WEEK + HOUR, zeroSinceMs, alreadyQueued: true });
    assert.strictEqual(later.shouldQueue, false);
    assert.strictEqual(later.queued, true);
  });

  test('a match reappearing resets zeroSinceMs to null (and un-queues)', () => {
    const r = advanceVacantStreak({ zeroMatchThisRun: false, nowMs: 3 * WEEK, zeroSinceMs: 0, alreadyQueued: true });
    assert.strictEqual(r.zeroSinceMs, null);
    assert.strictEqual(r.weeks, 0);
    assert.strictEqual(r.shouldQueue, false);
    assert.strictEqual(r.queued, false);
  });
});

describe('suggestUsername', () => {
  test('first initial + "." + last name, capitalized', () => {
    assert.strictEqual(suggestUsername('Jane Doe', []), 'J.Doe');
  });
  test('strips non-alphanumeric characters from last token', () => {
    assert.strictEqual(suggestUsername("MD Obaid-Amin", []), 'M.Obaidamin' /* first initial M + last token "Obaid-Amin" with hyphen stripped and capitalized */);
  });
  test('appends a number on collision (case-insensitive)', () => {
    assert.strictEqual(suggestUsername('Jane Doe', ['j.doe']), 'J.Doe2');
    assert.strictEqual(suggestUsername('Jane Doe', ['J.Doe', 'j.doe2']), 'J.Doe3');
  });
  test('single-word name returns capitalized without dot', () => {
    assert.strictEqual(suggestUsername('Prince', []), 'Prince');
  });
  test('empty or null name falls back to "User"', () => {
    assert.strictEqual(suggestUsername('', []), 'User');
    assert.strictEqual(suggestUsername(null, []), 'User');
    assert.strictEqual(suggestUsername(undefined, []), 'User');
  });
  test('all-punctuation single-word name falls back to "User"', () => {
    assert.strictEqual(suggestUsername('--', []), 'User');
    assert.strictEqual(suggestUsername('!!!', []), 'User');
  });
  test('last token that is all-punctuation falls back to first token as base', () => {
    assert.strictEqual(suggestUsername('Jane -', []), 'Jane');
    assert.strictEqual(suggestUsername('John !', []), 'John');
  });
});

describe('generatePassword', () => {
  test('always satisfies the password rule', () => {
    for (let i = 0; i < 20; i++) {
      const pw = generatePassword();
      assert.ok(pw.length >= PASSWORD_RULE.minLength);
      assert.match(pw, /[a-z]/);
      assert.match(pw, /[A-Z]/);
      assert.match(pw, /\d/);
      assert.match(pw, /[^A-Za-z0-9]/);
    }
  });
});
