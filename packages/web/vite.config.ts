import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { Store } from "@tb/blueprint/store";
import { exportSchema } from "@tb/cc-bridge";
import { diffBuild, type TurtleSummary } from "@tb/tester";

const store = new Store(resolve(process.env.TB_BLUEPRINTS ?? "../../blueprints"));

function body(req: IncomingMessage): Promise<Record<string, string | undefined>> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (c: Buffer) => { s += c; });
    req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { fail(e); } });
  });
}

/**
 * Serves blueprint files (the source of truth), the latest test diff, schema
 * downloads, and file management. The page polls `version` to pick up edits.
 */
function blueprintApi(): Plugin {
  return {
    name: "blueprint-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const json = (v: unknown, code = 200) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(v));
        };
        try {
          if (url.pathname === "/files" && req.method === "GET") {
            return json({ files: store.list().map((n) => store.info(n)), archived: store.listArchived() });
          }
          if (url.pathname === "/files" && req.method === "POST") {
            // Only this page may change files: refuse cross-site posts to the local server.
            const origin = req.headers.origin;
            if (origin && new URL(origin).host !== req.headers.host) return json({ error: "cross-origin request refused" }, 403);
            if (!req.headers["content-type"]?.startsWith("application/json")) return json({ error: "expected JSON" }, 415);
            const a = await body(req);
            const name = a.name ?? "";
            const to = a.to ?? "";
            switch (a.action) {
              case "create": store.create(name, a.description || undefined); break;
              case "rename": store.rename(name, to); break;
              case "duplicate": store.duplicate(name, to); break;
              case "archive": store.archive(name); break;
              case "restore": store.restore(name); break;
              case "describe": store.describe(name, a.description ?? ""); break;
              default: return json({ error: `unknown action ${String(a.action)}` }, 400);
            }
            return json({ ok: true });
          }
          const ex = /^\/export\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
          if (ex) {
            const name = ex[1] as string;
            const out = exportSchema(store.load(name));
            const file = `${name}.${out.format === "layered-text" ? "txt" : "json"}`;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.setHeader("content-disposition", `attachment; filename="${file}"`);
            return res.end(out.text);
          }
          const m = /^\/blueprint\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
          if (!m) return next();
          const name = m[1] as string;
          if (!store.exists(name)) return json({ error: "not found" }, 404);
          const blueprint = store.load(name);
          const summaryFile = join(store.dir, ".test", name, "results", "summary.json");
          let report = null;
          let version = String(statSync(store.path(name)).mtimeMs);
          if (existsSync(summaryFile)) {
            report = diffBuild(blueprint, JSON.parse(readFileSync(summaryFile, "utf8")) as TurtleSummary);
            version += ":" + statSync(summaryFile).mtimeMs;
          }
          json({ blueprint, report, version });
        } catch (e) {
          json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      });
    },
  };
}

export default defineConfig({ plugins: [blueprintApi()], server: { port: 5173 } });
