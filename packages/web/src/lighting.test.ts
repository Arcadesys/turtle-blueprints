import { describe, expect, it } from "vitest";
import { DEFAULT_LIGHT_ENV } from "@tb/blueprint/editor";
import { computeLight, lightmap, skyColor, skyDarken, timeOfDay, type LightCell } from "./lighting";

const at = (m: Float32Array, sky: number, block: number) => Array.from(m.subarray((sky * 16 + block) * 3, (sky * 16 + block) * 3 + 3));

describe("day cycle", () => {
  it("puts noon at 6000 and midnight at 18000", () => {
    expect(timeOfDay(6000)).toBeCloseTo(0);
    expect(timeOfDay(18000)).toBeCloseTo(0.5);
    expect(skyDarken(6000)).toBeCloseTo(1);
    expect(skyDarken(18000)).toBeCloseTo(0.2);
  });
  it("darkens the sky colour to black at night", () => {
    expect(skyColor(DEFAULT_LIGHT_ENV, 6000).map((v) => Math.round(v * 255))).toEqual([0x78, 0xa7, 0xff]);
    expect(skyColor(DEFAULT_LIGHT_ENV, 18000)).toEqual([0, 0, 0]);
  });
});

describe("lightmap", () => {
  const day = lightmap(DEFAULT_LIGHT_ENV, 6000);
  const night = lightmap(DEFAULT_LIGHT_ENV, 18000);
  it("is white in daylight (the game caps it at 0.99) and dark grey with no light at all", () => {
    expect(at(day, 15, 0).every((v) => v > 0.98)).toBe(true);
    const dark = at(day, 0, 0);
    expect(dark[0]).toBeCloseTo(dark[1]!);
    expect(dark[0]).toBeGreaterThan(0.03);
    expect(dark[0]).toBeLessThan(0.2);
  });
  it("gives torchlight its warm tint a few blocks from the torch: red over green over blue", () => {
    const [r, g, b] = at(night, 0, 9);
    expect(r).toBeGreaterThan(g!);
    expect(g).toBeGreaterThan(b!);
  });
  it("makes moonlight blue", () => {
    const [r, , b] = at(night, 15, 0);
    expect(b).toBeGreaterThan(r!);
  });
  it("is brighter with a higher Brightness setting", () => {
    const bright = lightmap({ ...DEFAULT_LIGHT_ENV, gamma: 1 }, 18000);
    expect(at(bright, 0, 7)[0]).toBeGreaterThan(at(night, 0, 7)[0]!);
  });
});

describe("computeLight", () => {
  const solid: LightCell = { opaque: true, emit: 0 };
  type Cells = Array<[number, number, number, LightCell]>;
  const read = (v: ReturnType<typeof computeLight>, x: number, y: number, z: number) => {
    const [w, h] = v.size;
    const i = (x - v.origin[0]) + w * ((y - v.origin[1]) + h * (z - v.origin[2]));
    return { block: v.data[i * 4]! / 17, sky: v.data[i * 4 + 1]! / 17, open: v.data[i * 4 + 2] === 255 };
  };
  it("spreads block light losing one per step", () => {
    const v = computeLight([[0, 0, 0, { opaque: false, emit: 14 }]], -0.5);
    expect(read(v, 0, 0, 0).block).toBe(14);
    expect(read(v, 1, 0, 0).block).toBe(13);
    expect(read(v, 2, 1, 0).block).toBe(11);
  });
  it("lets sky light straight down, but not under a roof", () => {
    const cells: Cells = [];
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) cells.push([x, 3, z, solid]);
    const v = computeLight(cells, -0.5);
    expect(read(v, 5, 0, 0).sky).toBe(15);
    expect(read(v, 0, 0, 0).sky).toBe(12); // three steps in from the open edge
    expect(read(v, 0, 3, 0).open).toBe(false);
    expect(read(v, 0, -1, 0).open).toBe(false); // the ground
  });
  it("does not let light through solid walls", () => {
    const cells: Cells = [[0, 0, 0, { opaque: true, emit: 15 }]];
    for (let y = 0; y < 3; y++) for (let z = -3; z <= 3; z++) cells.push([2, y, z, solid]);
    const v = computeLight(cells, -0.5);
    expect(read(v, 1, 0, 0).block).toBe(14);
    expect(read(v, 3, 0, 0).block).toBeLessThan(14 - 4);
  });
});
