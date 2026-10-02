import { describe, expect, it } from "vitest";
import { clickedUpper, placementState, slabMerge, type Hit } from "./placement";
import { raycast } from "./raycast";

const top: Hit = { normal: [0, 1, 0], fracY: 1, look: [0, -0.3, -1] }; // looking north, clicked a top face
const stairs = { facing: ["north", "south", "east", "west"], half: ["top", "bottom"], shape: ["straight"] };

describe("placementState", () => {
  it("faces stairs the way the player looks, bottom half when clicking a top face", () => {
    expect(placementState("minecraft:oak_stairs", stairs, top)).toBe("minecraft:oak_stairs[facing=north,half=bottom]");
  });
  it("puts stairs in the top half when clicking an underside or upper side", () => {
    expect(placementState("minecraft:oak_stairs", stairs, { ...top, normal: [0, -1, 0] })).toContain("half=top");
    expect(placementState("minecraft:oak_stairs", stairs, { ...top, normal: [1, 0, 0], fracY: 0.8 })).toContain("half=top");
    expect(placementState("minecraft:oak_stairs", stairs, { ...top, normal: [1, 0, 0], fracY: 0.2 })).toContain("half=bottom");
  });
  it("faces furnaces toward the player", () => {
    expect(placementState("minecraft:furnace", { facing: HORIZ }, top)).toBe("minecraft:furnace[facing=south]");
  });
  it("takes a log's axis from the clicked face", () => {
    const axis = { axis: ["x", "y", "z"] };
    expect(placementState("minecraft:oak_log", axis, top)).toBe("minecraft:oak_log[axis=y]");
    expect(placementState("minecraft:oak_log", axis, { ...top, normal: [-1, 0, 0] })).toBe("minecraft:oak_log[axis=x]");
    expect(placementState("minecraft:oak_log", axis, { ...top, normal: [0, 0, 1] })).toBe("minecraft:oak_log[axis=z]");
  });
  it("points pistons at the player and observers away", () => {
    const six = { facing: ["north", "east", "south", "west", "up", "down"] };
    expect(placementState("minecraft:piston", six, { ...top, look: [0, 1, 0.1] })).toBe("minecraft:piston[facing=down]");
    expect(placementState("minecraft:observer", six, { ...top, look: [0, 1, 0.1] })).toBe("minecraft:observer[facing=up]");
  });
  it("sets slab type from where you click", () => {
    const slab = { type: ["top", "bottom", "double"] };
    expect(placementState("minecraft:stone_slab", slab, top)).toBe("minecraft:stone_slab[type=bottom]");
    expect(placementState("minecraft:stone_slab", slab, { ...top, normal: [0, -1, 0] })).toBe("minecraft:stone_slab[type=top]");
  });
  it("leaves blocks without properties alone, and ignores state that does not exist", () => {
    expect(placementState("mekanism:steel_casing", {}, top)).toBe("mekanism:steel_casing");
    expect(placementState("minecraft:stone[facing=north]", {}, top)).toBe("minecraft:stone");
  });
});

const HORIZ = ["north", "south", "east", "west"];

describe("slabMerge", () => {
  it("fills a bottom slab from its top face, but not from the side below the middle", () => {
    expect(slabMerge("minecraft:stone_slab[type=bottom]", "minecraft:stone_slab[type=bottom]", top)).toBe("minecraft:stone_slab[type=double]");
    expect(slabMerge("minecraft:stone_slab[type=bottom]", "minecraft:stone_slab[type=bottom]", { ...top, normal: [1, 0, 0], fracY: 0.2 })).toBeNull();
  });
  it("fills a top slab from underneath", () => {
    expect(slabMerge("minecraft:stone_slab[type=top]", "minecraft:stone_slab[type=top]", { ...top, normal: [0, -1, 0] })).toBe("minecraft:stone_slab[type=double]");
  });
  it("ignores other blocks and already-double slabs", () => {
    expect(slabMerge("minecraft:stone", "minecraft:stone_slab[type=bottom]", top)).toBeNull();
    expect(slabMerge("minecraft:stone_slab[type=double]", "minecraft:stone_slab[type=bottom]", top)).toBeNull();
  });
});

describe("clickedUpper", () => {
  it("is false for a top face", () => expect(clickedUpper(top)).toBe(false));
});

describe("raycast", () => {
  const cells = new Set(["0,0,0", "-3,0,0"]);
  it("hits the face it entered through", () => {
    const hit = raycast(cells, [5, 0, 0], [-1, 0, 0]);
    expect(hit).toMatchObject({ cell: [0, 0, 0], normal: [1, 0, 0], ground: false });
    expect(hit?.point[0]).toBeCloseTo(0.5);
  });
  it("works through negative coordinates", () => {
    expect(raycast(cells, [-8, 0, 0], [1, 0, 0])).toMatchObject({ cell: [-3, 0, 0], normal: [-1, 0, 0] });
  });
  it("hits the top of a block from above", () => {
    expect(raycast(cells, [0, 5, 0], [0, -1, 0])).toMatchObject({ cell: [0, 0, 0], normal: [0, 1, 0] });
  });
  it("falls back to the ground plane under the first layer", () => {
    expect(raycast(cells, [4, 3, 2], [0, -1, 0])).toMatchObject({ cell: [4, -1, 2], normal: [0, 1, 0], ground: true });
  });
  it("returns null when it looks at the sky", () => {
    expect(raycast(cells, [0, 3, 0], [0, 1, 0])).toBeNull();
  });
});
