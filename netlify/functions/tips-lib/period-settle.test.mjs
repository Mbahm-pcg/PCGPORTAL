import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isZeroEligibleCrewWithTips,
  deriveWithheldSet,
  computeFinalizeStatuses,
  pickErrorEntries,
} from './period-settle.mjs';

test('isZeroEligibleCrewWithTips: true when crew is empty but real tips were collected', () => {
  assert.equal(isZeroEligibleCrewWithTips({ crewStatus: 'ok', crew: [], tipPool: 12.5 }), true);
});

test('isZeroEligibleCrewWithTips: false when crew has people', () => {
  assert.equal(isZeroEligibleCrewWithTips({ crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 12.5 }), false);
});

test('isZeroEligibleCrewWithTips: false when tipPool rounds to zero', () => {
  assert.equal(isZeroEligibleCrewWithTips({ crewStatus: 'ok', crew: [], tipPool: 0.001 }), false);
});

test('isZeroEligibleCrewWithTips: false when crewStatus is error (a different problem)', () => {
  assert.equal(isZeroEligibleCrewWithTips({ crewStatus: 'error', crew: [], tipPool: 12.5 }), false);
});

test('deriveWithheldSet: picks out only POSSIBLE DROP rows, keyed by pc|busDt', () => {
  const details = [
    { pc: '302642', busDt: '2026-08-23', change: 'added — 7.00h (was missing entirely)' },
    { pc: '310382', busDt: '2026-08-24', change: 'POSSIBLE DROP — missing from live fetch (was 5.00h saved); NOT auto-removed, needs manual review' },
    { pc: '310382', busDt: '2026-08-24', change: 'added — 3.00h (was missing entirely) — NOT APPLIED (withheld: a different employee looked dropped in this same fetch, see below)' },
  ];
  const set = deriveWithheldSet(details);
  assert.equal(set.size, 1);
  assert.equal(set.has('310382|2026-08-24'), true);
  assert.equal(set.has('302642|2026-08-23'), false);
});

test('deriveWithheldSet: empty input gives empty set', () => {
  assert.equal(deriveWithheldSet([]).size, 0);
  assert.equal(deriveWithheldSet(undefined).size, 0);
});

test('pickErrorEntries: finds crewStatus error entries across multiple dates', () => {
  const snapshotByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok' }, { pc: '200', crewStatus: 'error' }]],
    ['2026-08-17', [{ pc: '100', crewStatus: 'error' }, { pc: '200', crewStatus: 'ok' }]],
  ]);
  const result = pickErrorEntries(['2026-08-16', '2026-08-17'], snapshotByDate);
  assert.deepEqual(result, [
    { pc: '200', busDt: '2026-08-16' },
    { pc: '100', busDt: '2026-08-17' },
  ]);
});

test('pickErrorEntries: a date with no saved snapshot is skipped, not an error', () => {
  const snapshotByDate = new Map([['2026-08-16', [{ pc: '100', crewStatus: 'ok' }]]]);
  const result = pickErrorEntries(['2026-08-16', '2026-08-17'], snapshotByDate);
  assert.deepEqual(result, []);
});

test('computeFinalizeStatuses: a fully clean store across the period is finalized', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16', '2026-08-17'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 }]],
    ['2026-08-17', [{ pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 }]],
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.deepEqual(result, { '100': { finalized: true, unresolvedDays: [] } });
});

test('computeFinalizeStatuses: a crew-fetch-error day blocks finalization with the right reason', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'error', crew: [], tipPool: 10 }]],
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.equal(result['100'].finalized, false);
  assert.deepEqual(result['100'].unresolvedDays, [{ busDt: '2026-08-16', reason: 'crew-fetch-error' }]);
});

test('computeFinalizeStatuses: zero-eligible-crew-with-tips blocks finalization', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok', crew: [], tipPool: 19.35 }]],
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.equal(result['100'].finalized, false);
  assert.deepEqual(result['100'].unresolvedDays, [{ busDt: '2026-08-16', reason: 'zero-eligible-crew-with-tips' }]);
});

test('computeFinalizeStatuses: a reconcile-withheld day blocks finalization', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 }]],
  ]);
  const withheldSet = new Set(['100|2026-08-16']);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, withheldSet);
  assert.equal(result['100'].finalized, false);
  assert.deepEqual(result['100'].unresolvedDays, [{ busDt: '2026-08-16', reason: 'reconcile-withheld-possible-drop' }]);
});

test('computeFinalizeStatuses: a missing snapshot for a period date blocks finalization', () => {
  const stores = [{ pc: '100', name: 'Test Store' }];
  const periodDates = ['2026-08-16', '2026-08-17'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [{ pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 }]],
    // 2026-08-17 missing entirely
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.equal(result['100'].finalized, false);
  assert.deepEqual(result['100'].unresolvedDays, [{ busDt: '2026-08-17', reason: 'missing-snapshot' }]);
});

test('computeFinalizeStatuses: stores are evaluated independently', () => {
  const stores = [{ pc: '100', name: 'Clean Store' }, { pc: '200', name: 'Stuck Store' }];
  const periodDates = ['2026-08-16'];
  const snapshotsByDate = new Map([
    ['2026-08-16', [
      { pc: '100', crewStatus: 'ok', crew: [{ name: 'A', hours: 5 }], tipPool: 10 },
      { pc: '200', crewStatus: 'error', crew: [], tipPool: 5 },
    ]],
  ]);
  const result = computeFinalizeStatuses(stores, periodDates, snapshotsByDate, new Set());
  assert.equal(result['100'].finalized, true);
  assert.equal(result['200'].finalized, false);
});
