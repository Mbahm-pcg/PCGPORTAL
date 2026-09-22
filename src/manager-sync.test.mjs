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
  test('keeps only manager-titled employees, normalizing id/name fields', () => {
    const employees = [
      { id: 'e1', firstName: 'Jane', lastName: 'Doe', jobTitle: 'Store Manager' },
      { employeeId: 'e2', firstName: 'Bob', lastName: 'Smith', jobTitle: 'Assistant Manager' },
      { id: 'e3', firstName: 'Ann', lastName: 'Lee', department: 'General Manager' },
      { id: 'e4', firstName: 'Sam', lastName: 'Kim', jobTitle: 'Crew Member' },
    ];
    const out = managerMatches(employees);
    assert.deepStrictEqual(out.map(m => m.employeeId), ['e1', 'e3']);
    assert.deepStrictEqual(out[0], { employeeId: 'e1', name: 'Jane Doe', jobTitle: 'Store Manager' });
    assert.deepStrictEqual(out[1], { employeeId: 'e3', name: 'Ann Lee', jobTitle: 'General Manager' });
  });
  test('skips a record with no usable id', () => {
    assert.strictEqual(managerMatches([{ firstName: 'No', lastName: 'Id', jobTitle: 'Store Manager' }]).length, 0);
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
  test('first zero-match run starts the streak at 1 week, does not queue yet', () => {
    const r = advanceVacantStreak({ prevWeeks: 0, zeroMatchThisRun: true, nowMs: WEEK, lastRunMs: 0 });
    assert.strictEqual(r.weeks, 1);
    assert.strictEqual(r.shouldQueue, false);
  });
  test('crossing 3 weeks queues exactly once', () => {
    const r2 = advanceVacantStreak({ prevWeeks: 2, zeroMatchThisRun: true, nowMs: 3 * WEEK, lastRunMs: 2 * WEEK });
    assert.strictEqual(r2.weeks, 3);
    assert.strictEqual(r2.shouldQueue, true);
    const r3 = advanceVacantStreak({ prevWeeks: 3, zeroMatchThisRun: true, nowMs: 4 * WEEK, lastRunMs: 3 * WEEK });
    assert.strictEqual(r3.shouldQueue, false); // already queued, don't re-queue every run after
  });
  test('a match resets the streak to 0', () => {
    const r = advanceVacantStreak({ prevWeeks: 2, zeroMatchThisRun: false, nowMs: 3 * WEEK, lastRunMs: 2 * WEEK });
    assert.strictEqual(r.weeks, 0);
    assert.strictEqual(r.shouldQueue, false);
  });
});

describe('suggestUsername', () => {
  test('first initial + last name, lowercased', () => {
    assert.strictEqual(suggestUsername('Jane Doe', []), 'jdoe');
  });
  test('strips non-alphanumeric characters', () => {
    assert.strictEqual(suggestUsername("MD Obaid-Amin", []), 'mamin' /* first initial M + lastname "Amin" but hyphen name has 3 tokens: use first + LAST token */);
  });
  test('appends a number on collision', () => {
    assert.strictEqual(suggestUsername('Jane Doe', ['jdoe']), 'jdoe2');
    assert.strictEqual(suggestUsername('Jane Doe', ['jdoe', 'jdoe2']), 'jdoe3');
  });
  test('single-word name falls back to the whole word', () => {
    assert.strictEqual(suggestUsername('Prince', []), 'prince');
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
