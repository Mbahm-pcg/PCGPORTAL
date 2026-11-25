import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionFor, balanceFor, crewValues, missingCrewFields, crewProblem, crewFingerprint, crewFileName, crewSummary } from './crew-time-off.mjs';

const full = {
  employeeName: 'Jane Doe', position: 'Crew Member', location: 'Bustleton', phone: '215-555-0123', ecName: 'Mom', ecPhone: '2155550199', ecAuthorized: true,
  startDate: '2026-12-01', startTime: '09:00', returnDate: '2026-12-02', returnTime: '09:00', totalHours: 8, leaveType: 'Sick Leave', lastWorked: '2026-11-30',
  sig: { image: 'data:image/png;base64,xx', date: '2026-11-25' },
};

test('job title → position', () => {
  assert.equal(positionFor('Crew Member'), 'Crew Member');
  assert.equal(positionFor('Shift Leader'), 'Shift Leader');
  assert.equal(positionFor('Assistant Manager'), 'Store Manager & Asst Manager');
  assert.equal(positionFor(''), 'Crew Member');
});

test('leave type → the right Paycor balance', () => {
  const bal = [{ type: 'Sick Time', current: 16 }, { type: 'Vacation', current: 40 }];
  assert.equal(balanceFor('Sick Leave', bal).current, 16);
  assert.equal(balanceFor('Vacation Time', bal).current, 40);
  assert.equal(balanceFor('Unpaid Leave', bal), null);
});

test('crew: email, address and emergency email are optional; the rest is required', () => {
  assert.deepEqual(missingCrewFields(crewValues(full)), []);
  assert.deepEqual(missingCrewFields(crewValues({ ...full, email: 'nope' })), ['Your email (or leave it empty)']);
  assert.ok(missingCrewFields(crewValues({ ...full, phone: '' })).includes('Your phone number'));
  assert.ok(missingCrewFields(crewValues({ ...full, leaveType: 'Bogus' })).includes('Type of leave'));
  assert.ok(missingCrewFields(crewValues({ ...full, sig: null })).includes('Your signature'));
});

test('date checks', () => {
  assert.equal(crewProblem(crewValues(full), '2026-11-25'), null);
  assert.match(crewProblem(crewValues({ ...full, returnDate: '2026-11-30' }), '2026-11-25'), /back-to-work/);
  assert.match(crewProblem(crewValues({ ...full, startDate: '2026-08-01', lastWorked: '2026-07-30', returnDate: '2026-08-02' }), '2026-11-25'), /60 days/);
});

test('signature fingerprint changes when the request changes', () => {
  const a = crewFingerprint(crewValues(full));
  assert.equal(a, crewFingerprint(crewValues({ ...full, sig: { image: 'other' } })));
  assert.notEqual(a, crewFingerprint(crewValues({ ...full, totalHours: 9 })));
});

test('names and summary', () => {
  assert.equal(crewFileName(crewValues(full)), 'Crew Time Off - Jane Doe - 12-01-2026.pdf');
  assert.equal(crewSummary(crewValues(full)), '12/01/2026 to 12/02/2026, 8 h, Sick Leave');
});
