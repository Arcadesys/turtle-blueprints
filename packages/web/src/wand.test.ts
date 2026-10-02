import { describe, expect, it } from "vitest";
import { applyOps, newBlueprint } from "@tb/blueprint";
import { WHEEL, boxOf, copy, deleteOps, extract, generatePrompt, pasteOps, wheelAngle, wheelSlice } from "./wand";

const sample = () =>
  applyOps(newBlueprint("hut"), [
    { op: "fill", from: [0, 0, 0], to: [2, 0, 2], block: "minecraft:stone" },
    { op: "set", at: [1, 1, 1], block: "minecraft:glass" },
  ]);

describe("selector wand", () => {
  it("normalises a box from any two corners", () => {
    expect(boxOf([3, 0, -1], [1, 2, 4])).toEqual({ min: [1, 0, -1], max: [3, 2, 4] });
  });

  it("copies relative to the box and pastes at a new corner", () => {
    const bp = sample();
    const clip = copy(bp, boxOf([1, 0, 1], [1, 1, 1]));
    expect(clip.size).toEqual([1, 2, 1]);
    expect(clip.blocks).toEqual([[0, 0, 0, "minecraft:stone"], [0, 1, 0, "minecraft:glass"]]);
    const next = applyOps(bp, pasteOps(clip, [5, 0, 5]));
    expect(next.blocks).toContainEqual([5, 0, 5, "minecraft:stone"]);
    expect(next.blocks).toContainEqual([5, 1, 5, "minecraft:glass"]);
    expect(next.blocks.length).toBe(bp.blocks.length + 2);
  });

  it("does not let clipboard air overwrite the paste target", () => {
    const bp = sample();
    const clip = copy(bp, boxOf([1, 1, 1], [2, 1, 1])); // glass plus one air cell
    const next = applyOps(bp, pasteOps(clip, [0, 0, 0]));
    expect(next.blocks).toContainEqual([0, 0, 0, "minecraft:glass"]);
    expect(next.blocks).toContainEqual([1, 0, 0, "minecraft:stone"]);
  });

  it("deletes everything in the box and nothing outside it", () => {
    const next = applyOps(sample(), deleteOps(boxOf([0, 0, 0], [1, 1, 1])));
    expect(next.blocks.map((b) => b.slice(0, 3))).toEqual([[2, 0, 0], [2, 0, 1], [0, 0, 2], [1, 0, 2], [2, 0, 2]]);
  });

  it("tells Claude where and what to build", () => {
    const p = generatePrompt({
      name: "hut", request: "add a chimney", bp: sample(),
      box: boxOf([1, 1, 1], [1, 1, 1]), target: null, exportDir: "/tmp/exports",
    });
    expect(p).toContain('blueprint "hut"');
    expect(p).toContain("from [1, 1, 1] to [1, 1, 1]");
    expect(p).toContain("1 x minecraft:glass");
    expect(p).toContain("add a chimney");
    expect(p).toContain('outPath "/tmp/exports/hut.txt"');
    expect(p).toContain("test_run_build");
  });

  it("maps a mouse flick to the wheel slice it points at", () => {
    // A flick toward each button's own position picks that button.
    WHEEL.forEach((act, i) => {
      const a = wheelAngle(i);
      expect(wheelSlice(40 * Math.sin(a), -40 * Math.cos(a))).toBe(act);
      expect(wheelSlice(40 * Math.sin(a + 0.5), -40 * Math.cos(a + 0.5))).toBe(act); // and a bit off to the side
    });
    expect(wheelSlice(0, -40)).toBe("copy");
    expect(wheelSlice(-3, -40)).toBe("copy"); // just left of up wraps to the first slice
    expect(wheelSlice(5, -5)).toBeNull();
  });

  it("extracts a selection as a new blueprint at the origin", () => {
    const out = extract(sample(), boxOf([1, 0, 1], [2, 1, 2]), "piece");
    expect(out.name).toBe("piece");
    expect(out.description).toBe("from hut, 1,0,1 to 2,1,2");
    expect(out.blocks).toEqual([
      [0, 0, 0, "minecraft:stone"], [1, 0, 0, "minecraft:stone"],
      [0, 0, 1, "minecraft:stone"], [1, 0, 1, "minecraft:stone"],
      [0, 1, 0, "minecraft:glass"],
    ]);
  });
});
