import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { pickVariant, searchCatalog } from "@tb/blueprint/editor";
import { addJar, buildCatalog, newSources, pngFrames, writeAssets } from "./extract";

const j = (v: unknown) => strToU8(JSON.stringify(v));
// 1x2 PNG header only: width 1, height 2 -> would be 2 frames if it were an animation strip of 1x1 frames
const png = (w: number, h: number) => {
  const b = new Uint8Array(33);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return b;
};

function world() {
  const vanilla = zipSync({
    "assets/minecraft/blockstates/oak_log.json": j({ variants: { "axis=y": { model: "minecraft:block/oak_log" }, "axis=x": { model: "minecraft:block/oak_log_horizontal", x: 90, y: 90 } } }),
    "assets/minecraft/blockstates/oak_stairs.json": j({ variants: { "facing=east,half=bottom,shape=straight": { model: "minecraft:block/oak_stairs" }, "facing=north,half=top,shape=straight": { model: "minecraft:block/oak_stairs", x: 180, y: 270 } } }),
    "assets/minecraft/blockstates/stone_slab.json": j({ variants: { "type=bottom": { model: "minecraft:block/stone_slab" } } }),
    "assets/minecraft/models/block/cube_column.json": j({ parent: "minecraft:block/cube", textures: { particle: "#side" }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { down: { texture: "#end" }, up: { texture: "#end" }, north: { texture: "#side" }, south: { texture: "#side" }, east: { texture: "#side" }, west: { texture: "#side" } } }] }),
    "assets/minecraft/models/block/cube.json": j({ elements: [] }),
    "assets/minecraft/models/block/oak_log.json": j({ parent: "minecraft:block/cube_column", textures: { end: "minecraft:block/oak_log_top", side: "minecraft:block/oak_log" } }),
    "assets/minecraft/models/block/oak_log_horizontal.json": j({ parent: "minecraft:block/oak_log" }),
    "assets/minecraft/models/block/oak_stairs.json": j({ textures: { all: "minecraft:block/oak_planks" }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { down: { texture: "#all" }, north: { texture: "#all" } } }, { from: [8, 8, 0], to: [16, 16, 16], faces: { up: { texture: "#all" } } }] }),
    "assets/minecraft/models/block/stone_slab.json": j({ textures: { all: "minecraft:block/stone" }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { down: { texture: "#all" }, up: { texture: "#all" }, north: { texture: "#all" }, south: { texture: "#all" }, east: { texture: "#all" }, west: { texture: "#all" } } }] }),
    "assets/minecraft/lang/en_us.json": j({ "block.minecraft.oak_log": "Oak Log", "block.minecraft.stone_slab": "Stone Slab" }),
    "assets/minecraft/textures/block/oak_log.png": png(16, 16),
    "assets/minecraft/textures/block/oak_log_top.png": png(16, 16),
    "assets/minecraft/textures/block/oak_planks.png": png(16, 16),
    "assets/minecraft/textures/block/stone.png": png(16, 48),
  });
  const mod = zipSync({
    "assets/mekanism/blockstates/steel_casing.json": j({ variants: { "": { model: "mekanism:block/steel_casing" } } }),
    "assets/mekanism/models/block/steel_casing.json": j({ parent: "minecraft:block/cube_all_missing", textures: { particle: "mekanism:block/steel_casing" } }),
    "assets/mekanism/textures/block/steel_casing.png": png(16, 16),
  });
  const src = newSources();
  addJar(src, () => vanilla);
  addJar(src, () => mod);
  return src;
}

describe("asset extractor", () => {
  it("reads faces, props, names and rotation for a log", () => {
    const { catalog } = buildCatalog(world());
    const log = catalog.blocks["minecraft:oak_log"]!;
    expect(log.n).toBe("Oak Log");
    expect(log.p).toEqual({ axis: ["x", "y"] });
    const y = pickVariant(log, "minecraft:oak_log[axis=y]")!;
    const [down, up, north] = [y.f[0], y.f[1], y.f[2]].map((i) => catalog.textures[i]);
    expect(down).toBe("minecraft:block/oak_log_top");
    expect(up).toBe("minecraft:block/oak_log_top");
    expect(north).toBe("minecraft:block/oak_log");
    expect(pickVariant(log, "minecraft:oak_log[axis=x]")).toMatchObject({ x: 90, y: 90 });
  });
  it("handles stairs props, falls back to title-case names, and merges faces from several elements", () => {
    const { catalog } = buildCatalog(world());
    const st = catalog.blocks["minecraft:oak_stairs"]!;
    expect(st.n).toBe("Oak Stairs");
    expect(st.p).toEqual({ facing: ["east", "north"], half: ["bottom", "top"], shape: ["straight"] });
    const f = st.v["facing=east,half=bottom,shape=straight"]!.f.map((i) => catalog.textures[i]);
    expect(f.filter((t) => t === "minecraft:block/oak_planks")).toHaveLength(3); // down, north from the big element, up from the second
    expect(st.v["facing=north,half=top,shape=straight"]).toMatchObject({ x: 180, y: 270 });
  });
  it("detects half slabs", () => {
    expect(buildCatalog(world()).catalog.blocks["minecraft:stone_slab"]!.v["type=bottom"]!.s).toBe("bottom");
  });
  it("uses the particle texture when a modded model has no elements", () => {
    const { catalog } = buildCatalog(world());
    const v = catalog.blocks["mekanism:steel_casing"]!.v[""]!;
    expect(v.f.every((i) => catalog.textures[i] === "mekanism:block/steel_casing")).toBe(true);
  });
  it("counts animation frames and writes only referenced textures", () => {
    expect(pngFrames(png(16, 48))).toBe(3);
    expect(pngFrames(png(16, 16))).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), "tb-assets-"));
    const r = writeAssets(world(), dir);
    expect(r.blocks).toBe(4);
    expect(existsSync(join(dir, "textures/minecraft/block/oak_log.png"))).toBe(true);
    const cat = JSON.parse(readFileSync(join(dir, "catalog.json"), "utf8"));
    const idx = cat.textures.indexOf("minecraft:block/stone");
    expect(cat.frames[idx]).toBe(3);
  });
  it("searches by english name, id and mod", () => {
    const { catalog } = buildCatalog(world());
    expect(searchCatalog(catalog.blocks, "oak stairs")[0]!.id).toBe("minecraft:oak_stairs");
    expect(searchCatalog(catalog.blocks, "steel")[0]!.id).toBe("mekanism:steel_casing");
    expect(searchCatalog(catalog.blocks, "log")[0]!.id).toBe("minecraft:oak_log");
    expect(searchCatalog(catalog.blocks, "zzz")).toEqual([]);
  });
});
