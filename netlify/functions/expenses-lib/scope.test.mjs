import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIES,
  isValidCategory,
  isFullExpenseAdmin,
  resolveStoreFields,
  canDeleteExpense,
  buildListScope,
} from './scope.mjs';

test('CATEGORIES: exact fixed list of 7', () => {
  assert.deepEqual(CATEGORIES, ['Gas', 'Food', 'Tools', 'Supplies', 'Repairs', 'Office', 'Other']);
});

test('isValidCategory: true for a listed category', () => {
  assert.equal(isValidCategory('Gas'), true);
});

test('isValidCategory: false for an unlisted value', () => {
  assert.equal(isValidCategory('Travel'), false);
});

test('isValidCategory: false for undefined/empty', () => {
  assert.equal(isValidCategory(undefined), false);
  assert.equal(isValidCategory(''), false);
});

test('isFullExpenseAdmin: true for executive, it, office_staff', () => {
  assert.equal(isFullExpenseAdmin('executive'), true);
  assert.equal(isFullExpenseAdmin('it'), true);
  assert.equal(isFullExpenseAdmin('office_staff'), true);
});

test('isFullExpenseAdmin: false for manager, dm, construction, maintenance, vendor', () => {
  assert.equal(isFullExpenseAdmin('manager'), false);
  assert.equal(isFullExpenseAdmin('dm'), false);
  assert.equal(isFullExpenseAdmin('construction'), false);
  assert.equal(isFullExpenseAdmin('maintenance'), false);
  assert.equal(isFullExpenseAdmin('vendor'), false);
});

test('resolveStoreFields: known pc resolves name + district from the map', () => {
  const map = { '340794': { pc: '340794', name: 'Front', district: 1 } };
  assert.deepEqual(resolveStoreFields('340794', map), { storePc: '340794', storeName: 'Front', district: 1 });
});

test('resolveStoreFields: no storePc given → all null (office/exec submission with no store)', () => {
  assert.deepEqual(resolveStoreFields(null, {}), { storePc: null, storeName: null, district: null });
  assert.deepEqual(resolveStoreFields(undefined, {}), { storePc: null, storeName: null, district: null });
});

test('resolveStoreFields: unknown pc keeps the pc but nulls name/district (never invents data)', () => {
  assert.deepEqual(resolveStoreFields('999999', {}), { storePc: '999999', storeName: null, district: null });
});

test('canDeleteExpense: the submitter can delete their own row', () => {
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 42, userType: 'manager' }), true);
});

test('canDeleteExpense: a different non-admin user cannot delete someone else\'s row', () => {
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 7, userType: 'manager' }), false);
});

test('canDeleteExpense: executive/it can delete any row regardless of submitter', () => {
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 7, userType: 'executive' }), true);
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 7, userType: 'it' }), true);
});

test('canDeleteExpense: office_staff (admin view, but NOT delete-any per spec) cannot delete someone else\'s row', () => {
  assert.equal(canDeleteExpense({ submitted_by_user_id: 42 }, { sub: 7, userType: 'office_staff' }), false);
});

test('canDeleteExpense: false for missing row or claims', () => {
  assert.equal(canDeleteExpense(null, { sub: 1, userType: 'executive' }), false);
  assert.equal(canDeleteExpense({ submitted_by_user_id: 1 }, null), false);
});

test('buildListScope: admin (executive) gets no forced user filter, passes through given filters', () => {
  const scope = buildListScope({ sub: 1, userType: 'executive' }, { storePc: '340794', category: 'Gas' });
  assert.deepEqual(scope, { storePc: '340794', district: null, category: 'Gas', dateFrom: null, dateTo: null, forceUserId: null });
});

test('buildListScope: non-admin (manager) is force-scoped to their own user id', () => {
  const scope = buildListScope({ sub: 42, userType: 'manager' }, { storePc: '340794' });
  assert.deepEqual(scope, { storePc: '340794', district: null, category: null, dateFrom: null, dateTo: null, forceUserId: 42 });
});

test('buildListScope: district filter is coerced to a number when present', () => {
  const scope = buildListScope({ sub: 1, userType: 'it' }, { district: '3' });
  assert.equal(scope.district, 3);
});

test('buildListScope: no filters given defaults every optional field to null', () => {
  const scope = buildListScope({ sub: 1, userType: 'it' }, {});
  assert.deepEqual(scope, { storePc: null, district: null, category: null, dateFrom: null, dateTo: null, forceUserId: null });
});

test('buildListScope: admin with filters.mine=true is force-scoped to their own user id ("My receipts" view)', () => {
  const scope = buildListScope({ sub: 99, userType: 'executive' }, { mine: true });
  assert.deepEqual(scope, { storePc: null, district: null, category: null, dateFrom: null, dateTo: null, forceUserId: 99 });
});

test('buildListScope: office_staff with filters.mine=true is force-scoped to their own user id', () => {
  const scope = buildListScope({ sub: 55, userType: 'office_staff' }, { mine: true, storePc: '340794' });
  assert.deepEqual(scope, { storePc: '340794', district: null, category: null, dateFrom: null, dateTo: null, forceUserId: 55 });
});

test('buildListScope: non-admin is still force-scoped even without filters.mine (unaffected by the new flag)', () => {
  const scope = buildListScope({ sub: 42, userType: 'manager' }, { mine: false });
  assert.deepEqual(scope, { storePc: null, district: null, category: null, dateFrom: null, dateTo: null, forceUserId: 42 });
});
