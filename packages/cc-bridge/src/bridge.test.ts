import { describe, expect, it } from "vitest";
import { applyOps, newBlueprint } from "@tb/blueprint";
import { ccToWorld, exportSchema, normalise, toBlocksJson, toLayersJson } from "./index";

// Same shape as the 5x5 spike run through turtlesim.
const spike = applyOps(newBlueprint("spike"), [
  { op: "fill", from: [10, 5, 20], to: [14, 5, 24], block: "minecraft:stone_bricks" },
  { op: "fill", from: [10, 6, 20], to: [14, 6, 24], block: "minecraft:stone_bricks", mode: "outline" },
  { op: "set", at: [12, 6, 22], block: "minecraft:glass" },
]);

describe("normalise", () => {
  it("moves the minimum corner to 0,0,0", () => {
    const n = normalise(spike);
    expect(Math.min(...n.blocks.map((b) => b[0]))).toBe(0);
    expect(Math.min(...n.blocks.map((b) => b[1]))).toBe(0);
    expect(Math.min(...n.blocks.map((b) => b[2]))).toBe(0);
  });
});

describe("toLayersJson", () => {
  const parse = (bp: Parameters<typeof toLayersJson>[0]) => JSON.parse(toLayersJson(bp).text);
  const sym = (legend: Record<string, unknown>, block: string) => Object.entries(legend).find(([, v]) => v === block)?.[0] as string;

  it("emits a legend and one rectangular layer per y", () => {
    const out = parse(spike);
    expect(Object.values(out.legend).sort()).toEqual(["minecraft:glass", "minecraft:stone_bricks"]);
    expect(out.layers.map((l: { y: number }) => l.y)).toEqual([0, 1]);
    expect(out.layers[0].rows).toEqual(Array(5).fill(sym(out.legend, "minecraft:stone_bricks").repeat(5)));
  });

  it("puts the glass at the centre of layer 1 and air inside the ring", () => {
    const out = parse(spike);
    const g = sym(out.legend, "minecraft:glass");
    const s = sym(out.legend, "minecraft:stone_bricks");
    expect(out.layers[1].rows).toEqual([s.repeat(5), `${s}...${s}`, `${s}.${g}.${s}`, `${s}...${s}`, s.repeat(5)]);
  });

  it("keeps blockstate in the legend, one symbol per state, and warns", () => {
    const bp = applyOps(newBlueprint("s"), [
      { op: "set", at: [0, 0, 0], block: "minecraft:oak_stairs[facing=north,half=top]" },
      { op: "set", at: [1, 0, 0], block: "minecraft:oak_stairs[facing=south,half=top]" },
    ]);
    const out = toLayersJson(bp);
    expect(Object.values(JSON.parse(out.text).legend)).toEqual([
      { material: "minecraft:oak_stairs", meta: { state: { facing: "north", half: "top" } } },
      { material: "minecraft:oak_stairs", meta: { state: { facing: "south", half: "top" } } },
    ]);
    expect(out.warnings).toHaveLength(1);
  });

  it("leaves out layers with nothing in them", () => {
    const bp = applyOps(newBlueprint("gap"), [
      { op: "set", at: [0, 0, 0], block: "minecraft:stone" },
      { op: "set", at: [0, 3, 0], block: "minecraft:stone" },
    ]);
    expect(parse(bp).layers.map((l: { y: number }) => l.y)).toEqual([0, 3]);
  });

  it("refuses more block states than symbols", () => {
    const ops = Array.from({ length: 100 }, (_, i) => ({ op: "set" as const, at: [i, 0, 0] as [number, number, number], block: `mod:block_${i}` }));
    expect(() => toLayersJson(applyOps(newBlueprint("big"), ops))).toThrow(/toBlocksJson/);
  });
});

describe("toBlocksJson", () => {
  it("strips blockstate into meta", () => {
    const bp = applyOps(newBlueprint("s"), [{ op: "set", at: [3, 2, 1], block: "minecraft:oak_stairs[facing=north,half=top]" }]);
    const parsed = JSON.parse(toBlocksJson(bp).text);
    expect(parsed.blocks).toEqual([
      { x: 0, y: 0, z: 0, material: "minecraft:oak_stairs", meta: { state: { facing: "north", half: "top" } } },
    ]);
  });
});

describe("exportSchema", () => {
  it("uses layers when the states fit and a block list when they do not", () => {
    expect(JSON.parse(exportSchema(spike).text).layers).toBeDefined();
    const ops = Array.from({ length: 100 }, (_, i) => ({ op: "set" as const, at: [i, 0, 0] as [number, number, number], block: `mod:block_${i}` }));
    expect(JSON.parse(exportSchema(applyOps(newBlueprint("big"), ops)).text).blocks).toHaveLength(100);
  });
});

describe("ccToWorld", () => {
  it("matches the transform measured in turtlesim (glass 2,1,2 -> -3,1,3)", () => {
    expect(ccToWorld([2, 1, 2])).toEqual([-3, 1, 3]);
    expect(ccToWorld([0, 0, 0])).toEqual([-1, 0, 1]);
    expect(ccToWorld([4, 0, 4])).toEqual([-5, 0, 5]);
  });
});
