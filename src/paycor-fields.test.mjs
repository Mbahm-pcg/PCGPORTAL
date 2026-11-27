import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactsFrom, pickContact, normBadge, badgesFromRecord } from './paycor-fields.mjs';

// Shaped like Paycor's "Get Person by EmployeeID" sample — made-up values.
const person = {
  id: 'p1', firstName: 'Test', lastName: 'Person', socialSecurityNumber: 555555555,
  email: [{ type: 'Work', emailAddress: 'work@example.com' }, { type: 'Home', emailAddress: 'home@example.com' }],
  phones: [{ type: 'Home', areaCode: '215', phoneNumber: '5550100' }, { type: 'Mobile', areaCode: '267', phoneNumber: '555-0199' }],
  demographicData: { birthDate: '1990-03-08' }, bankAccount: { routingNumber: '0310000000' },
};

test('picks the mobile phone and an email', () => {
  const c = pickContact(contactsFrom(person, 'person'));
  assert.equal(c.phone, '2675550199');
  assert.match(c.email, /@example\.com$/);
});

test('NEVER picks up an SSN, birth date or bank number, whatever they look like', () => {
  const all = JSON.stringify(contactsFrom({ ...person, ssn: '2155550123', taxId: '2155550124', phoneSocial: '2155550125' }));
  for (const bad of ['555555555', '1990', '0310000000', '2155550123', '2155550124', '2155550125']) assert.ok(!all.includes(bad), bad);
});

test('nothing there → empty, never an error', () => {
  assert.deepEqual(pickContact(contactsFrom(null)), { phone: '', email: '' });
  assert.deepEqual(pickContact(contactsFrom({ id: 'x', firstName: 'A' })), { phone: '', email: '' });
});

test('11-digit numbers with a leading 1 count; short ones do not', () => {
  assert.equal(pickContact(contactsFrom({ mobilePhone: '+1 (267) 555-0199' })).phone, '2675550199');
  assert.equal(pickContact(contactsFrom({ mobilePhone: '555-0199' })).phone, '');
});

test('badge numbers: time clock first, HR number as backup, leading zeros ignored', () => {
  assert.deepEqual([...badgesFromRecord({ badgeNumber: '332941001', alternateEmployeeNumber: '332941001', employeeNumber: '130' })], ['332941001', '130']);
  assert.equal(normBadge('00130'), '130');
  assert.equal(normBadge(' 332-941-001 '), '332941001');
  assert.equal(badgesFromRecord({}).size, 0);
});
