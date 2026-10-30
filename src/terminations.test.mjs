import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTermination, periodFor, periodContaining, shiftPeriod, groupByStore, countIn } from './terminations.mjs';

test('extractTermination: only non-active people with a termination date', () => {
  const base = { id: 'g1', firstName: 'Sam', lastName: 'Lee', positionData: { jobTitle: 'Crew Member' }, employmentDateData: { hireDate: '2026-01-05T00:00:00Z', terminationDate: '2026-08-14T00:00:00Z' } };
  assert.deepEqual(extractTermination({ ...base, statusData: { status: 'Terminated' } }, 339616),
    { id: 'g1', pc: '339616', name: 'Sam Lee', jobTitle: 'Crew Member', hireDate: '2026-01-05', terminationDate: '2026-08-14', status: 'Terminated' });
  assert.equal(extractTermination({ ...base, statusData: { status: 'Active' } }, 1), null);
  assert.equal(extractTermination({ ...base, statusData: { status: 'Leave of Absence' } }, 1), null);
  assert.equal(extractTermination({ id: 'g2', statusData: { status: 'Terminated' } }, 1), null); // no date → can't place it in a period
  assert.equal(extractTermination({ id: 'g3', statusData: { status: 'Terminated', effectiveDate: '2026-02-02' } }, 1).terminationDate, '2026-02-02');
});

test('periodFor / periodContaining / shiftPeriod: calendar quarters and halves', () => {
  assert.deepEqual([periodFor('quarter', 2026, 3).start, periodFor('quarter', 2026, 3).end], ['2026-07-01', '2026-09-30']);
  assert.deepEqual([periodFor('half', 2026, 1).start, periodFor('half', 2026, 1).end], ['2026-01-01', '2026-06-30']);
  assert.equal(periodFor('quarter', 2024, 1).end, '2024-03-31');
  assert.equal(periodContaining('quarter', '2026-10-27').short, 'Q4 2026');
  assert.equal(periodContaining('half', '2026-10-27').short, 'H2 2026');
  assert.equal(shiftPeriod(periodFor('quarter', 2026, 1), -1).short, 'Q4 2025');
  assert.equal(shiftPeriod(periodFor('half', 2026, 2), 1).short, 'H1 2027');
});

test('groupByStore: per store in the period, busiest first, people by date', () => {
  const rows = [
    { pc: '1', name: 'B', terminationDate: '2026-07-10' }, { pc: '1', name: 'A', terminationDate: '2026-07-02' },
    { pc: '2', name: 'C', terminationDate: '2026-08-01' }, { pc: '2', name: 'D', terminationDate: '2026-06-30' },
  ];
  const g = groupByStore(rows, periodFor('quarter', 2026, 3), [{ pc: '1', name: 'Front', district: 1 }, { pc: '2', name: 'Grant', district: 2 }]);
  assert.deepEqual(g.map(s => [s.name, s.count]), [['Front', 2], ['Grant', 1]]);
  assert.deepEqual(g[0].people.map(p => p.name), ['A', 'B']);
  assert.equal(countIn(rows, periodFor('half', 2026, 1)), 1);
});
