import { test, describe } from 'node:test';
import assert from 'node:assert';
import { canViewPnl, canManagePnlAccess, pnlIds, DEFAULT_PNL_ALLOWED } from './pnl-access.mjs';

const mike   = { username: 'mike.bahm', email: 'Mike@PeopleCapitalGroup.com' };
const ahmed1 = { username: 'ahmed', email: 'ahmed@Peoplecapitalgroup.com' };
const ahmed2 = { username: 'ahmed@peoplecapitalgroup.com', email: '' };
const krunal1 = { username: 'Krunal', email: '' };
const krunal2 = { username: 'Krunal@Raogroupinc.com', email: 'Krunal@Raogroupinc.com' };
const taylor = { username: 'taylor.cormier', email: 'taylor@peoplecapitalgroup.com', userType: 'dm' };
const office = { username: 'office.staff', email: '', userType: 'office_staff' };

describe('canManagePnlAccess', () => {
  test('Mike & Ahmed (both username variants) can manage', () => {
    assert.ok(canManagePnlAccess(mike));
    assert.ok(canManagePnlAccess(ahmed1));
    assert.ok(canManagePnlAccess(ahmed2));
  });
  test('Krunal CANNOT manage (view-only grantee)', () => {
    assert.ok(!canManagePnlAccess(krunal1));
    assert.ok(!canManagePnlAccess(krunal2));
  });
  test('other users cannot manage', () => {
    assert.ok(!canManagePnlAccess(taylor));
    assert.ok(!canManagePnlAccess(office));
    assert.ok(!canManagePnlAccess(null));
  });
});

describe('canViewPnl', () => {
  test('managers always view, regardless of list', () => {
    assert.ok(canViewPnl(mike, []));
    assert.ok(canViewPnl(ahmed1, []));
  });
  test('Krunal views via default allow list (both identity variants, case-insensitive)', () => {
    assert.ok(canViewPnl(krunal1, DEFAULT_PNL_ALLOWED));
    assert.ok(canViewPnl(krunal2, DEFAULT_PNL_ALLOWED));
  });
  test('non-listed users cannot view', () => {
    assert.ok(!canViewPnl(taylor, DEFAULT_PNL_ALLOWED));
    assert.ok(!canViewPnl(office, DEFAULT_PNL_ALLOWED));
    assert.ok(!canViewPnl(null, DEFAULT_PNL_ALLOWED));
  });
  test('a granted user matches by email or username, case-insensitively', () => {
    assert.ok(canViewPnl(taylor, ['TAYLOR@peoplecapitalgroup.com'])); // by email, upper
    assert.ok(canViewPnl(taylor, ['taylor.cormier']));                // by username
    assert.ok(!canViewPnl(taylor, ['someone.else']));
  });
  test('empty / nullish allowed list → only managers', () => {
    assert.ok(canViewPnl(mike, null));
    assert.ok(!canViewPnl(taylor, null));
    assert.ok(!canViewPnl(taylor, undefined));
  });
});

describe('pnlIds', () => {
  test('lowercases username + email, drops falsy', () => {
    assert.deepStrictEqual(pnlIds(mike), ['mike.bahm', 'mike@peoplecapitalgroup.com']);
    assert.deepStrictEqual(pnlIds(krunal1), ['krunal']);
    assert.deepStrictEqual(pnlIds(null), []);
  });
});
