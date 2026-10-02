import { describe, expect, it } from "vitest";
import { applyOps, newBlueprint } from "@tb/blueprint";
import { exportSchema, TURTLE_DISK_BYTES } from "./index";

// A 5x5 spike: a stone brick floor, a ring above it and glass in the middle.
const spike = applyOps(newBlueprint("spike"), [
  { op: "fill", from: [10, 5, 20], to: [14, 5, 24], block: "minecraft:stone_bricks" },
  { op: "fill", from: [10, 6, 20], to: [14, 6, 24], block: "minecraft:stone_bricks", mode: "outline" },
  { op: "set", at: [12, 6, 22], block: "minecraft:glass" },
]);

describe("exportSchema", () => {
  it("is the Building Gadgets 2 template, cells relative to the minimum corner", () => {
    const t = JSON.parse(exportSchema(spike).text);
    expect(t.name).toBe("spike");
    expect(t.statePosArrayList).toContain("startpos:{X:0,Y:0,Z:0}");
    expect(t.statePosArrayList).toContain("endpos:{X:4,Y:1,Z:4}");
    expect(t.requiredItems).toEqual({ "minecraft:stone_bricks": 41, "minecraft:glass": 1 });
  });

  it("keeps blockstate and warns that turtles ignore it", () => {
    const bp = applyOps(newBlueprint("s"), [{ op: "set", at: [0, 0, 0], block: "minecraft:oak_stairs[facing=north]" }]);
    const out = exportSchema(bp);
    expect(out.text).toContain('Properties:{facing:\\"north\\"}');
    expect(out.warnings).toEqual([expect.stringMatching(/blockstate/)]);
    expect(exportSchema(spike).warnings).toEqual([]);
  });

  it("warns when the template will not fit on a turtle's disk", () => {
    // Two corners make a 100x100x100 box, and every cell of it is encoded.
    const big = applyOps(newBlueprint("big"), [
      { op: "set", at: [0, 0, 0], block: "minecraft:stone" },
      { op: "set", at: [99, 99, 99], block: "minecraft:stone" },
    ]);
    expect(exportSchema(big).text.length).toBeGreaterThan(TURTLE_DISK_BYTES);
    expect(exportSchema(big).warnings).toEqual([expect.stringMatching(/1 MB disk/)]);
  });
});
