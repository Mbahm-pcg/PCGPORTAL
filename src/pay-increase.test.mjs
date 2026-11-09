import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateProblem, payFormValues, payFingerprint, missingPayFields, payAlertText, payFileName, payEmailHtml } from './pay-increase.mjs';
import { payBlanks, PAY_BLANK_FIELDS, formatRate } from './pay-increase-pdf.mjs';

const emp = { id: 'e1', name: 'Ahmed Bhuiyan', jobTitle: 'Crew Member', payRate: 15 };
const sig = { image: 'data:image/png;base64,x' };

test('new rate must be a real raise', () => {
  assert.equal(rateProblem(15, 16.5), null);
  assert.match(rateProblem(15, 15), /higher/);
  assert.match(rateProblem(15, ''), /Enter/);
  assert.match(rateProblem(null, 16), /no current/);
  assert.match(rateProblem(15, 150), /wrong/);
});

test('locked fields come from Paycor; a typed position only counts when Paycor has none', () => {
  const v = payFormValues({ employee: emp, pc: '332941', position: 'Store Manager', newRate: '16.5', reason: ' Great eval ', date: '2026-11-09' });
  assert.equal(v.position, 'Crew Member');
  assert.equal(v.currentRate, 15); assert.equal(v.newRate, 16.5); assert.equal(v.reason, 'Great eval');
  assert.equal(payFormValues({ employee: { ...emp, jobTitle: '' }, pc: '1', position: ' Shift Leader ' }).position, 'Shift Leader');
  assert.equal(payFormValues({ employee: null, pc: '1', position: 'x' }).pc, '');
});

test('Store Manager + one of DM/Director; signing does not change the fingerprint, editing does', () => {
  const f = { employee: emp, pc: '332941', newRate: 16.5, reason: 'Great eval', date: '2026-11-09' };
  const base = payFormValues(f);
  assert.deepEqual(missingPayFields(base), ['Store Manager signature', 'District Manager or Director signature']);
  assert.deepEqual(missingPayFields(payFormValues({ ...f, smSig: sig, dmSig: sig })), []);
  assert.deepEqual(missingPayFields(payFormValues({ ...f, smSig: sig, directorSig: sig })), []);
  assert.deepEqual(missingPayFields(payFormValues({ ...f, dmSig: sig, directorSig: sig })), ['Store Manager signature']);
  const signed = payFormValues({ ...f, smSig: sig, dmSig: sig, directorSig: sig });
  assert.deepEqual(missingPayFields(signed), []);
  assert.equal(payFingerprint(base), payFingerprint(signed));
  assert.notEqual(payFingerprint(base), payFingerprint({ ...base, newRate: 17 }));
});

test('PDF blanks, file name, alert wording', () => {
  assert.deepEqual(payBlanks().map(b => b.field), PAY_BLANK_FIELDS);
  assert.equal(formatRate(16.5), '$16.50');
  const v = payFormValues({ employee: emp, pc: '332941', newRate: 16.5, reason: 'x <b>', date: '2026-11-09' });
  assert.equal(payFileName(v, 'Bustleton'), 'Pay Increase - Ahmed Bhuiyan - Bustleton - 11-09-2026.pdf');
  const t = payAlertText(v, 'Bustleton', 'Tejal');
  assert.doesNotMatch(t.sms + t.line, /\$/, 'push/SMS/bell never carry pay');
  assert.match(payEmailHtml(v, 'Bustleton', 'Tejal', ''), /\$16\.50.*x &lt;b&gt;/s);
});
