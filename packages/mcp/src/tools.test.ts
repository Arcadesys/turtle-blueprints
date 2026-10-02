import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, applyTool, exportTool, getTool, newTool, validateTool } from "./tools";

const fresh = () => new Store(mkdtempSync(join(tmpdir(), "tb-")));

describe("mcp tools", () => {
  it("creates, edits and shows a blueprint", () => {
    const s = fresh();
    newTool(s, { name: "tower" });
    const out = applyTool(s, {
      name: "tower",
      ops: [
        { op: "fill", from: [0, 0, 0], to: [4, 0, 4], block: "minecraft:stone_bricks" },
        { op: "fill", from: [0, 1, 0], to: [4, 3, 4], block: "minecraft:stone_bricks", mode: "hollow" },
        { op: "set", at: [2, 2, 0], block: "minecraft:glass" },
      ],
    });
    expect(out).toContain("applied 3 op(s)");
    const shown = getTool(s, { name: "tower", layers: [2] });
    expect(shown).toContain("y=2");
    expect(shown).toContain("minecraft:glass");
    expect(s.list()).toEqual(["tower"]);
  });

  it("rejects duplicates and bad names", () => {
    const s = fresh();
    newTool(s, { name: "a" });
    expect(() => newTool(s, { name: "a" })).toThrow(/already exists/);
    expect(() => s.path("../x")).toThrow(/bad blueprint name/);
    expect(() => getTool(s, { name: "missing" })).toThrow(/no blueprint named/);
  });

  it("validates and exports", () => {
    const s = fresh();
    newTool(s, { name: "b" });
    applyTool(s, { name: "b", ops: [{ op: "set", at: [0, 0, 0], block: "minecraft:oak_door" }] });
    expect(validateTool(s, { name: "b" })).toContain("warning:");
    expect(JSON.parse(exportTool(s, { name: "b" }).split("\nwarning:")[0]!).statePosArrayList).toContain("minecraft:oak_door");
  });
});

describe("file management tools", () => {
  it("lists, manages and plans", async () => {
    const { listTool, manageTool, planTool } = await import("./tools");
    const s = fresh();
    newTool(s, { name: "wall", description: "test wall" });
    applyTool(s, { name: "wall", ops: [{ op: "fill", from: [0, 0, 0], to: [69, 0, 0], block: "minecraft:cobblestone" }] });
    expect(listTool(s)).toContain("wall: 70 blocks, 70x1x1 - test wall");
    expect(planTool(s, { name: "wall" })).toContain("minecraft:cobblestone: 70 (1 x 64 + 6)");
    manageTool(s, { action: "duplicate", name: "wall", to: "wall2" });
    manageTool(s, { action: "archive", name: "wall" });
    expect(listTool(s)).toContain("archived: wall");
    expect(() => manageTool(s, { action: "rename", name: "wall2" })).toThrow(/needs to/);
  });
});

describe("gadgets export tool", () => {
  it("writes a template file", async () => {
    const { gadgetsTool } = await import("./tools");
    const { readFileSync } = await import("node:fs");
    const s = fresh();
    newTool(s, { name: "g" });
    applyTool(s, { name: "g", ops: [{ op: "set", at: [0, 0, 0], block: "minecraft:stone" }] });
    const out = gadgetsTool(s, { name: "g" });
    expect(out).toContain(join("exports", "g.bg2.json"));
    const t = JSON.parse(readFileSync(join(s.dir, "exports", "g.bg2.json"), "utf8"));
    expect(t.statePosArrayList).toContain("statelist:[I;1]");
  });
});
