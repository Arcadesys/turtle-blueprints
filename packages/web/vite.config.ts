import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { applyOps, newBlueprint, validate, type Blueprint, type Op, type Vec3 } from "@tb/blueprint";
import { Store } from "@tb/blueprint/store";
import { exportSchema } from "@tb/cc-bridge";
import { diffBuild, type TurtleSummary } from "@tb/tester";
import { extract, generatePrompt, type Box } from "./src/wand";

const dir = resolve(process.env.TB_BLUEPRINTS ?? "../../blueprints");
const store = new Store(dir);
const repo = fileURLToPath(new URL("../..", import.meta.url));

async function body<T = Record<string, string | undefined>>(req: IncomingMessage): Promise<T> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return JSON.parse(s || "{}") as T;
}

interface Job { name: string; status: "running" | "done" | "failed"; steps: string[]; result: string }
const jobs = new Map<string, Job>();

/**
 * Generate: run headless Claude Code with only the turtle-blueprints MCP server, so it can
 * edit, validate, export and turtle-test the blueprint but touch nothing else.
 */
function generate(name: string, prompt: string): string {
  const id = Date.now().toString(36);
  const job: Job = { name, status: "running", steps: [], result: "" };
  jobs.set(id, job);
  const mcp = {
    mcpServers: {
      "turtle-blueprints": {
        command: join(repo, "node_modules/.bin/tsx"),
        args: [join(repo, "packages/mcp/src/server.ts")],
        env: { TB_BLUEPRINTS: dir, ...(process.env.CC_BINARIES ? { CC_BINARIES: process.env.CC_BINARIES } : {}) },
      },
    },
  };
  const child = spawn(process.env.TB_CLAUDE ?? "claude", [
    "-p", prompt,
    "--mcp-config", JSON.stringify(mcp), "--strict-mcp-config",
    "--allowedTools", "mcp__turtle-blueprints",
    "--output-format", "stream-json", "--verbose",
  ], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "", err = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const ev = JSON.parse(line);
        if (ev.type === "assistant") {
          for (const c of ev.message?.content ?? []) {
            if (c.type === "tool_use") job.steps.push(String(c.name).replace(/^mcp__turtle-blueprints__/, ""));
          }
        } else if (ev.type === "result") {
          job.result = String(ev.result ?? "");
          if (ev.is_error) job.status = "failed";
        }
      } catch { /* not a JSON event */ }
    }
  });
  child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
  child.on("error", (e) => { job.status = "failed"; job.result = `could not start claude: ${e.message}. Set TB_CLAUDE to its path.`; });
  child.on("close", (code) => {
    if (job.status === "running") job.status = code === 0 ? "done" : "failed";
    if (!job.result) job.result = err.trim() || `claude exited with ${code}`;
    if (job.status === "failed" && /authenticat|log ?in|oauth|api key/i.test(job.result)) {
      job.result += " Generate runs the claude CLI, which signs in separately from the desktop app: run `claude auth login` in a terminal, then try again.";
    }
  });
  return id;
}

/**
 * Serves blueprint files, test reports, schema downloads, file management,
 * and the viewer's selector-wand actions.
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
          if (url.pathname === "/list") return json(store.list());
          const ex = /^\/export\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
          if (ex) {
            const name = ex[1] as string;
            const out = exportSchema(store.load(name));
            const file = `${name}.${out.format === "layered-text" ? "txt" : "json"}`;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.setHeader("content-disposition", `attachment; filename="${file}"`);
            return res.end(out.text);
          }
          const ops = /^\/blueprint\/([A-Za-z0-9_-]+)\/ops$/.exec(url.pathname);
          if (ops && req.method === "POST") {
            const a = await body<{ ops: Op[] }>(req);
            const nextBlueprint = applyOps(store.load(ops[1]!), a.ops);
            store.save(nextBlueprint);
            return json({ issues: validate(nextBlueprint) });
          }
          if (url.pathname === "/new" && req.method === "POST") {
            const a = await body<{ name: string; from?: { name: string; box: Box } }>(req);
            if (store.exists(a.name)) throw new Error(`"${a.name}" already exists`);
            const blueprint = a.from ? extract(store.load(a.from.name), a.from.box, a.name) : newBlueprint(a.name);
            store.save(blueprint);
            return json({ name: blueprint.name, blocks: blueprint.blocks.length });
          }
          const gen = /^\/generate(?:\/([a-z0-9]+))?$/.exec(url.pathname);
          if (gen?.[1]) return jobs.has(gen[1]) ? json(jobs.get(gen[1])) : json({ error: "no such job" }, 404);
          if (gen && req.method === "POST") {
            const a = await body<{ name: string; request: string; box: Box | null; target: Vec3 | null }>(req);
            if (!a.request?.trim()) throw new Error("say what to generate");
            if ([...jobs.values()].some((job) => job.name === a.name && job.status === "running")) {
              throw new Error(`already generating for ${a.name}`);
            }
            const prompt = generatePrompt({ ...a, bp: store.load(a.name), exportDir: join(dir, "exports") });
            return json({ id: generate(a.name, prompt) });
          }
          const m = /^\/blueprint\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
          if (!m) return next();
          const name = m[1] as string;
          if (req.method === "PUT") {
            const a = await body<{ blueprint: Blueprint }>(req);
            if (a.blueprint?.name !== name) throw new Error("blueprint name does not match the URL");
            store.save(a.blueprint);
            return json({ ok: true });
          }
          if (!store.exists(name)) return json({ error: "not found" }, 404);
          const blueprint = store.load(name);
          const summaryFile = join(store.dir, ".test", name, "results", "summary.json");
          let report = null;
          let version = String(statSync(store.path(name)).mtimeMs);
          if (existsSync(summaryFile)) {
            report = diffBuild(blueprint, JSON.parse(readFileSync(summaryFile, "utf8")) as TurtleSummary);
            version += ":" + statSync(summaryFile).mtimeMs;
          }
          return json({ blueprint, report, version });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
      });
    },
  };
}

/** Texture files and block search live in server/api.ts, loaded through Vite so it can import the TypeScript workspace packages. */
function blockCatalog(): Plugin {
  return {
    name: "block-catalog",
    configureServer(server) {
      const api = () => server.ssrLoadModule("/server/api.ts") as Promise<typeof import("./server/api")>;
      server.middlewares.use("/mc", (req, res, next) => { void api().then((m) => m.serveTexture(req, res, next)); });
      server.middlewares.use("/api", (req, res, next) => { void api().then((m) => m.serveBlocks(req, res, next)); });
    },
  };
}

// blockCatalog first, so /api/blocks is answered before blueprintApi's catch-all.
export default defineConfig({ plugins: [blockCatalog(), blueprintApi()], server: { port: 5173 } });
