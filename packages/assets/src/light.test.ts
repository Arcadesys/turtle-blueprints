import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jarClasses } from "./extract";
import { classLoader, scanVanilla } from "./light";

// Runs against the deobfuscated client NeoForge installs; skipped when it is not there.
const libs = join(homedir(), "Documents/curseforge/minecraft/Install/libraries");
const find = (dir: string, re: RegExp): string | null => {
  if (!existsSync(dir)) return null;
  for (const v of readdirSync(dir).sort().reverse()) {
    const f = existsSync(join(dir, v)) ? readdirSync(join(dir, v)).find((n) => re.test(n)) : undefined;
    if (f) return join(dir, v, f);
  }
  return null;
};
const jars = [find(join(libs, "net/neoforged/neoforge"), /-client\.jar$/), find(join(libs, "net/minecraft/client"), /^client-1\.21\.1-.*-srg\.jar$/)];

describe.skipIf(jars.some((j) => !j))("light levels from Minecraft's code", () => {
  const scan = () => scanVanilla(classLoader(...jars.map((j) => jarClasses(readFileSync(j!)).classes)));
  const r = scan();
  const emit = (id: string, state: Record<string, string> = {}) => r.blocks.get(`minecraft:${id}`)?.emit?.(state);

  it("reads constant levels", () => {
    expect(emit("torch")).toBe(14);
    expect(emit("soul_torch")).toBe(10);
    expect(emit("glowstone")).toBe(15);
    expect(emit("magma_block")).toBe(3);
  });
  it("follows lit and count properties through the lightLevel function", () => {
    expect(emit("furnace", { lit: "true" })).toBe(13);
    expect(emit("furnace", { lit: "false" })).toBe(0);
    expect(emit("candle", { lit: "true", candles: "4" })).toBe(12);
    expect(emit("sea_pickle", { pickles: "2", waterlogged: "true" })).toBe(9);
    expect(emit("sea_pickle", { pickles: "2", waterlogged: "false" })).toBe(0);
    expect(emit("light", { level: "6" })).toBe(6);
  });
  it("finds noOcclusion", () => {
    expect(r.blocks.get("minecraft:glass")?.noOcclusion).toBe(true);
    expect(r.blocks.get("minecraft:stone")).toBeUndefined();
  });
});
