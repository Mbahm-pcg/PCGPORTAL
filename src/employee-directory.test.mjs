import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectoryRows } from './employee-directory.mjs';

const EMP = (over = {}) => ({
  id: 'guid-1', employeeNumber: '67', firstName: 'Jagrutiben', lastName: 'Patel',
  email: { type: 'Work', emailAddress: 'j@example.com' }, statusData: { status: 'Active' },
  ...over,
});

test('buildDirectoryRows: merges DOB from the identifyingData page by employeeId', () => {
  const rows = buildDirectoryRows([EMP()], [{ employeeId: 'guid-1', birthDate: '1990-01-01' }], '337839', '193888');
  assert.deepEqual(rows, [{
    paycorEmployeeId: 'guid-1', employeeNumber: '67', firstName: 'Jagrutiben', lastName: 'Patel',
    email: 'j@example.com', birthDate: '1990-01-01', status: 'Active', storePc: '337839', legalEntityId: '193888',
  }]);
});

test('buildDirectoryRows: an employee with no matching identifyingData record gets birthDate:null, not dropped', () => {
  const rows = buildDirectoryRows([EMP({ id: 'guid-2' })], [], '337839', '193888');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].birthDate, null);
});

test('buildDirectoryRows: an employees-page record with no id is dropped (can\'t key it)', () => {
  const rows = buildDirectoryRows([EMP({ id: null }), EMP()], [], '337839', '193888');
  assert.equal(rows.length, 1);
});

test('buildDirectoryRows: missing email/statusData shape degrades to null, never throws', () => {
  const rows = buildDirectoryRows([EMP({ email: null, statusData: null })], [], '337839', '193888');
  assert.equal(rows[0].email, null);
  assert.equal(rows[0].status, null);
});

test('buildDirectoryRows: a full-timestamp birthDate from Paycor is normalized to a bare yyyy-MM-dd date', () => {
  const rows = buildDirectoryRows([EMP()], [{ employeeId: 'guid-1', birthDate: '2000-03-08T00:00:00' }], '337839', '193888');
  assert.equal(rows[0].birthDate, '2000-03-08');
});

test('buildDirectoryRows: empty employees page returns empty array', () => {
  assert.deepEqual(buildDirectoryRows([], [{ employeeId: 'guid-1', birthDate: '1990-01-01' }], '337839', '193888'), []);
});
