import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const dir = resolve(process.env.TB_BLUEPRINTS ?? "../../blueprints");
const assets = resolve(process.env.TB_ASSETS ?? "../../.assets");
const repo = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Serves the viewer's backend (server/routes.ts) from the dev server. It is loaded through
 * Vite so it can import the TypeScript workspace packages and pick up edits without a restart.
 */
function blueprintApi(): Plugin {
  return {
    name: "blueprint-api",
    configureServer(server) {
      let routes: ReturnType<typeof import("./server/routes").createApi> | null = null;
      const load = async () => {
        const m = (await server.ssrLoadModule("/server/routes.ts")) as typeof import("./server/routes");
        return (routes ??= m.createApi({
          blueprints: () => dir,
          assets: () => assets,
          mcpServer: (blueprints) => ({
            command: join(repo, "node_modules/.bin/tsx"),
            args: [join(repo, "packages/mcp/src/server.ts")],
            env: { TB_BLUEPRINTS: blueprints, ...(process.env.CC_BINARIES ? { CC_BINARIES: process.env.CC_BINARIES } : {}) },
          }),
          claude: () => process.env.TB_CLAUDE ?? "claude",
          cwd: () => repo,
          noCatalog: "no catalog: run `npm run assets`",
        }));
      };
      server.watcher.on("change", (f) => { if (f.includes("/server/")) routes = null; });
      server.middlewares.use("/mc", (req, res, next) => { void load().then((r) => r.textures(req, res, next)); });
      server.middlewares.use("/api", (req, res, next) => { void load().then((r) => r.api(req, res, next)); });
    },
  };
}

export default defineConfig({ plugins: [blueprintApi()], server: { port: 5173 } });
