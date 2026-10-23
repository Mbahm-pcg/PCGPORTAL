// district-alignment-lib/reducers.mjs — pure edit operations on a District
// Alignment draft. Each function returns a NEW draft; none mutate their
// input, so the caller (district-alignment.mjs) can safely pass the
// in-memory draft it just loaded without worrying about aliasing.

export function applyReassignStore(draft, pc, district) {
  return {
    ...draft,
    stores: {
      ...draft.stores,
      [pc]: { ...(draft.stores[pc] || {}), district },
    },
  };
}

export function applyAddDm(draft, { name, email, district }) {
  const existing = draft.dms.find(d => d.district === district);
  if (existing) {
    throw new Error(`District ${district} already has a DM in this draft (${existing.name || 'unnamed'}) — use "Change district manager" on its row to replace them.`);
  }
  const id = `dm_${district}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    ...draft,
    dms: [...draft.dms, { id, name, email, district }],
  };
}

// Swap a district's DM in one step (v22.14) — e.g. Jay leaves, the new DM takes
// District 2. Works whether or not the district had a DM.
export function applyReplaceDm(draft, { name, email, district }) {
  return applyAddDm({ ...draft, dms: draft.dms.filter(d => d.district !== district) }, { name, email, district });
}

export function applyRemoveDm(draft, dmId) {
  return {
    ...draft,
    dms: draft.dms.filter(d => d.id !== dmId),
  };
}
