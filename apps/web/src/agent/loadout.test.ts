import { describe, expect, it } from "vitest";
import { emptyLoadout, firstFreeSlot, removeSlot, slotsById, toggleSkill } from "./loadout";

describe("the on-screen skill loadout (UI-FAST)", () => {
  it("puts a skill in the first free slot and takes it out again", () => {
    let l = emptyLoadout(3);
    l = toggleSkill(l, "a");
    l = toggleSkill(l, "b");
    expect(l).toEqual(["a", "b", null]);
    l = toggleSkill(l, "a");
    expect(l).toEqual([null, "b", null]);
    expect(firstFreeSlot(l)).toBe(0);
    expect(toggleSkill(l, "c")).toEqual(["c", "b", null]);
  });

  it("leaves a full loadout as it is", () => {
    const full = ["a", "b", "c"];
    expect(firstFreeSlot(full)).toBeNull();
    expect(toggleSkill(full, "d")).toBe(full);
  });

  it("empties a slot and says where each skill sits", () => {
    expect(removeSlot(["a", "b", null], 1)).toEqual(["a", null, null]);
    expect(slotsById(["a", null, "c"])).toEqual({ a: 0, c: 2 });
  });
});
