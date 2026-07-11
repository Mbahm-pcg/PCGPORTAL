const { test, describe } = require('node:test');
const assert = require('node:assert');
const { effectiveAudits } = require('./access');

describe('effectiveAudits', () => {
  // Baseline access (no grant)
  describe('baseline access (grant=null)', () => {
    test('auditor: canView=true, canAudit=true, effUserType=auditor', () => {
      const result = effectiveAudits('auditor', null);
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('executive: canView=true, canAudit=true, effUserType=executive', () => {
      const result = effectiveAudits('executive', null);
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'executive' });
    });
    test('it: canView=true, canAudit=true, effUserType=it', () => {
      const result = effectiveAudits('it', null);
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'it' });
    });
    test('office_staff: canView=true, canAudit=false, effUserType=office_staff', () => {
      const result = effectiveAudits('office_staff', null);
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'office_staff' });
    });
    test('dm: canView=true, canAudit=false, effUserType=dm', () => {
      const result = effectiveAudits('dm', null);
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'dm' });
    });
    test('manager: canView=false, canAudit=false, effUserType=manager', () => {
      const result = effectiveAudits('manager', null);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'manager' });
    });
    test('construction: canView=false, canAudit=false, effUserType=construction', () => {
      const result = effectiveAudits('construction', null);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'construction' });
    });
    test('maintenance: canView=false, canAudit=false, effUserType=maintenance', () => {
      const result = effectiveAudits('maintenance', null);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'maintenance' });
    });
    test('vendor: canView=false, canAudit=false, effUserType=vendor', () => {
      const result = effectiveAudits('vendor', null);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'vendor' });
    });
    test('kiosk_pulse: canView=false, canAudit=false, effUserType=kiosk_pulse', () => {
      const result = effectiveAudits('kiosk_pulse', null);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'kiosk_pulse' });
    });
    test('kiosk_upload: canView=false, canAudit=false, effUserType=kiosk_upload', () => {
      const result = effectiveAudits('kiosk_upload', null);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'kiosk_upload' });
    });
    test('unknown role: canView=false, canAudit=false, effUserType=unknown', () => {
      const result = effectiveAudits('unknown', null);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'unknown' });
    });
    test('undefined role: canView=false, canAudit=false, effUserType=undefined', () => {
      const result = effectiveAudits(undefined, null);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: undefined });
    });
  });

  // grant='view' (read-only elevation)
  describe('grant=\'view\' (read-only elevation)', () => {
    test('auditor: canView=true, canAudit=true (never reduces), effUserType=auditor', () => {
      const result = effectiveAudits('auditor', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('executive: canView=true, canAudit=true (never reduces), effUserType=executive', () => {
      const result = effectiveAudits('executive', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'executive' });
    });
    test('it: canView=true, canAudit=true (never reduces), effUserType=it', () => {
      const result = effectiveAudits('it', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'it' });
    });
    test('office_staff: canView=true, canAudit=false, effUserType=office_staff', () => {
      const result = effectiveAudits('office_staff', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'office_staff' });
    });
    test('dm: canView=true, canAudit=false, effUserType=dm', () => {
      const result = effectiveAudits('dm', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'dm' });
    });
    test('manager: canView=true (elevated), canAudit=false, effUserType=manager', () => {
      const result = effectiveAudits('manager', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'manager' });
    });
    test('construction: canView=true (elevated), canAudit=false, effUserType=construction', () => {
      const result = effectiveAudits('construction', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'construction' });
    });
    test('maintenance: canView=true (elevated), canAudit=false, effUserType=maintenance', () => {
      const result = effectiveAudits('maintenance', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'maintenance' });
    });
    test('vendor: canView=true (elevated), canAudit=false, effUserType=vendor', () => {
      const result = effectiveAudits('vendor', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'vendor' });
    });
    test('kiosk_pulse: canView=true (elevated), canAudit=false, effUserType=kiosk_pulse', () => {
      const result = effectiveAudits('kiosk_pulse', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'kiosk_pulse' });
    });
    test('kiosk_upload: canView=true (elevated), canAudit=false, effUserType=kiosk_upload', () => {
      const result = effectiveAudits('kiosk_upload', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'kiosk_upload' });
    });
    test('unknown role: canView=true (elevated), canAudit=false, effUserType=unknown', () => {
      const result = effectiveAudits('unknown', 'view');
      assert.deepStrictEqual(result, { canView: true, canAudit: false, effUserType: 'unknown' });
    });
  });

  // grant='full' (full audit elevation)
  describe('grant=\'full\' (full audit elevation)', () => {
    test('auditor: canView=true, canAudit=true, effUserType=auditor', () => {
      const result = effectiveAudits('auditor', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('executive: canView=true, canAudit=true, effUserType=executive', () => {
      const result = effectiveAudits('executive', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'executive' });
    });
    test('it: canView=true, canAudit=true, effUserType=it', () => {
      const result = effectiveAudits('it', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'it' });
    });
    test('office_staff: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('office_staff', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('dm: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('dm', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('manager: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('manager', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('construction: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('construction', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('maintenance: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('maintenance', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('vendor: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('vendor', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('kiosk_pulse: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('kiosk_pulse', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('kiosk_upload: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('kiosk_upload', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
    test('unknown role: canView=true, canAudit=true, effUserType=auditor (elevated)', () => {
      const result = effectiveAudits('unknown', 'full');
      assert.deepStrictEqual(result, { canView: true, canAudit: true, effUserType: 'auditor' });
    });
  });

  // Invalid grants treated as null
  describe('invalid grant values treated as null', () => {
    test('grant=\'invalid\' behaves like null', () => {
      const result = effectiveAudits('manager', 'invalid');
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'manager' });
    });
    test('grant=\'\' behaves like null', () => {
      const result = effectiveAudits('manager', '');
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'manager' });
    });
    test('grant=undefined behaves like null', () => {
      const result = effectiveAudits('manager', undefined);
      assert.deepStrictEqual(result, { canView: false, canAudit: false, effUserType: 'manager' });
    });
  });

  // Grants never reduce
  describe('grants never reduce existing access', () => {
    test('auditor+view keeps canAudit=true', () => {
      const result = effectiveAudits('auditor', 'view');
      assert.ok(result.canAudit === true);
    });
    test('executive+view keeps canAudit=true', () => {
      const result = effectiveAudits('executive', 'view');
      assert.ok(result.canAudit === true);
    });
    test('it+view keeps canAudit=true', () => {
      const result = effectiveAudits('it', 'view');
      assert.ok(result.canAudit === true);
    });
    test('office_staff baseline has canView=true, stays true', () => {
      const baseline = effectiveAudits('office_staff', null);
      const withView = effectiveAudits('office_staff', 'view');
      assert.ok(baseline.canView === true);
      assert.ok(withView.canView === true);
      assert.ok(withView.canAudit === baseline.canAudit);
    });
  });
});
