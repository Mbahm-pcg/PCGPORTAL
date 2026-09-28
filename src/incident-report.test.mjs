import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EVIDENCE_ITEMS, buildEvidenceList, autofillFromStore,
  splitPeopleForPdf, buildSubjectEmployeeParty, canViewReport, filterVisibleReports,
} from './incident-report.mjs';

test('buildEvidenceList: keeps default items with their checked state, appends custom labels as checked', () => {
  const checkedIds = DEFAULT_EVIDENCE_ITEMS.filter(i => i.defaultChecked).map(i => i.id);
  const result = buildEvidenceList(checkedIds, ['Broken equipment photo']);
  assert.equal(result.length, DEFAULT_EVIDENCE_ITEMS.length + 1);
  const custom = result.find(r => r.label === 'Broken equipment photo');
  assert.ok(custom && custom.checked === true);
});

test('buildEvidenceList: unchecking a default item is respected', () => {
  const result = buildEvidenceList([], []);
  assert.ok(result.every(r => r.checked === false));
});

test('buildEvidenceList: blank/whitespace-only custom labels are dropped', () => {
  const result = buildEvidenceList([], ['  ', '', 'Real note']);
  assert.equal(result.filter(r => !DEFAULT_EVIDENCE_ITEMS.some(d => d.label === r.label)).length, 1);
});

test('autofillFromStore: pulls PC#, address, and legal entity name from a store record', () => {
  const store = { pc: '337839', name: 'Warrington', address: '334 Easton Rd', city: 'Warrington', state: 'PA', zip: '18976', legal: '334 Warrington Hospitality LLC' };
  const result = autofillFromStore(store);
  assert.deepEqual(result, {
    storePC: '337839', storeName: 'Warrington',
    address: '334 Easton Rd, Warrington, PA 18976',
    operatingEntity: '334 Warrington Hospitality LLC',
  });
});

test('autofillFromStore: null store returns blank fields, never throws', () => {
  const result = autofillFromStore(null);
  assert.deepEqual(result, { storePC: '', storeName: '', address: '', operatingEntity: '' });
});

test('splitPeopleForPdf: one merged list becomes a parties list and a contact list', () => {
  const people = [
    { name: 'Priti Khetani', role: 'Tripped over her leg', phone: '(267) 632-3973', email: 'priteeuk510@gmail.com' },
    { name: 'Rasheena Bruce', role: 'Called 911', phone: '(267) 325-8270', email: 'rasheenabruce80@gmail.com' },
  ];
  const { parties, contacts } = splitPeopleForPdf(people);
  assert.deepEqual(parties, [
    { name: 'Priti Khetani', role: 'Tripped over her leg' },
    { name: 'Rasheena Bruce', role: 'Called 911' },
  ]);
  assert.deepEqual(contacts, [
    { name: 'Priti Khetani', phone: '(267) 632-3973', email: 'priteeuk510@gmail.com' },
    { name: 'Rasheena Bruce', phone: '(267) 325-8270', email: 'rasheenabruce80@gmail.com' },
  ]);
});

test('splitPeopleForPdf: rows with no name are skipped from both lists', () => {
  const { parties, contacts } = splitPeopleForPdf([{ name: '  ', role: 'x', phone: '1', email: 'a@b.com' }]);
  assert.equal(parties.length, 0);
  assert.equal(contacts.length, 0);
});

test('buildSubjectEmployeeParty: builds an "Injured employee" party from the employee fields', () => {
  const report = { employeeName: 'Kirtida Singh', employeePhone: '(215) 485-0149', employeeEmail: 'k@example.com' };
  assert.deepEqual(buildSubjectEmployeeParty(report), {
    name: 'Kirtida Singh', role: 'Injured employee', phone: '(215) 485-0149', email: 'k@example.com',
  });
});

test('buildSubjectEmployeeParty: no employee name means no party (returns null)', () => {
  assert.equal(buildSubjectEmployeeParty({ employeeName: '  ' }), null);
  assert.equal(buildSubjectEmployeeParty({}), null);
});

test('canViewReport: exec/IT can view any report', () => {
  const report = { preparedByUserId: '999' };
  assert.equal(canViewReport(report, { userType: 'executive', sub: '1' }), true);
  assert.equal(canViewReport(report, { userType: 'it', sub: '1' }), true);
});

test('canViewReport: the author can view their own report', () => {
  const report = { preparedByUserId: '42' };
  assert.equal(canViewReport(report, { userType: 'manager', sub: '42' }), true);
});

test('canViewReport: a different non-exec/IT user cannot view someone else\'s report', () => {
  const report = { preparedByUserId: '42' };
  assert.equal(canViewReport(report, { userType: 'manager', sub: '7' }), false);
});

test('filterVisibleReports: exec/IT gets every report, others get only their own', () => {
  const reports = [{ preparedByUserId: '1' }, { preparedByUserId: '2' }];
  assert.equal(filterVisibleReports(reports, { userType: 'it', sub: '9' }).length, 2);
  assert.equal(filterVisibleReports(reports, { userType: 'manager', sub: '2' }).length, 1);
});
