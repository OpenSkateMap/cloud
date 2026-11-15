import { describe, expect, test } from "bun:test";
import { mergePhotoOrder } from "../src/lib/photo-order.ts";
import { SpotEditDraftSchema } from "../src/lib/submission-schemas.ts";

const added = (name: string) => ({ added: name });

describe("mergePhotoOrder", () => {
  test("an edit reorders, removes and adds the spot's photos", () => {
    expect(mergePhotoOrder({ base: ["a", "b", "c"], edit: ["c", "a", "b"], current: ["a", "b", "c"] })).toEqual(["c", "a", "b"]);
    expect(mergePhotoOrder({ base: ["a", "b", "c"], edit: ["a", "c"], current: ["a", "b", "c"] })).toEqual(["a", "c"]);
    expect(mergePhotoOrder({ base: ["a", "b"], edit: ["a", added("n"), "b"], current: ["a", "b"] })).toEqual(["a", added("n"), "b"]);
    expect(mergePhotoOrder({ base: ["a", "b"], edit: [], current: ["a", "b"] })).toEqual([]);
  });

  test("an edit that kept its photos in their order keeps the spot's order now, so a cover chosen since stays", () => {
    const current = ["c", "a", "b"];
    expect(mergePhotoOrder({ base: ["a", "b", "c"], edit: ["a", "b", "c", added("n")], current })).toEqual(["c", "a", "b", added("n")]);
    expect(mergePhotoOrder({ base: ["a", "b", "c"], edit: [added("n"), "a", "c"], current })).toEqual([added("n"), "c", "a"]);
  });

  test("an edit that reordered its photos wins over an order chosen since", () => {
    expect(mergePhotoOrder({ base: ["a", "b", "c"], edit: ["b", "a", "c"], current: ["c", "a", "b"] })).toEqual(["b", "a", "c"]);
  });

  test("photos the spot gained since the base go after the edit's, in the spot's order", () => {
    expect(mergePhotoOrder({ base: ["a", "b"], edit: ["b", added("n")], current: ["x", "a", "b", "y"] })).toEqual(["b", added("n"), "x", "y"]);
  });

  test("a kept photo that's gone since is skipped without leaving a gap", () => {
    expect(mergePhotoOrder({ base: ["a", "b", "ghost"], edit: ["ghost", added("n"), "b", "a"], current: ["a", "b"] })).toEqual([added("n"), "b", "a"]);
  });

  test("a kept photo outside the base appears once", () => {
    expect(mergePhotoOrder({ base: [], edit: ["a"], current: ["a", "b", "c"] })).toEqual(["a", "b", "c"]);
    expect(mergePhotoOrder({ base: ["a"], edit: ["a", "a"], current: ["a", "b"] })).toEqual(["a", "b"]);
  });
});

describe("photoEdit", () => {
  const ids = (count: number) => Array.from({ length: count }, () => crypto.randomUUID());
  const accepts = (base: string[], order: string[]) => SpotEditDraftSchema.safeParse({ spotId: "spot-1", changes: {}, photoEdit: { base, order } }).success;

  test("a spot past 30 photos may reorder or shrink, but an edit never takes one past 30", () => {
    const many = ids(31);
    expect(accepts(many, many.toReversed())).toBe(true);
    expect(accepts(many, many.slice(1))).toBe(true);
    expect(accepts(many.slice(0, 30), many)).toBe(false);
  });
});
