import { test, describe } from 'node:test';
import assert from 'node:assert';
import { daysUntil, warningStatus, nextDeadline, dealDeadlineFlag, icsForDeal } from './deal-dates.mjs';

const NOW = Date.parse('2026-06-05T00:00:00Z'); // fixed "today" for determinism
const plusDays = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);

describe('daysUntil', () => {
  test('today=0, future positive, past negative', () => {
    assert.strictEqual(daysUntil('2026-06-05', NOW), 0);
    assert.strictEqual(daysUntil('2026-06-12', NOW), 7);
    assert.strictEqual(daysUntil('2026-06-04', NOW), -1);
    assert.strictEqual(daysUntil(null, NOW), Infinity);
  });
});

describe('warningStatus', () => {
  test('inside the largest tier → active warning, picks smallest covering tier', () => {
    const w = warningStatus('2026-06-12', [14, 7], NOW); // 7 days out
    assert.strictEqual(w.daysOut, 7);
    assert.strictEqual(w.active, true);
    assert.strictEqual(w.level, 'warning');
    assert.strictEqual(w.tier, 7);
  });
  test('option/renewal: 120-day lead fires well before day-of', () => {
    const w = warningStatus(plusDays(100), [180, 120, 90, 60, 30], NOW); // 100 days out
    assert.strictEqual(w.active, true);          // inside the 180 window
    assert.strictEqual(w.tier, 120);             // smallest tier >= 100
    assert.strictEqual(w.level, 'warning');
  });
  test('beyond the largest tier → not active', () => {
    const w = warningStatus(plusDays(200), [180, 120, 90], NOW);
    assert.strictEqual(w.active, false);
    assert.strictEqual(w.level, 'none');
  });
  test('overdue → active overdue', () => {
    const w = warningStatus('2026-06-04', [7], NOW);
    assert.strictEqual(w.daysOut, -1);
    assert.strictEqual(w.level, 'overdue');
    assert.strictEqual(w.active, true);
  });
});

describe('nextDeadline', () => {
  test('soonest unacknowledged; skips acknowledged', () => {
    const dates = [
      { id: 1, due_date: plusDays(30), warning_tiers: [14] },
      { id: 2, due_date: plusDays(5),  warning_tiers: [7], acknowledged_at: '2026-06-01T00:00:00Z' },
      { id: 3, due_date: plusDays(10), warning_tiers: [14] },
    ];
    const n = nextDeadline(dates, NOW);
    assert.strictEqual(n.id, 3); // id 2 is sooner but acknowledged
    assert.strictEqual(n.daysOut, 10);
  });
  test('empty → null', () => {
    assert.strictEqual(nextDeadline([], NOW), null);
  });
});

describe('dealDeadlineFlag', () => {
  test('overdue outranks warning', () => {
    const f = dealDeadlineFlag([
      { id: 1, due_date: plusDays(5), warning_tiers: [7] },   // warning
      { id: 2, due_date: '2026-06-01', warning_tiers: [3] },  // overdue
    ], NOW);
    assert.strictEqual(f.level, 'overdue');
  });
  test('no active dates → none', () => {
    const f = dealDeadlineFlag([{ id: 1, due_date: plusDays(200), warning_tiers: [30] }], NOW);
    assert.strictEqual(f.level, 'none');
  });
});

describe('icsForDeal', () => {
  test('emits VEVENT + all-day DTSTART + a VALARM per tier', () => {
    const ics = icsForDeal({ id: 9, name: 'Brace Rd' }, [
      { id: 1, date_type: 'dd_expiration', due_date: '2026-06-12', warning_tiers: [14, 7] },
    ]);
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /BEGIN:VEVENT/);
    assert.match(ics, /DTSTART;VALUE=DATE:20260612/);
    assert.match(ics, /SUMMARY:Brace Rd — Due Diligence Expiration/);
    assert.match(ics, /TRIGGER:-P14D/);
    assert.match(ics, /TRIGGER:-P7D/);
    assert.match(ics, /END:VCALENDAR/);
  });
});
