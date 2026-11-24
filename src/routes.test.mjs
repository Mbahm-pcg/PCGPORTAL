import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathForTab, tabForPath } from './routes.mjs';

const TOOLS = new Set(['missing-hours', 'pay-increase', 'transfer-notice']);

test('screens get addresses', () => {
  assert.equal(pathForTab('dashboard', TOOLS), '/');
  assert.equal(pathForTab('__launcher__', TOOLS), '/');
  assert.equal(pathForTab('labor', TOOLS), '/labor');
  assert.equal(pathForTab('missing-hours', TOOLS), '/tools/missing-hours');
  assert.equal(pathForTab('pay-increase', TOOLS), '/tools/pay-rate-change');
  assert.equal(pathForTab('tools-hub', TOOLS), '/tools');
  assert.equal(pathForTab('ops-hub', TOOLS), '/operations');
});

test('addresses lead back to screens, forgivingly', () => {
  assert.equal(tabForPath('/'), 'dashboard');
  assert.equal(tabForPath(''), 'dashboard');
  assert.equal(tabForPath('/labor'), 'labor');
  assert.equal(tabForPath('/Labor/'), 'labor');
  assert.equal(tabForPath('/tools/missing-hours'), 'missing-hours');
  assert.equal(tabForPath('/tool/missing%20hours'), 'missing-hours');
  assert.equal(tabForPath('/tools/pay-rate-change'), 'pay-increase');
  assert.equal(tabForPath('/tools/pay-increase'), 'pay-increase');
  assert.equal(tabForPath('/tools'), 'tools-hub');
  assert.equal(tabForPath('/tool'), 'tools-hub');
  assert.equal(tabForPath('/operations'), 'ops-hub');
});

test('round trip', () => {
  for (const id of ['labor', 'missing-hours', 'pay-increase', 'tools-hub', 'team-hub', 'executive']) assert.equal(tabForPath(pathForTab(id, TOOLS)), id);
});
