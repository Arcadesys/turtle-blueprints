/**
 * Pure helpers for the macOS update prompt (Windows uses electron-updater). No Electron imports
 * here, so it can be tested in Node.
 */

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

/** 1 when a is newer than b, -1 when older, 0 when equal. Leading "v" and "-prerelease" suffixes are ignored; missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/i, "").split("-")[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The disk image for this CPU: names with "arm64" are Apple Silicon, any other dmg is Intel. */
export function pickDmgAsset<T extends { name: string }>(assets: T[], arch: string): T | undefined {
  const dmgs = assets.filter((a) => /\.dmg$/i.test(a.name));
  const arm = (a: T) => /arm64/i.test(a.name);
  return dmgs.find((a) => (arch === "arm64") === arm(a));
}

/** Version and dmg for this CPU from a GitHub "latest release" response, or null when it isn't one. */
export function parseRelease(json: unknown, arch: string): { version: string; dmg?: ReleaseAsset } | null {
  const r = json as { tag_name?: unknown; assets?: unknown } | null;
  if (!r || typeof r.tag_name !== "string") return null;
  const assets = Array.isArray(r.assets) ? (r.assets as ReleaseAsset[]) : [];
  return { version: r.tag_name.replace(/^v/i, ""), dmg: pickDmgAsset(assets, arch) };
}
