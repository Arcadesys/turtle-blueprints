// Bundles the desktop app into dist/: the viewer (vite), the Electron main process, the MCP
// server Generate runs, the asset extractor's worker, and the sample blueprints.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const dist = join(here, "dist");
rmSync(dist, { recursive: true, force: true });

await vite({ root: join(repo, "packages/web"), logLevel: "warn", build: { outDir: join(dist, "web"), emptyOutDir: true, chunkSizeWarningLimit: 2000 } });

await esbuild({
  entryPoints: {
    main: join(here, "src/main.ts"),
    "assets-worker": join(here, "src/assets-worker.ts"),
    mcp: join(repo, "packages/mcp/src/server.ts"),
  },
  outdir: dist,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  // The workspace packages are ESM and a few read import.meta.url; give them the CommonJS equivalent.
  define: { "import.meta.url": "__import_meta_url" },
  banner: { js: 'const __import_meta_url = require("url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});

// Sample blueprints, copied into a new user's blueprints folder on first run. Only tracked files.
mkdirSync(join(dist, "samples"));
let samples;
try {
  samples = execFileSync("git", ["ls-files", "blueprints/*.blueprint.json"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  samples = [];
}
for (const f of samples) if (existsSync(join(repo, f))) cpSync(join(repo, f), join(dist, "samples", basename(f)));
console.log(`built ${dist} (${samples.length} sample blueprints)`);
