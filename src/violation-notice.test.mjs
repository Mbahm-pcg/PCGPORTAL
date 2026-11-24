import { test } from 'node:test';
import assert from 'node:assert/strict';
import { violationValues, missingViolationFields, violationFingerprint, violationAlertText, violationEmailHtml } from './violation-notice.mjs';
import { vioBlanks, VIO_BLANK_FIELDS } from './violation-notice-pdf.mjs';

const sig = { image: 'data:image/png;base64,x', date: '2026-11-10' };
const base = { employee: { name: 'Ahmed Bhuiyan', jobTitle: 'Crew Member' }, pc: '332941', supervisor: 'Dilara Begum', date: '2026-11-10', notice: 'first',
  types: ['tardiness'], action: 'verbal', violationDate: '2026-11-09', description: 'Late for the opening shift.', supervisorName: 'Dilara Begum' };

test('required: description (a sentence), date of violation, notice, type, action, supervisor signature', () => {
  assert.deepEqual(missingViolationFields(violationValues({ ...base, supervisorSig: sig })), []);
  assert.deepEqual(missingViolationFields(violationValues(base)), ['Supervisor signature']);
  const m = missingViolationFields(violationValues({ ...base, description: 'late', violationDate: '', notice: '', types: [], action: '', supervisorSig: sig }));
  assert.deepEqual(m, ['Type of violation notice', 'Type of violation', 'Date of violation', 'Description of violation (at least a sentence)', 'Disciplinary action']);
});
test('suspension needs both dates; a witness signature needs a witness name; employee may refuse', () => {
  assert.ok(missingViolationFields(violationValues({ ...base, action: 'suspension', suspensionStart: '2026-11-11', supervisorSig: sig })).includes('Suspension start and return dates'));
  assert.ok(missingViolationFields(violationValues({ ...base, witnessSig: sig, supervisorSig: sig })).includes('Witness name'));
  const v = violationValues({ ...base, employeeRefused: true, supervisorSig: sig });
  assert.equal(v.employeeRefused, true);
  assert.equal(violationValues({ ...base, employeeRefused: true, employeeSig: sig }).employeeRefused, false, 'a real signature wins over refused');
});
test('only known checkboxes count; suspension dates drop when the action is not suspension', () => {
  const v = violationValues({ ...base, notice: 'fifth', types: ['tardiness', 'bogus', 'tardiness', 'cash'], suspensionStart: '2026-11-11' });
  assert.equal(v.notice, ''); assert.deepEqual(v.types, ['tardiness', 'cash']); assert.equal(v.suspensionStart, '');
});
test('signing does not change what is signed; editing does', () => {
  const a = violationValues(base), b = violationValues({ ...base, supervisorSig: sig });
  assert.equal(violationFingerprint(a), violationFingerprint(b));
  assert.notEqual(violationFingerprint(a), violationFingerprint(violationValues({ ...base, description: 'Something else entirely.' })));
});
test('PDF blanks + alert text (no details in the text) + email', () => {
  assert.equal(vioBlanks().length, VIO_BLANK_FIELDS.length);
  const v = violationValues({ ...base, supervisorSig: sig });
  const t = violationAlertText(v, 'Bustleton', 'Dilara Begum');
  assert.equal(t.line, 'First Violation Notice for Ahmed Bhuiyan (Bustleton), by Dilara Begum.');
  assert.match(violationEmailHtml(v, 'Bustleton', 'Dilara', '', '193884'), /Tardiness\/Leaving Early.*Verbal Warning/s);
});

test('terminated people (last 12 months) join the active roster, tagged', async () => {
  const { withTerminated } = await import('./violation-notice.mjs');
  const stores = { '1': [{ id: 'a', name: 'Ann Active', jobTitle: 'Crew Member' }] };
  const rows = [
    { id: 't', pc: '1', name: 'Tom Gone', jobTitle: 'Crew Member', terminationDate: '2026-11-01' },
    { id: 'a', pc: '1', name: 'Ann Active', terminationDate: '2026-03-01' }, // rehired → stays active
    { id: 'old', pc: '1', name: 'Old Timer', terminationDate: '2024-01-01' }, // too long ago
    { id: 'x', pc: '2', name: 'Other Store', terminationDate: '2026-10-01' },
  ];
  const m = withTerminated(stores, rows, '2026-11-23');
  assert.deepEqual(m['1'].map(e => [e.id, !!e.terminated]), [['a', false], ['t', true]]);
  assert.equal(m['1'][1].terminationDate, '2026-11-01');
  assert.equal(m['2'][0].name, 'Other Store');
  assert.equal(stores['1'].length, 1); // input untouched
});
