import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDistrictApply, applyPlanToStores, applyPlanToDistricts, matchDmUser } from './district-apply.mjs';

// Jay (District 2) quits. New DM Farhana takes 3 of his stores in District 2;
// 2 move to Taylor (District 1), the rest to Sonia (District 3).
const liveStores = [
  { pc: '1', name: 'Wadsworth', district: 1, dmName: 'Taylor Cormier' },
  { pc: '2', name: 'Warrington', district: 2, dmName: 'Jay Patel' },
  { pc: '3', name: 'Yardley', district: 2, dmName: 'Jay Patel' },
  { pc: '4', name: 'Sonic', district: 2, dmName: 'Jay Patel' },
  { pc: '5', name: 'Rosemore', district: 2, dmName: 'Jay Patel' },
  { pc: '6', name: 'Grant', district: 2, dmName: 'Jay Patel' },
  { pc: '7', name: 'Hatboro', district: 2, dmName: 'Jay Patel' },
  { pc: '8', name: 'Front', district: 3, dmName: 'Sonia' },
];
const users = [
  { id: 10, name: 'Taylor Cormier', email: 'taylor@x.com', userType: 'dm', district: 1, active: true },
  { id: 11, name: 'Jay Patel', email: 'jay@x.com', userType: 'dm', district: 2, active: true },
  { id: 12, name: 'Sonia Khalique', email: 'sonia@x.com', userType: 'dm', district: 3, active: true },
  { id: 13, name: 'Farhana Khalique', email: 'farhana@x.com', userType: 'dm', district: null, active: true },
  { id: 20, name: 'Some Manager', email: 'm@x.com', userType: 'manager', storePC: '2', active: true },
];
const draft = {
  stores: { 1: { district: 1 }, 2: { district: 2 }, 3: { district: 2 }, 4: { district: 2 }, 5: { district: 1 }, 6: { district: 1 }, 7: { district: 3 }, 8: { district: 3 } },
  dms: [
    { id: 'a', name: 'Taylor Cormier', email: '', district: 1 },
    { id: 'b', name: 'Farhana Khalique', email: 'farhana@x.com', district: 2 },
    { id: 'c', name: 'Sonia', email: '', district: 3 }, // Locations only has her first name
  ],
};

test('planDistrictApply: the Jay → Farhana split', () => {
  const plan = planDistrictApply({ draft, liveStores, users });
  assert.deepEqual(plan.storeMoves.map(m => [m.name, m.from, m.to]), [['Grant', 2, 1], ['Rosemore', 2, 1], ['Hatboro', 2, 3]]);
  assert.deepEqual(plan.dmLinks, [{ userId: 13, name: 'Farhana Khalique', from: null, to: 2 }]);
  assert.deepEqual(plan.dmUnlinks, [{ userId: 11, name: 'Jay Patel', from: 2 }]); // Jay isn't in the plan anymore
  assert.deepEqual(plan.noAccount, []);
  assert.equal(plan.districtDms[2].name, 'Farhana Khalique');
  assert.equal(plan.districtDms[3].email, 'sonia@x.com'); // filled from her account
  assert.equal(plan.hasChanges, true);
});

test('planDistrictApply: a draft identical to live changes nothing', () => {
  const same = { stores: Object.fromEntries(liveStores.map(s => [s.pc, { district: s.district }])), dms: [
    { name: 'Taylor Cormier', district: 1 }, { name: 'Jay Patel', district: 2 }, { name: 'Sonia', district: 3 },
  ] };
  const plan = planDistrictApply({ draft: same, liveStores, users: users.filter(u => u.id !== 13) });
  assert.equal(plan.hasChanges, false);
  assert.deepEqual([plan.storeMoves, plan.dmLinks, plan.dmUnlinks], [[], [], []]);
});

test('planDistrictApply: stores closed since the draft are ignored; Unassigned is district 0', () => {
  const plan = planDistrictApply({ draft: { stores: { 1: { district: 0 }, 99: { district: 4 } }, dms: [] }, liveStores, users: [] });
  assert.deepEqual(plan.storeMoves, [{ pc: '1', name: 'Wadsworth', from: 1, to: 0, editedSinceDraft: false }]);
});

test('planDistrictApply: a draft DM with no portal account is reported, not invented', () => {
  const plan = planDistrictApply({ draft: { stores: { 2: { district: 2 } }, dms: [{ name: 'New Person', email: 'new@x.com', district: 2 }] }, liveStores, users: [] });
  assert.deepEqual(plan.noAccount, [{ name: 'New Person', district: 2 }]);
  assert.deepEqual(plan.dmLinks, []);
  assert.equal(plan.districtDms[2].name, 'New Person');
});

test('planDistrictApply: inactive DMs and other roles are never linked or unlinked', () => {
  const plan = planDistrictApply({ draft: { stores: {}, dms: [] }, liveStores, users: [
    { id: 1, name: 'Old DM', userType: 'dm', district: 4, active: false },
    { id: 2, name: 'Mgr', userType: 'manager', district: 4, active: true },
  ] });
  assert.deepEqual(plan.dmUnlinks, []);
});

test('matchDmUser: email first, then exact name, then first name within the same district', () => {
  const dmUsers = users.filter(u => u.userType === 'dm');
  assert.equal(matchDmUser({ name: 'Whoever', email: 'JAY@x.com', district: 9 }, dmUsers).id, 11);
  assert.equal(matchDmUser({ name: 'taylor  cormier', district: 9 }, dmUsers).id, 10);
  assert.equal(matchDmUser({ name: 'Sonia', district: 3 }, dmUsers).id, 12);
  assert.equal(matchDmUser({ name: 'Sonia', district: 5 }, dmUsers), null); // first name alone needs the same district
});

test('applyPlanToStores / applyPlanToDistricts: what gets written to Locations', () => {
  const plan = planDistrictApply({ draft, liveStores, users });
  const next = applyPlanToStores(liveStores, plan);
  const by = Object.fromEntries(next.map(s => [s.pc, s]));
  assert.equal(by['5'].district, 1); assert.equal(by['5'].dmName, 'Taylor Cormier');
  assert.equal(by['7'].district, 3); assert.equal(by['7'].dmName, 'Sonia');
  assert.equal(by['2'].district, 2); assert.equal(by['2'].dmName, 'Farhana Khalique');
  assert.equal(next[0], liveStores[0]); // untouched store keeps its identity (no needless save)
  const d = applyPlanToDistricts({ 2: { num: 2, name: 'Jay Patel', email: 'jay@x.com', color: 'teal' } }, plan);
  assert.deepEqual(d[2], { num: 2, name: 'Farhana Khalique', email: 'farhana@x.com', color: 'teal' });
  assert.equal(d[1].name, 'Taylor Cormier');
});

test('planDistrictApply: a district with no DM in the plan keeps its linked DM (never unlinked by accident)', () => {
  // Locations had no DM name for District 3, so the sandbox shows it without a DM.
  const plan = planDistrictApply({ draft: { stores: { 8: { district: 3 } }, dms: [] }, liveStores, users });
  assert.deepEqual(plan.dmUnlinks, []);
  assert.deepEqual(plan.keptLinks.find(k => k.district === 3), { name: 'Sonia Khalique', district: 3 });
  assert.equal(plan.districtDms[3].name, 'Sonia Khalique'); // Locations keeps her as DM, not blanked
  assert.equal(applyPlanToStores(liveStores, plan).find(x => x.pc === '8').dmName, 'Sonia Khalique');
  assert.equal(plan.hasChanges, false);
});

test('planDistrictApply: Jay is unlinked only because District 2 goes to someone else', () => {
  const removedOnly = planDistrictApply({ draft: { stores: { 2: { district: 2 } }, dms: [] }, liveStores, users });
  assert.deepEqual(removedOnly.dmUnlinks, []); // Jay removed in the sandbox but nobody replaces him → keep him
  const replaced = planDistrictApply({ draft: { stores: { 2: { district: 2 } }, dms: [{ name: 'Farhana Khalique', email: 'farhana@x.com', district: 2 }] }, liveStores, users });
  assert.deepEqual(replaced.dmUnlinks, [{ userId: 11, name: 'Jay Patel', from: 2 }]);
});

test('planDistrictApply: flags moves of stores edited in Locations after the draft was started', () => {
  const live = [
    { pc: '1', name: 'Old', district: 1, updatedAt: '2026-10-01T10:00:00.000Z' },
    { pc: '2', name: 'New', district: 1, updatedAt: '2026-10-20T10:00:00.000Z' },
  ];
  const plan = planDistrictApply({ draft: { seededFromLiveAt: '2026-10-10T00:00:00.000Z', stores: { 1: { district: 2 }, 2: { district: 2 } }, dms: [] }, liveStores: live, users: [] });
  assert.deepEqual(plan.storeMoves.map(m => [m.name, m.editedSinceDraft]), [['New', true], ['Old', false]]);
});

test('planDistrictApply: real 2026-10-23 bug — Locations says "Jayshilkumar Patel", the account is "Jay Patel"; Jay must NOT be unlinked', () => {
  const plan = planDistrictApply({
    draft: { stores: { 2: { district: 2 }, 3: { district: 2 } }, dms: [{ name: 'Jayshilkumar Patel', email: '', district: 2 }] },
    liveStores, users,
  });
  assert.deepEqual(plan.dmUnlinks, []);
  assert.deepEqual(plan.noAccount, []); // matched to his account by last name in the same district
  assert.equal(plan.hasChanges, false);
});

test('planDistrictApply: a planned DM name matching no account never unlinks the current DM', () => {
  const plan = planDistrictApply({
    draft: { stores: { 2: { district: 2 } }, dms: [{ name: 'Brand New Person', email: 'new@x.com', district: 2 }] },
    liveStores, users,
  });
  assert.deepEqual(plan.dmUnlinks, []);
  assert.deepEqual(plan.noAccount, [{ name: 'Brand New Person', district: 2, keeps: 'Jay Patel' }]);
  assert.equal(plan.districtDms[2].name, 'Jay Patel'); // Locations keeps matching the linked account
});

test('matchDmUser: "Also known as" names match the account, in any district', () => {
  const dmUsers = [
    { id: 11, name: 'Jay Patel', email: 'jay@x.com', userType: 'dm', district: null, aliases: 'Jayshilkumar Patel, JP' },
    { id: 13, name: 'Farhana Khalique', email: 'farhana@x.com', userType: 'dm', district: null, aliases: 'Sonia' },
  ];
  assert.equal(matchDmUser({ name: 'jayshilkumar  patel', district: 2 }, dmUsers).id, 11);
  assert.equal(matchDmUser({ name: 'Sonia', district: 3 }, dmUsers).id, 13);
  assert.equal(matchDmUser({ name: 'Sonia Smith', district: 3 }, dmUsers), null);
});

test('planDistrictApply: with aliases set, the Jay/Farhana Locations names re-link instead of unlink', () => {
  const u2 = [
    { id: 11, name: 'Jay Patel', email: 'jay@x.com', userType: 'dm', district: null, active: true, aliases: 'Jayshilkumar Patel' },
    { id: 13, name: 'Farhana Khalique', email: 'farhana@x.com', userType: 'dm', district: null, active: true, aliases: 'Sonia' },
  ];
  const plan = planDistrictApply({ draft: { stores: { 2: { district: 2 }, 8: { district: 3 } }, dms: [
    { name: 'Jayshilkumar Patel', district: 2 }, { name: 'Sonia', district: 3 },
  ] }, liveStores, users: u2 });
  assert.deepEqual(plan.dmLinks.map(l => [l.name, l.to]), [['Jay Patel', 2], ['Farhana Khalique', 3]]);
  assert.deepEqual(plan.dmUnlinks, []);
  assert.deepEqual(plan.noAccount, []);
});
