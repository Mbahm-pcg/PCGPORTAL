import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueReminder, reminderText } from './interview-reminders.mjs';

const H = 3600000;
const start = Date.parse('2026-10-24T15:00:00Z'); // 11:00 AM ET, Sat Oct 24
const iv = { start: new Date(start).toISOString(), status: 'active', candidate: 'Jordanna G Mormando', summary: 'Your virtual interview with Jordanna G Mormando', link: 'https://olivia.paradox.ai/PbqFLWrg' };

test('dueReminder: day-before reminder inside 24h, during waking hours', () => {
  assert.equal(dueReminder(iv, start - 20 * H, 15), 'day');
});

test('dueReminder: day-before reminder waits for 8am ET', () => {
  assert.equal(dueReminder(iv, start - 20 * H, 6), null);
});

test('dueReminder: nothing more than 24h out', () => {
  assert.equal(dueReminder(iv, start - 30 * H, 12), null);
});

test('dueReminder: hour reminder within ~1 hour, any time of day', () => {
  assert.equal(dueReminder({ ...iv, sentDayAt: 'x' }, start - 50 * 60000, 2), 'hour');
});

test('dueReminder: short-notice interviews skip the day reminder', () => {
  assert.equal(dueReminder(iv, start - 90 * 60000, 12), null);
  assert.equal(dueReminder(iv, start - 30 * 60000, 12), 'hour');
});

test('dueReminder: never twice, never for cancelled or past interviews', () => {
  assert.equal(dueReminder({ ...iv, sentHourAt: 'x', sentDayAt: 'x' }, start - 30 * 60000, 12), null);
  assert.equal(dueReminder({ ...iv, status: 'cancelled' }, start - 20 * H, 12), null);
  assert.equal(dueReminder(iv, start + 60000, 12), null);
});

test('reminderText: wording for the day and hour reminders', () => {
  const day = reminderText('day', iv, start - 20 * H, { storeName: 'Front' });
  assert.equal(day, 'Reminder: tomorrow at 11:00 AM you have a virtual interview with Jordanna G Mormando (Front). Join: https://olivia.paradox.ai/PbqFLWrg');
  const hour = reminderText('hour', iv, start - 60 * 60000, { storeName: 'Front', includeLink: false });
  assert.equal(hour, 'Interview in 60 min (11:00 AM): virtual interview with Jordanna G Mormando (Front).');
});
