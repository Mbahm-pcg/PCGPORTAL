import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateProblem, payFormValues, payFingerprint, missingPayFields, signatureProblem, secondLineLabel, storeManagerNa, signerCode, payAlertText, payFileName, payEmailHtml, approvalAlertText, approvalEmailHtml } from './pay-increase.mjs';
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

test('signatures follow who makes the form', () => {
  const f = { employee: emp, pc: '332941', newRate: 16.5, reason: 'Great eval', date: '2026-11-09', smName: 'Dilara Begum', dmName: 'Nusrat Tanjin' };
  const v = (x) => payFormValues({ ...f, ...x });
  // the second line's title, and the N/A Store Manager line
  assert.equal(secondLineLabel('manager'), 'District Manager');
  assert.equal(secondLineLabel('dm'), 'District Manager');
  assert.equal(secondLineLabel('director'), 'Director of Operations');
  assert.equal(secondLineLabel('executive', 'mike.bahm'), 'Vice President');
  assert.equal(secondLineLabel('executive', 'krunal'), 'Executive');
  assert.equal(secondLineLabel('it'), 'District Manager');
  assert.deepEqual(['manager', 'dm', 'director', 'executive'].map(storeManagerNa), [false, true, true, true]);
  assert.deepEqual([['manager'], ['dm'], ['director'], ['executive', 'mike.bahm'], ['executive', 'x']].map(a => signerCode(...a)), ['sm_dm', 'dm', 'director', 'vp', 'exec']);
  // Store Manager makes it: Store Manager + District Manager both sign
  assert.deepEqual(missingPayFields(v({}), 'manager'), ['Store Manager signature', 'District Manager signature']);
  assert.deepEqual(missingPayFields(v({ smSig: sig, dmSig: sig }), 'manager'), []);
  assert.equal(signatureProblem('manager', v({ smSig: sig, dmSig: sig })), null);
  assert.match(signatureProblem('manager', v({ smSig: sig })), /both/);
  // DM / Director / exec: Store Manager line N/A, they sign the second line
  assert.deepEqual(missingPayFields(v({ smNa: true }), 'dm'), ['Your signature']);
  assert.equal(signatureProblem('dm', v({ smNa: true, dmSig: sig })), null);
  assert.equal(signatureProblem('director', v({ smNa: true, dmSig: sig, secondLabel: 'Director of Operations' })), null);
  assert.match(signatureProblem('dm', v({ dmSig: sig })), /N\/A/);
  assert.match(signatureProblem('executive', { ...v({ smNa: true, dmSig: sig }), smSignature: sig.image }), /N\/A/, 'a forged Store Manager signature on an N/A form is refused');
  assert.equal(v({ smSig: sig, smNa: true }).smSignature, '', 'N/A wins over a stale signature');
  // signing doesn't change what was signed; editing does
  assert.equal(payFingerprint(v({})), payFingerprint(v({ smSig: sig })));
  assert.notEqual(payFingerprint(v({})), payFingerprint({ ...v({}), newRate: 17 }));
});

test('approval messages: the request text has a link-ready line and never a pay rate', () => {
  const r = { id: 7, employee_name: 'Ahmed Bhuiyan', pc: '332941', submitted_by_name: 'Nusrat Tanjin' };
  const t = approvalAlertText('request', r, 'Bustleton');
  assert.match(t.line, /Nusrat Tanjin sent a pay increase for Ahmed Bhuiyan \(Bustleton\) for your approval/);
  assert.doesNotMatch(t.sms + t.line, /\$/);
  assert.match(approvalAlertText('rejected', r, 'Bustleton', { by: 'Mike Bahm', note: 'Wait for the review' }).line, /Mike Bahm sent back.*Wait for the review/);
  const v = payFormValues({ employee: emp, pc: '332941', newRate: 16.5, reason: 'x', date: '2026-11-09' });
  const html = approvalEmailHtml(v, 'Bustleton', 'Nusrat', 'https://uop.peoplecapitalgroup.com/?payIncrease=7', '193884');
  assert.match(html, /\$16\.50/); assert.match(html, /\?payIncrease=7/); assert.match(html, /Client ID 193884/);
  assert.match(payEmailHtml({ ...v, signer: 'sm' }, 'Bustleton', 'Nusrat', '', '193884', 'Mike Bahm'), /signed by the Store Manager and approved by Mike Bahm/);
  assert.match(payEmailHtml({ ...v, signer: 'vp' }, 'Bustleton', 'Mike', '', '', 'Mike Bahm'), /signed by the Vice President/);
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

test('the reason is required: empty or a token word is refused, a sentence is fine', () => {
  const f = { employee: emp, pc: '332941', newRate: 16.5, date: '2026-11-09', smSig: sig, dmSig: sig, smName: 'A B', dmName: 'C D' };
  const role = 'manager';
  const need = 'Reason for the pay change (at least a sentence)';
  assert.ok(missingPayFields(payFormValues({ ...f, reason: '' }), role).includes(need));
  assert.ok(missingPayFields(payFormValues({ ...f, reason: '   ok   ' }), role).includes(need));
  assert.deepEqual(missingPayFields(payFormValues({ ...f, reason: 'Passed her 90-day review.' }), role), []);
});

test('a printed name goes with every signature (none on an N/A line)', () => {
  const f = { employee: emp, pc: '332941', newRate: 16.5, reason: 'Great eval', date: '2026-11-09', smSig: sig, dmSig: sig };
  assert.deepEqual(missingPayFields(payFormValues({ ...f, smName: ' ', dmName: 'Nusrat' }), 'manager'), ['Store Manager name']);
  assert.match(signatureProblem('manager', payFormValues({ ...f, smName: 'A', dmName: '' })), /name/);
  const dm = payFormValues({ ...f, smSig: null, smNa: true, smName: 'stale', dmName: 'Nusrat Tanjin' });
  assert.equal(dm.smName, '', 'no name on an N/A line');
  assert.deepEqual(missingPayFields(dm, 'dm'), []);
  assert.deepEqual(missingPayFields({ ...dm, dmName: '' }, 'dm'), ['Your name']);
  assert.notEqual(payFingerprint(dm), payFingerprint({ ...dm, dmName: 'Someone Else' }), 'changing a name voids the signatures');
});

test('salaried employees (Store Managers): yearly salary, raise checked against it, shown per year', async () => {
  const { payBasisOf, currentPayOf, fmtPay } = await import('./pay-increase.mjs');
  const mgr = { name: 'Joseph Allen', jobTitle: 'Store Managers', payType: 'Salary', payRate: 2000, annualPayRate: 52000 };
  assert.equal(payBasisOf(mgr), 'year'); assert.equal(currentPayOf(mgr), 52000);
  assert.equal(payBasisOf(emp), 'hour'); assert.equal(currentPayOf(emp), 15);
  const v = payFormValues({ employee: mgr, pc: '353047', newRate: 55000, reason: 'Great year', date: '2026-11-10' });
  assert.equal(v.currentRate, 52000); assert.equal(v.payBasis, 'year');
  assert.equal(rateProblem(52000, 55000, 'year'), null);
  assert.match(rateProblem(52000, 2100, 'year'), /higher than the current \$52,000\.00 \/ year/);
  assert.match(rateProblem(52000, 900000, 'year'), /wrong/);
  assert.equal(fmtPay(52000, 'year'), '$52,000.00 / year'); assert.equal(fmtPay(15, 'hour'), '$15.00 / hour');
  assert.notEqual(payFingerprint(v), payFingerprint({ ...v, payBasis: 'hour' }));
});
