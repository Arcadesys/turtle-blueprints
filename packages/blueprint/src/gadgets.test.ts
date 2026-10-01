import { describe, expect, it } from "vitest";
import { applyOps, newBlueprint } from "./index";
import { gadgetsCells, toGadgetsJson, toGadgetsTemplate } from "./gadgets";

describe("Building Gadgets 2 export", () => {
  it("encodes the bounding box x-fastest, then y, then z, with air as 0", () => {
    const bp = applyOps(newBlueprint("t"), [
      { op: "set", at: [5, 10, 5], block: "stone" },
      { op: "set", at: [6, 10, 5], block: "glass" },
      { op: "set", at: [5, 11, 5], block: "minecraft:oak_stairs[facing=north,half=top]" },
      { op: "set", at: [6, 10, 6], block: "stone" },
    ]);
    const t = toGadgetsTemplate(bp);
    expect(t.name).toBe("t");
    // Box 2x2x2 from (5,10,5): order (0,0,0)(1,0,0)(0,1,0)(1,1,0)(0,0,1)(1,0,1)(0,1,1)(1,1,1)
    expect(t.statePosArrayList).toBe(
      '{blockstatemap:[{Name:"minecraft:air"},{Name:"minecraft:stone"},{Name:"minecraft:glass"},' +
        '{Name:"minecraft:oak_stairs",Properties:{facing:"north",half:"top"}}],' +
        "endpos:{X:1,Y:1,Z:1},startpos:{X:0,Y:0,Z:0},statelist:[I;1,2,3,0,0,1,0,0]}",
    );
    expect(t.requiredItems).toEqual({ "minecraft:stone": 2, "minecraft:glass": 1, "minecraft:oak_stairs": 1 });
    expect(gadgetsCells(bp)).toBe(8);
    expect(JSON.parse(toGadgetsJson(bp))).toEqual(t);
  });

  it("refuses an empty blueprint", () => {
    expect(() => toGadgetsTemplate(newBlueprint("e"))).toThrow(/empty/);
  });
});
