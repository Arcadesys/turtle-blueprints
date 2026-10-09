import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const versionOf = (dir: string) => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version;

describe("version", () => {
  it("is the same in every package as in the root package.json", () => {
    const root = versionOf(repo);
    expect(root).toMatch(/^\d+\.\d+\.\d+/);
    for (const p of readdirSync(join(repo, "packages"))) expect([p, versionOf(join(repo, "packages", p))]).toEqual([p, root]);
  });
});
