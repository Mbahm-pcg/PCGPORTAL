import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHireSubject, isRecentHire, htmlToText, extractDetails, buildHireEmail } from './ally-hires.mjs';

test('parseHireSubject: the real Ally subject, and variations', () => {
  assert.equal(parseHireSubject("Dunkin': Niraj Bhatt is Officially Hired!"), 'Niraj Bhatt');
  assert.equal(parseHireSubject('Dunkin’: Ana  Maria Lopez is officially hired'), 'Ana Maria Lopez');
  assert.equal(parseHireSubject('Niraj Bhatt is Officially Hired!'), 'Niraj Bhatt');
  assert.equal(parseHireSubject("Dunkin' Reminder: Keith Leva's Completed Interview"), null);
  assert.equal(parseHireSubject('Your virtual interview with Sam Lee'), null);
});

test('isRecentHire: only the last 48h is notified (no two-week backlog on the first run)', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(isRecentHire(now - 3 * 3600000, now), true);
  assert.equal(isRecentHire(now - 49 * 3600000, now), false);
  assert.equal(isRecentHire(NaN, now), false);
});

test('htmlToText + extractDetails: pulls labelled details out of an HTML email', () => {
  const text = htmlToText('<div><p>Congrats!</p><p><b>Position:</b> Crew Member</p><p>Start Date: 10/28/2026</p><p>Location &amp; Store: x</p></div>');
  assert.match(text, /Position: Crew Member/);
  assert.deepEqual(extractDetails(text), [{ label: 'Position', value: 'Crew Member' }, { label: 'Start Date', value: '10/28/2026' }]);
  assert.deepEqual(extractDetails('nothing labelled here'), []);
});

test('buildHireEmail: name, property, PC#, address, district/DM; test label; HTML escaped', () => {
  const store = { pc: '339616', name: 'Wadsworth', legal: 'KJ Donuts Inc.', address: '1630 W Wadsworth Ave', city: 'Philadelphia', state: 'PA', district: 1, dmName: 'Taylor Cormier' };
  const e = buildHireEmail({ candidate: 'Niraj <b>Bhatt</b>', store, receivedAt: '2026-10-24T13:23:00Z', details: [{ label: 'Position', value: 'Crew' }], testLabel: 'exec + IT' });
  assert.equal(e.subject, '[TEST] New hire: Niraj <b>Bhatt</b> — Wadsworth (PC# 339616)');
  assert.match(e.html, /Niraj &lt;b&gt;Bhatt&lt;\/b&gt;/);
  assert.match(e.html, /1630 W Wadsworth Ave, Philadelphia, PA/);
  assert.match(e.html, /District 1 · DM Taylor Cormier/);
  assert.match(e.html, /Test mode — would go to: exec \+ IT/);
  assert.match(e.text, /Position: Crew/);
  assert.match(e.text, /Hired \(Ally\): Sat, Oct 24, 9:23 AM ET/);
});
