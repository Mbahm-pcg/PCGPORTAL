import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRates, currentRate, compareToForm, buildNewRate, canMoveEffective, isDueNow, paycorNoticeText } from './pay-rate-paycor.mjs';

test('queue: due today or earlier goes now, later waits', () => {
  assert.equal(isDueNow('2026-11-23', '2026-11-23'), true);
  assert.equal(isDueNow('2026-11-20', '2026-11-23'), true);
  assert.equal(isDueNow('2026-11-30', '2026-11-23'), false);
});

test('notice text says who, the change and the day', () => {
  const row = { employee_name: 'Jane Doe', pc: '1', current_rate: '15', new_rate: '16.5', pay_basis: 'hour', effective_date: '2026-11-30', paycheck_date: '2026-12-11' };
  const q = paycorNoticeText('queued', row, 'Bustleton', { by: 'Roxy' });
  assert.equal(q.line, 'Roxy queued the pay increase for Jane Doe (Bustleton), $15.00/hr to $16.50/hr. It will be updated in Paycor automatically on 11/30/2026, first on the paycheck dated 12/11/2026.');
  assert.match(paycorNoticeText('problem', row, 'Bustleton', { error: 'Paycor said 400' }).line, /not written to Paycor: Paycor said 400/);
  assert.match(paycorNoticeText('moved', { ...row, effective_date: '2026-12-07' }, 'Bustleton', { from: '2026-11-30', by: 'Roxy' }).line, /on 12\/07\/2026 \(was 11\/30\/2026\)/);
});

const hourly = [
  { id: 'a', sequenceNumber: 1, type: 'Hourly', description: 'Regular', payRate: 14, effectiveStartDate: '2025-01-01T00:00:00', effectiveEndDate: '2026-03-31' },
  { id: 'b', sequenceNumber: 1, type: 'Hourly', description: 'Regular', payRate: 15, effectiveStartDate: '2026-04-01T00:00:00' },
];

test('current rate is the one in force today', () => {
  assert.equal(currentRate(hourly, '2026-11-23').id, 'b');
  assert.equal(cleanRates(hourly)[0].effectiveStartDate, '2026-04-01');
});

test('compare: ready / already / mismatch / none', () => {
  const r = currentRate(hourly, '2026-11-23');
  assert.equal(compareToForm(r, { payBasis: 'hour', currentRate: 15, newRate: 16.5 }), 'ready');
  assert.equal(compareToForm(r, { payBasis: 'hour', currentRate: 14.5, newRate: 15 }), 'already');
  assert.equal(compareToForm(r, { payBasis: 'hour', currentRate: 14.5, newRate: 16.5 }), 'mismatch');
  assert.equal(compareToForm(null, { payBasis: 'hour', currentRate: 15, newRate: 16 }), 'none');
});

test('hourly raise: same slot, new rate, effective date', () => {
  const p = buildNewRate(currentRate(hourly, '2026-11-23'), { payBasis: 'hour', newRate: 16.5, effectiveDate: '2026-11-30' }, { formId: 7, approvedBy: 'Mike Bahm' });
  assert.deepEqual({ seq: p.sequenceNumber, type: p.type, rate: p.payRate, start: p.effectiveStartDate, annual: p.annualPayRate },
    { seq: 1, type: 'Hourly', rate: 16.5, start: '2026-11-30T00:00:00', annual: undefined });
  assert.match(p.notes, /#7, approved by Mike Bahm/);
});

test('salary raise scales the per-paycheck rate like today', () => {
  const sal = [{ id: 's', sequenceNumber: 1, type: 'Salary', payRate: 2000, annualPayRate: 52000, effectiveStartDate: '2026-01-01' }];
  const p = buildNewRate(currentRate(sal, '2026-11-23'), { payBasis: 'year', newRate: 54600, effectiveDate: '2026-12-07' });
  assert.equal(p.annualPayRate, 54600);
  assert.equal(p.payRate, 2100);
});

test('effective date moves only while in the future', () => {
  assert.equal(canMoveEffective('2026-11-30', '2026-11-23'), true);
  assert.equal(canMoveEffective('2026-11-23', '2026-11-23'), false);
  assert.equal(canMoveEffective('2026-11-20', '2026-11-23'), false);
});
