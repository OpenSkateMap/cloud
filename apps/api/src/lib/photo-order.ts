export const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** Kept photos in the edit's order only if it reordered them (else the spot's now), new ones where it put them, then those gained since `base`. */
export function mergePhotoOrder<New extends object = never>({
  base,
  edit,
  current,
}: {
  base: readonly string[];
  edit: readonly (string | New)[];
  current: readonly string[];
}): (string | New)[] {
  const onSpot = new Set(current);
  const slots = edit.filter((slot, index) => typeof slot !== "string" || (onSpot.has(slot) && edit.indexOf(slot) === index));
  const kept = slots.filter((slot) => typeof slot === "string");
  const keeps = new Set(kept);
  const reordered = !sameIds(kept, base.filter((id) => keeps.has(id)));
  const keptOrder = reordered ? kept : current.filter((id) => keeps.has(id));
  const placed = slots.reduce<(string | New)[]>((merged, slot, index) => (typeof slot === "string" ? merged : merged.toSpliced(index, 0, slot)), keptOrder);
  const inBase = new Set(base);
  return [...placed, ...current.filter((id) => !inBase.has(id) && !keeps.has(id))];
}
