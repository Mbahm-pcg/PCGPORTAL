import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDistricts, formatDistricts, pickViewDistrict, directorView, isDirector } from './director-scope.mjs';
import requireUserLib from '../netlify/functions/auth-lib/require-user.js';

test('parseDistricts / formatDistricts: clean, unique, sorted', () => {
  assert.deepEqual(parseDistricts('9, 3,3 x 0 -1'), [3, 9]);
  assert.deepEqual(parseDistricts([2, '7', null]), [2, 7]);
  assert.deepEqual(parseDistricts(null), []);
  assert.equal(formatDistricts([9, 3]), '3,9');
  assert.equal(formatDistricts([]), null);
});

test('pickViewDistrict: only ever one of their own districts', () => {
  assert.equal(pickViewDistrict('3,9', 9), 9);
  assert.equal(pickViewDistrict('3,9', '9'), 9);
  assert.equal(pickViewDistrict('3,9', 5), 3); // not theirs → first of theirs
  assert.equal(pickViewDistrict('3,9', null), 3);
  assert.equal(pickViewDistrict(null, 5), null);
});

test('directorView: a Director viewing a district looks like that district\'s DM', () => {
  const d = { id: 1, userType: 'director', districts: [3, 9], district: null };
  const v = directorView(d, 9);
  assert.equal(v.userType, 'dm');
  assert.equal(v.realUserType, 'director');
  assert.equal(v.district, 9);
  assert.deepEqual(directorView(v, 3).district, 3); // idempotent re-derive
  assert.equal(directorView(v, 5).district, 3); // can't reach a district that isn't theirs
  assert.equal(directorView({ userType: 'director', districts: [] }, 3).userType, 'director'); // no districts → no DM scope
  const dm = { userType: 'dm', district: 2 };
  assert.equal(directorView(dm, 9), dm); // everyone else untouched
  assert.ok(isDirector(v));
  assert.ok(!isDirector(dm));
});

test('require-user: server mask honours only the Director\'s own districts', () => {
  const { applyDirectorScope } = requireUserLib;
  const mk = () => ({ userType: 'director', districts: [3, 9], district: null });
  const a = applyDirectorScope(mk(), 'pcg_session=x; pcg_view_district=9');
  assert.deepEqual([a.userType, a.realUserType, a.district], ['dm', 'director', 9]);
  assert.equal(applyDirectorScope(mk(), 'pcg_view_district=5').district, 3);
  assert.equal(applyDirectorScope(mk(), '').district, 3);
  const none = applyDirectorScope({ userType: 'director', districts: [] }, 'pcg_view_district=3');
  assert.equal(none.userType, 'director');
  assert.equal(none.district, null);
  const dm = { userType: 'dm', district: 2 };
  assert.equal(applyDirectorScope(dm, 'pcg_view_district=9').district, 2);
});
