import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOps, buildPlan, newBlueprint } from "./index";
import { Store } from "./store";

const fresh = () => new Store(mkdtempSync(join(tmpdir(), "tb-store-")));

describe("store", () => {
  it("creates, renames, duplicates and describes", () => {
    const s = fresh();
    s.create("hut", "a small hut");
    s.save(applyOps(s.load("hut"), [{ op: "fill", from: [0, 0, 0], to: [2, 1, 2], block: "stone" }]));
    s.rename("hut", "cabin");
    expect(s.list()).toEqual(["cabin"]);
    expect(s.load("cabin").name).toBe("cabin");
    s.duplicate("cabin", "cabin-2");
    expect(s.list()).toEqual(["cabin", "cabin-2"]);
    expect(s.info("cabin-2")).toMatchObject({ blocks: 18, size: [3, 2, 3], description: "a small hut" });
    s.describe("cabin-2", "");
    expect(s.load("cabin-2").description).toBeUndefined();
    expect(() => s.rename("cabin", "cabin-2")).toThrow(/already exists/);
    expect(() => s.create("../x")).toThrow(/bad blueprint name/);
  });

  it("archives and restores without deleting", () => {
    const s = fresh();
    s.create("old");
    s.archive("old");
    expect(s.list()).toEqual([]);
    expect(s.listArchived()).toEqual(["old"]);
    s.create("old");
    expect(() => s.restore("old")).toThrow(/already exists/);
    s.rename("old", "new");
    s.restore("old");
    expect(s.list()).toEqual(["new", "old"]);
    expect(existsSync(s.path("old", s.archiveDir))).toBe(false);
  });
});

describe("buildPlan", () => {
  it("counts stacks and turtle slots", () => {
    const bp = applyOps(newBlueprint("p"), [
      { op: "fill", from: [0, 0, 0], to: [9, 0, 9], block: "stone" },
      { op: "set", at: [0, 1, 0], block: "glass" },
    ]);
    const p = buildPlan(bp);
    expect(p.materials).toEqual([
      { block: "minecraft:stone", count: 100, stacks: 1, extra: 36, slots: 2 },
      { block: "minecraft:glass", count: 1, stacks: 0, extra: 1, slots: 1 },
    ]);
    expect(p.slots).toBe(3);
    expect(p.fitsInTurtle).toBe(true);
    const big = buildPlan(applyOps(newBlueprint("q"), [{ op: "fill", from: [0, 0, 0], to: [32, 0, 31], block: "stone" }]));
    expect(big.slots).toBe(17);
    expect(big.fitsInTurtle).toBe(false);
  });
});
