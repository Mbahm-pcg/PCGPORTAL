import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, candidateFromSummary, zonedToUtc } from './interview-ics.mjs';

const ICS = [
  'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT',
  'UID:abc-123@paradox.ai', 'SEQUENCE:0',
  'DTSTART;TZID=America/New_York:20261024T110000',
  'DTEND;TZID=America/New_York:20261024T111500',
  'SUMMARY:Your virtual interview with Jordanna G Mormando',
  'LOCATION:https://olivia.paradox.ai/PbqFLWrg',
  'ORGANIZER;CN=Olivia:mailto:olivia338@paradox.ai',
  'DESCRIPTION:Line one\\, with comma\\nline two that is long and gets',
  '  folded onto the next line',
  'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

test('parseIcs: reads a Paradox interview invite (EDT → UTC)', () => {
  const [e] = parseIcs(ICS);
  assert.equal(e.uid, 'abc-123@paradox.ai');
  assert.equal(e.method, 'REQUEST');
  assert.equal(e.start, '2026-10-24T15:00:00.000Z');
  assert.equal(e.end, '2026-10-24T15:15:00.000Z');
  assert.equal(e.summary, 'Your virtual interview with Jordanna G Mormando');
  assert.equal(e.location, 'https://olivia.paradox.ai/PbqFLWrg');
  assert.equal(e.sequence, 0);
  assert.ok(e.description.includes('gets folded onto the next line'));
  assert.ok(e.description.includes('with comma'));
});

test('parseIcs: UTC (Z) times, cancellations and sequence', () => {
  const [e] = parseIcs(['BEGIN:VCALENDAR', 'METHOD:CANCEL', 'BEGIN:VEVENT', 'UID:x', 'SEQUENCE:2', 'STATUS:CANCELLED', 'DTSTART:20261203T160000Z', 'SUMMARY:Interview with Sam Lee', 'END:VEVENT', 'END:VCALENDAR'].join('\n'));
  assert.equal(e.start, '2026-12-03T16:00:00.000Z');
  assert.equal(e.method, 'CANCEL');
  assert.equal(e.status, 'CANCELLED');
  assert.equal(e.sequence, 2);
});

test('zonedToUtc: Eastern standard time (EST) in winter', () => {
  assert.equal(zonedToUtc('20261203T110000', 'America/New_York').toISOString(), '2026-12-03T16:00:00.000Z');
});

test('zonedToUtc: Windows zone name is understood', () => {
  assert.equal(zonedToUtc('20261024T110000', 'Eastern Standard Time').toISOString(), '2026-10-24T15:00:00.000Z');
});

test('candidateFromSummary: pulls the candidate name out of common titles', () => {
  assert.equal(candidateFromSummary('Your virtual interview with Jordanna G Mormando'), 'Jordanna G Mormando');
  assert.equal(candidateFromSummary('Interview with Sam Lee - Crew Member'), 'Sam Lee');
  assert.equal(candidateFromSummary('Team meeting'), null);
});
