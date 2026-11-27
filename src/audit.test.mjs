import { test } from 'node:test';
import assert from 'node:assert/strict';
const { auditForm, auditTarget } = await import('../netlify/functions/_shared/audit.mjs');

const capture = () => { const calls = []; const db = (strings, ...vals) => { calls.push({ q: strings.join('?'), vals }); return Promise.resolve([]); }; return { db, calls }; };

test('the line reads: form #id · employee · store', () => {
  assert.match(auditTarget('pay_rate', { id: 23, employee_name: 'Jane Doe', pc: '999999' }), /^Pay Rate Change #23 · Jane Doe · PC 999999$/);
  assert.match(auditTarget('transfer', { id: 4, employee_name: 'Ann', from_pc: '999998' }), /^Transfer Notice #4 · Ann · PC 999998$/);
  assert.equal(auditTarget('unknown_form', { id: 1 }), 'unknown_form #1');
});

test('writes one form line: who, role, form.step, detail', async () => {
  const { db, calls } = capture();
  await auditForm(db, 'pay_rate', 'approved', { id: 23, employee_name: 'Jane Doe', pc: '1', current_rate: 15, new_rate: 16.5 }, { id: 7, role: 'executive', name: 'Mike Bahm' });
  assert.equal(calls.length, 1);
  const [userId, role, action, meta] = calls[0].vals; // 'form' is a literal in the SQL
  assert.match(calls[0].q, /VALUES \('form'/);
  assert.deepEqual([userId, role, action], ['7', 'executive', 'pay_rate.approved']);
  const m = JSON.parse(meta);
  assert.equal(m.byName, 'Mike Bahm');
  assert.equal(m.formId, 23);
  assert.ok(!/16\.5|current_rate|new_rate/.test(meta), 'no pay amounts in the log');
});

test('no login (crew member / employee by link) → named as the employee', async () => {
  const { db, calls } = capture();
  await auditForm(db, 'crew_time_off', 'submitted', { id: 9, employee_name: 'Sam Crew', pc: '1' }, null, { via: 'poster' });
  const [userId, role, action, meta] = calls[0].vals;
  assert.deepEqual([userId, role, action], [null, 'employee', 'crew_time_off.submitted']);
  assert.equal(JSON.parse(meta).byName, 'Sam Crew');
  assert.equal(JSON.parse(meta).via, 'poster');
});

test('a database failure never stops the form, and no row → nothing written', async () => {
  const broken = () => Promise.reject(new Error('db down'));
  await assert.doesNotReject(auditForm(broken, 'transfer', 'sent', { id: 1 }, { id: 1 }));
  const { db, calls } = capture();
  await auditForm(db, 'transfer', 'sent', null, { id: 1 });
  assert.equal(calls.length, 0);
});
