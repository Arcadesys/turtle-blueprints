/**
 * Desktop settings and the lookups that let the app find tools a terminal would find on its own.
 * No Electron imports here, so it can be tested in Node.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Settings {
  /** Folder of .blueprint.json files. */
  blueprints?: string;
  /** The claude CLI, when it is not found automatically. */
  claude?: string;
  /** A cc-binaries checkout for turtle tests. */
  ccBinaries?: string;
  /** Last ATM10 instance and client jar the block catalog was built from. */
  instance?: string;
  clientJar?: string;
}

export function loadSettings(file: string): Settings {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Settings;
  } catch {
    return {};
  }
}

export function saveSettings(file: string, s: Settings): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
}

/**
 * Apps started from the Dock or Finder get a bare PATH, so tools installed through a shell
 * profile (claude, CraftOS-PC) are missing. Ask the login shell for its PATH. Windows apps
 * already get the user's PATH.
 */
export function loginShellPath(platform = process.platform, env = process.env): string | null {
  if (platform === "win32") return null;
  try {
    const out = execFileSync(env.SHELL || "/bin/zsh", ["-ilc", 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: "utf8", timeout: 5000 });
    return /__PATH__(.*)__PATH__/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Where to look for the claude CLI: the configured path, then PATH, then where its installers put it. */
export function claudeCandidates(a: { configured?: string; path?: string; home: string; platform?: NodeJS.Platform; appData?: string }): string[] {
  const win = (a.platform ?? process.platform) === "win32";
  const names = win ? ["claude.exe", "claude.cmd"] : ["claude"];
  const dirs = (a.path ?? "").split(win ? ";" : ":").filter(Boolean);
  const known = win
    ? [join(a.home, ".local", "bin"), join(a.home, ".claude", "local"), join(a.appData ?? join(a.home, "AppData", "Roaming"), "npm")]
    : [join(a.home, ".local", "bin"), join(a.home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"];
  const out = a.configured ? [a.configured] : [];
  for (const d of [...dirs, ...known]) for (const n of names) out.push(join(d, n));
  return out;
}

/** The first claude CLI that exists, or plain "claude" so the error names what is missing. */
export function findClaude(a: Parameters<typeof claudeCandidates>[0], exists: (p: string) => boolean = existsSync): string {
  return claudeCandidates(a).find(exists) ?? "claude";
}
