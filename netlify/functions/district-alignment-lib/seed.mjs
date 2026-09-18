// district-alignment-lib/seed.mjs — pure seeding logic for the District
// Alignment sandbox draft. Never touches live stores/users data itself;
// it only reads a plain array shaped like it and returns a fresh draft
// object for the caller to persist.

export function buildSeedFromLive(stores) {
  const active = (stores || []).filter(s => s.status !== 'Permanently Closed');

  const draftStores = {};
  active.forEach(s => {
    draftStores[s.pc] = { district: s.district ?? null };
  });

  const byDistrict = new Map();
  active.forEach(s => {
    if (s.district == null) return;
    if (!byDistrict.has(s.district)) {
      byDistrict.set(s.district, { name: s.dmName || '', email: s.dmEmail || '' });
    }
  });
  const dms = Array.from(byDistrict.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([district, info]) => ({
      id: `dm_${district}`,
      name: info.name,
      email: info.email,
      district,
    }));

  return {
    stores: draftStores,
    dms,
    seededFromLiveAt: new Date().toISOString(),
  };
}
