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
  if (draft.dms.some(d => d.district === district)) {
    throw new Error(`District ${district} already has a DM in this draft`);
  }
  const id = `dm_${district}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  return {
    ...draft,
    dms: [...draft.dms, { id, name, email, district }],
  };
}

export function applyRemoveDm(draft, dmId) {
  return {
    ...draft,
    dms: draft.dms.filter(d => d.id !== dmId),
  };
}
