// Approvals and Crew Time Off security — the rules where a bug lets the wrong person through.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEAL_SESSION_SECRET = process.env.DEAL_SESSION_SECRET || 'test-secret-for-signing';
const fa = await import('../netlify/functions/_shared/form-approval.mjs');
const crew = await import('../netlify/functions/_shared/crew-time-off-lib.mjs');

// A fake tagged-template db: answers by the SQL text, records nothing.
function fakeDb({ execs = [], users = {} } = {}) {
  return (strings, ...vals) => {
    const q = strings.join('?');
    if (/user_type = 'executive'/.test(q) && /SELECT 1/.test(q)) return Promise.resolve(execs.includes(String(vals[0])) ? [{ 1: 1 }] : []);
    if (/user_type = 'executive'/.test(q)) return Promise.resolve(execs.filter(id => !/id <>/.test(q) || id !== String(vals[0])).map(id => ({ id, email: `${id}@x.com`, phone: `215555000${id}` })));
    if (/SELECT email, phone FROM users/.test(q)) return Promise.resolve(users[String(vals[0])] ? [users[String(vals[0])]] : []);
    return Promise.resolve([]);
  };
}

test('mayDecide: nobody approves their own; an approver approves others', async () => {
  const db = fakeDb({ execs: ['2'] });
  const appr = { ids: ['1'] };
  assert.equal(await fa.mayDecide(db, appr, '5', '1'), true);   // Mike approves Ahmed's
  assert.equal(await fa.mayDecide(db, appr, '1', '1'), false);  // Mike's own
  assert.equal(await fa.mayDecide(db, appr, '5', '2'), false);  // an exec who isn't on the list
  assert.equal(await fa.mayDecide(db, appr, '1', '2'), true);   // Mike is the only approver → another exec covers
  assert.equal(await fa.mayDecide(db, { ids: ['1', '3'] }, '1', '2'), false); // a 2nd approver exists → not the exec
  assert.equal(await fa.mayDecide(db, appr, '5', ''), false);   // not signed in
});

test('the submitter is left out of their own approvers (id, email, number)', () => {
  const appr = { ids: ['1', '3'], emails: ['MIKE@x.com', 'sam@x.com'], phones: ['(215) 555-0001', '2155550003'] };
  const r = fa.withoutSubmitter(appr, '1', { email: 'mike@x.com', phone: '+1 215-555-0001' });
  assert.deepEqual(r.ids, ['3']);
  assert.deepEqual(r.emails, ['sam@x.com']);
  assert.deepEqual(r.phones, ['2155550003']);
  assert.deepEqual(fa.withoutSubmitter(appr, '9', {}).ids, ['1', '3']); // not an approver → nobody removed
});

test('approver titles', () => {
  assert.equal(fa.approverTitle('executive', 'mike.bahm'), 'Vice President');
  assert.equal(fa.approverTitle('executive', 'krunal'), 'Executive');
  assert.equal(fa.approverTitle('it', ''), 'HR / IT Administrator');
});

test('crew poster key: right store only, not guessable', () => {
  const k = crew.posterKey('330563');
  assert.equal(crew.posterOk('330563', k), true);
  assert.equal(crew.posterOk('330564', k), false);   // another store's key
  assert.equal(crew.posterOk('330563', k.slice(0, -1) + (k.endsWith('A') ? 'B' : 'A')), false);
  assert.equal(crew.posterOk('330563', ''), false);
});

test('crew badge pass: 2 hours, one person, one store', () => {
  const p = crew.makePass('330563', 'emp-1');
  assert.equal(crew.passOk(p, '330563', 'emp-1'), true);
  assert.equal(crew.passOk(p, '330563', 'emp-2'), false);  // someone else's form
  assert.equal(crew.passOk(p, '999999', 'emp-1'), false);
  const [, sig] = p.split('.');
  assert.equal(crew.passOk(`${Date.now() - 1000}.${sig}`, '330563', 'emp-1'), false); // expired / tampered time
});

test('crew document links expire and are tied to the request', () => {
  const url = new URL('https://x' + crew.docUrl(7, 0));
  const q = (k) => url.searchParams.get(k);
  assert.equal(crew.docOk(7, 0, q('exp'), q('sig')), true);
  assert.equal(crew.docOk(8, 0, q('exp'), q('sig')), false);
  assert.equal(crew.docOk(7, 1, q('exp'), q('sig')), false);
  assert.equal(crew.docOk(7, 0, String(Date.now() - 1), q('sig')), false);
});

test('links made on a preview stay on that preview; nothing else is trusted', () => {
  assert.equal(crew.baseFor({ url: 'https://6b07284895de9339897927c9--pcg-ops.netlify.app/.netlify/functions/x' }), 'https://6b07284895de9339897927c9--pcg-ops.netlify.app');
  assert.equal(crew.baseFor({ url: 'https://uop.peoplecapitalgroup.com/x' }), fa.PORTAL);
  assert.equal(crew.baseFor({ url: 'https://x--pcg-ops.netlify.app.evil.com/x' }), fa.PORTAL);
  assert.equal(crew.baseFor({ url: 'not a url' }), fa.PORTAL);
});
