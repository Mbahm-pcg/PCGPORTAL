import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCurrentPayRate, readEmploymentType, transferLetterValues, missingTransferFields, letterFingerprint } from './transfer-notice.mjs';
import { transferBlanks, formatWage, formatLetterDate, TRANSFER_BLANK_FIELDS } from './transfer-notice-pdf.mjs';

test('pickCurrentPayRate: newest rate already in force, ended and future rates skipped', () => {
  const rates = [
    { payRate: 12, effectiveDate: '2025-01-01', endDate: '2026-03-31' },
    { payRate: 15, effectiveDate: '2026-04-01' },
    { payRate: 16, effectiveDate: '2027-01-01' },
  ];
  assert.equal(pickCurrentPayRate(rates, '2026-11-06').payRate, 15);
  assert.equal(pickCurrentPayRate([{ payRate: 14 }], '2026-11-06').payRate, 14);
  assert.equal(pickCurrentPayRate([], '2026-11-06'), null);
});

test('readEmploymentType: finds full/part time in Paycor status/position data, else blank', () => {
  assert.equal(readEmploymentType({ statusData: { employmentType: 'Part-Time' } }), 'Part time');
  assert.equal(readEmploymentType({ positionData: { type: { name: 'Full Time' } } }), 'Full time');
  assert.equal(readEmploymentType({ statusData: { status: 'Active' } }), '');
});

test('transferLetterValues: name, current title and wage come from the Paycor employee', () => {
  const v = transferLetterValues({ employee: { name: 'Ahmed Bhuiyan', jobTitle: 'Crew Member', payRate: 15 }, fromPC: '332941', toPC: '351050', toTitle: 'Shift Leader', employmentType: 'Full time', effectiveDate: '2026-11-16', supervisorName: 'Katiuska Torres', supervisorTitle: 'Store Manager', dmName: 'Tejal', date: '2026-11-06', employeeSig: { image: 'data:e', date: '2026-11-06' }, dmSig: { image: 'data:d', date: '2026-11-06' } });
  assert.equal(v.employeeName, 'Ahmed Bhuiyan');
  assert.equal(v.fromTitle, 'Crew Member');
  assert.equal(v.hourlyWage, 15);
  assert.deepEqual(missingTransferFields(v), []);
  assert.deepEqual(missingTransferFields({ ...v, toPC: '', dmName: ' ' }), ['New store', 'District Manager']);
  assert.deepEqual(missingTransferFields({ ...v, dmSignature: '' }), ['District Manager signature']);
  assert.equal(v.employeeSignedDate, '2026-11-06');
  // a signature vouches for the text: changing any letter field changes the fingerprint, signing does not
  assert.notEqual(letterFingerprint(v), letterFingerprint({ ...v, hourlyWage: 16 }));
  assert.equal(letterFingerprint(v), letterFingerprint({ ...v, dmSignature: 'data:x' }));
});

test('transferLetterValues: a typed current title only counts when Paycor has none', () => {
  const base = { fromPC: '302642', toPC: '351050', date: '2026-11-06' };
  assert.equal(transferLetterValues({ ...base, employee: { name: 'A', jobTitle: 'Crew Member', payRate: 15 }, fromTitle: 'Store Manager' }).fromTitle, 'Crew Member');
  assert.equal(transferLetterValues({ ...base, employee: { name: 'Tanzid Ahmed', jobTitle: '', payRate: 15 }, fromTitle: ' Shift Leader ' }).fromTitle, 'Shift Leader');
  assert.equal(transferLetterValues({ ...base, employee: null, fromTitle: 'Shift Leader' }).fromTitle, '');
});

test('PDF layout: 17 blanks in reading order, two of them drawn signatures', () => {
  const b = transferBlanks();
  assert.equal(b.length, 17);
  assert.equal(TRANSFER_BLANK_FIELDS.length, 17);
  assert.deepEqual(b.map(x => x.field).filter(f => /Signature$/.test(f)), ['employeeSignature', 'dmSignature']);
  assert.equal(b[0].field, 'date');
  assert.equal(b[10].field, 'hourlyWage');
  assert.equal(formatWage(15), '$15.00');
  assert.equal(formatWage(''), '');
  assert.equal(formatLetterDate('2026-11-16'), '11/16/2026');
});
