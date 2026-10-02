import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCandidates, findClaude } from "./settings";

describe("findClaude", () => {
  it("prefers the configured path, then PATH, then the installers' folders", () => {
    const c = claudeCandidates({ configured: "/x/claude", path: "/a:/b", home: "/h", platform: "darwin" });
    expect(c.slice(0, 4)).toEqual(["/x/claude", join("/a", "claude"), join("/b", "claude"), join("/h", ".local", "bin", "claude")]);
  });

  it("finds the native installer's claude when PATH is bare", () => {
    const want = join("/h", ".local", "bin", "claude");
    expect(findClaude({ path: "/usr/bin:/bin", home: "/h", platform: "darwin" }, (p) => p === want)).toBe(want);
  });

  it("on Windows looks for claude.exe and npm's claude.cmd", () => {
    const want = join("/appdata", "npm", "claude.cmd");
    expect(findClaude({ path: "C:\\Windows", home: "/h", platform: "win32", appData: "/appdata" }, (p) => p === want)).toBe(want);
  });

  it("falls back to plain claude so the error names it", () => {
    expect(findClaude({ home: "/h", platform: "darwin" }, () => false)).toBe("claude");
  });
});
