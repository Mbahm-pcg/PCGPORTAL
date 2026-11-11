// node src/time-off-request.test.mjs — rules for Tools · Time Off Request (v22.80).
import assert from 'node:assert/strict';
import { timeOffValues, missingTimeOffFields, timeOffProblem, timeOffFingerprint, timeOffFileName, timeOffAlertText, usTime, defaultPosition, POSITIONS } from './time-off-request.mjs';

const sig = { image: 'data:image/png;base64,xx', date: '2026-11-11' };
const full = {
  email: 'a@b.com', employeeName: 'Jane Doe', address: '1 Main St, Philadelphia PA 19103', phone: '215-555-0100',
  ecName: 'John Doe, spouse', ecPhone: '(215) 555-0101', ecEmail: 'john@x.com', ecAuthorized: false,
  position: POSITIONS[0], location: 'Busleton (PC 123)', startDate: '2026-12-01', startTime: '08:00', returnDate: '2026-12-05', returnTime: '06:30',
  totalHours: '32', leaveType: 'Vacation Time', lastWorked: '2026-11-30', date: '2026-11-11', sig,
};

let v = timeOffValues(full);
assert.deepEqual(missingTimeOffFields(v), []);
assert.equal(timeOffProblem(v), null);
assert.equal(v.ecAuthorized, false); // "No" is an answer, not a blank

assert.ok(missingTimeOffFields(timeOffValues({ ...full, ecAuthorized: undefined })).includes('Emergency contact authorization'));
assert.ok(missingTimeOffFields(timeOffValues({ ...full, phone: '555-01' })).includes('Your phone number'));
assert.ok(missingTimeOffFields(timeOffValues({ ...full, leaveType: 'Other' })).includes('Type of leave (other)'));
assert.ok(missingTimeOffFields(timeOffValues({ ...full, sig: null })).includes('Your signature'));
assert.ok(missingTimeOffFields(timeOffValues({ ...full, leaveType: 'Bogus' })).includes('Type of leave'));
assert.match(timeOffProblem(timeOffValues({ ...full, returnDate: '2026-11-20' })), /back-to-work/);
assert.match(timeOffProblem(timeOffValues({ ...full, lastWorked: '2026-12-02' })), /last date worked/);

// Signing never changes the fingerprint; editing does.
assert.equal(timeOffFingerprint(timeOffValues({ ...full, sig: null })), timeOffFingerprint(v));
assert.notEqual(timeOffFingerprint(timeOffValues({ ...full, totalHours: '40' })), timeOffFingerprint(v));

assert.equal(timeOffFileName(v), 'Time Off Request - Jane Doe - 12-01-2026 to 12-05-2026.pdf');
assert.equal(usTime('00:15'), '12:15 AM');
assert.equal(usTime('13:05'), '1:05 PM');
const t = timeOffAlertText(v);
assert.ok(!t.sms.includes('215-555') && !t.sms.includes('@'), 'alerts carry no contact details');
assert.equal(defaultPosition('manager'), POSITIONS[0]);
assert.equal(defaultPosition('dm'), POSITIONS[3]);
console.log('time-off-request: all passed');
