import { describe, expect, it } from "vitest";
import { compareVersions, parseRelease, pickDmgAsset } from "./update";

describe("compareVersions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.2", "0.1.12")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.99")).toBe(1);
  });
  it("treats equal, v-prefixed and short versions as equal", () => {
    expect(compareVersions("v0.1.5", "0.1.5")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("0.1.5-beta.1", "0.1.5")).toBe(0);
  });
});

describe("pickDmgAsset", () => {
  const assets = [
    { name: "latest.yml" },
    { name: "Turtle-Blueprints-Setup-0.1.5.exe" },
    { name: "Turtle-Blueprints-0.1.5-arm64.dmg" },
    { name: "Turtle-Blueprints-0.1.5.dmg" },
  ];
  it("matches the CPU", () => {
    expect(pickDmgAsset(assets, "arm64")?.name).toBe("Turtle-Blueprints-0.1.5-arm64.dmg");
    expect(pickDmgAsset(assets, "x64")?.name).toBe("Turtle-Blueprints-0.1.5.dmg");
  });
  it("is undefined when there is no matching dmg", () => {
    expect(pickDmgAsset(assets.slice(0, 3), "x64")).toBeUndefined();
    expect(pickDmgAsset([], "arm64")).toBeUndefined();
  });
  it("also accepts x64 in the file name", () => {
    expect(pickDmgAsset([{ name: "App-1.0.0-x64.dmg" }, { name: "App-1.0.0-arm64.dmg" }], "x64")?.name).toBe("App-1.0.0-x64.dmg");
  });
});

describe("parseRelease", () => {
  it("strips the tag's v and picks the dmg", () => {
    const r = parseRelease({ tag_name: "v0.1.7", assets: [{ name: "a-arm64.dmg", browser_download_url: "u" }] }, "arm64");
    expect(r).toEqual({ version: "0.1.7", dmg: { name: "a-arm64.dmg", browser_download_url: "u" } });
  });
  it("rejects anything that isn't a release", () => {
    expect(parseRelease({ message: "Not Found" }, "arm64")).toBeNull();
    expect(parseRelease(null, "arm64")).toBeNull();
  });
});
