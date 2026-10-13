/**
 * UI-FAST: the configure page's skill loadout, held on screen only: one entry
 * per slot, the equipped skill's id or null. Pure; nothing is saved.
 */
export type Loadout = readonly (string | null)[];

export const emptyLoadout = (slots: number): Loadout => Array.from({ length: slots }, () => null);

export function firstFreeSlot(loadout: Loadout): number | null {
  const i = loadout.indexOf(null);
  return i === -1 ? null : i;
}

/** Where each equipped skill sits, by id. */
export function slotsById(loadout: Loadout): Record<string, number> {
  const out: Record<string, number> = {};
  loadout.forEach((id, i) => {
    if (id !== null) out[id] = i;
  });
  return out;
}

/** A skill already in a slot comes out; otherwise it takes the first free slot, if any. */
export function toggleSkill(loadout: Loadout, id: string): Loadout {
  const at = loadout.indexOf(id);
  if (at !== -1) return removeSlot(loadout, at);
  const free = firstFreeSlot(loadout);
  if (free === null) return loadout;
  return loadout.map((x, i) => (i === free ? id : x));
}

export function removeSlot(loadout: Loadout, slot: number): Loadout {
  return loadout.map((x, i) => (i === slot ? null : x));
}
