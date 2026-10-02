/**
 * The viewer's backend: blueprint files, test reports, schema downloads, file management,
 * the selector wand's actions, block search and textures. It is a plain Node request handler
 * so both the Vite dev server and the desktop app can host it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOps, newBlueprint, validate, type Blueprint, type Op, type Vec3 } from "@tb/blueprint";
import { DEFAULT_LIGHT_ENV, searchCatalog, toWire, type Catalog } from "@tb/blueprint/editor";
import { Store } from "@tb/blueprint/store";
import { exportSchema } from "@tb/cc-bridge";
import { diffBuild, type TurtleSummary } from "@tb/tester";
import { applyEvent, type GenerateJob } from "../src/checkpoints";
import { extract, generatePrompt, type Box } from "../src/wand";

export type Next = () => void;
export type Handler = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

export interface ApiOptions {
  /** Folder holding the .blueprint.json files. Read on every request, so it can change while running. */
  blueprints: () => string;
  /** Folder holding catalog.json and textures/ from the asset extractor. */
  assets: () => string;
  /** How Claude Code starts the turtle-blueprints MCP server for Generate. */
  mcpServer: (blueprintsDir: string) => { command: string; args: string[]; env?: Record<string, string> };
  /** The claude CLI to run for Generate. A .cmd or .bat (Windows npm installs) runs through the shell. */
  claude: () => string;
  /** Working directory for the claude CLI. */
  cwd: () => string;
  /** Shown when there is no block catalog yet. */
  noCatalog: string;
}

async function body<T = Record<string, string | undefined>>(req: IncomingMessage): Promise<T> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return JSON.parse(s || "{}") as T;
}

/** A Generate run: what the viewer is sent, plus the process and the open event streams. */
interface Job extends GenerateJob {
  child: ChildProcess;
  listeners: Set<(job: GenerateJob) => void>;
}

const view = ({ child: _c, listeners: _l, ...job }: Job): GenerateJob => job;

/** Stop claude and the MCP server it started. On Windows the shell wrapper would otherwise outlive the kill. */
function stop(child: ChildProcess) {
  if (process.platform === "win32" && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  else child.kill();
}

/** cmd.exe quoting for the few plain arguments Generate passes (the prompt goes in on stdin). */
const shellArg = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

export function createApi(opts: ApiOptions): { api: Handler; textures: Handler } {
  const jobs = new Map<string, Job>();
  const store = () => new Store(opts.blueprints());

  /**
   * Generate: run headless Claude Code with only the turtle-blueprints MCP server, so it can
   * edit, validate, export and turtle-test the blueprint but touch nothing else.
   * The prompt goes in on stdin and the MCP config in a file, so no argument needs shell quoting.
   */
  function generate(name: string, prompt: string): string {
    const id = Date.now().toString(36);
    const mcpFile = join(mkdtempSync(join(tmpdir(), "tb-mcp-")), "mcp.json");
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { "turtle-blueprints": opts.mcpServer(opts.blueprints()) } }));
    const claude = opts.claude();
    const viaShell = /\.(cmd|bat)$/i.test(claude);
    const args = [
      "-p",
      "--mcp-config", mcpFile, "--strict-mcp-config",
      "--allowedTools", "mcp__turtle-blueprints",
      "--output-format", "stream-json", "--verbose",
    ];
    const child = viaShell
      ? spawn([claude, ...args].map(shellArg).join(" "), { cwd: opts.cwd(), shell: true, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawn(claude, args, { cwd: opts.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const job: Job = { name, status: "running", checkpoints: [], result: "", started: Date.now(), child, listeners: new Set() };
    jobs.set(id, job);
    const publish = () => { for (const l of job.listeners) l(view(job)); };
    child.stdin.on("error", () => { /* reported through 'error' or 'close' */ });
    child.stdin.end(prompt);
    let buf = "", err = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let ev: unknown;
        try { ev = JSON.parse(line); } catch { continue; /* not a JSON event */ }
        if (applyEvent(job, ev)) publish();
      }
    });
    child.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
    child.on("error", (e) => {
      job.status = "failed";
      job.result = `could not start claude (${claude}): ${e.message}. Install Claude Code or set its path.`;
    });
    child.on("close", (code) => {
      if (job.status === "running") job.status = code === 0 ? "done" : "failed";
      if (!job.result) job.result = err.trim() || `claude exited with ${code}`;
      if (job.status === "failed" && /authenticat|log ?in|oauth|api key/i.test(job.result)) {
        job.result += " Generate runs the claude CLI, which signs in separately from the desktop app: run `claude auth login` in a terminal, then try again.";
      }
      job.finished = Date.now();
      for (const cp of job.checkpoints) if (cp.state === "running") cp.state = job.status === "stopped" ? "error" : "ok";
      publish();
      job.listeners.clear();
    });
    return id;
  }

  let catalog: { file: string; mtime: number; data: Catalog } | null = null;
  /** The block catalog from the asset extractor, reloaded when the file changes. */
  function loadCatalog(): Catalog | null {
    const file = join(opts.assets(), "catalog.json");
    if (!existsSync(file)) return null;
    const mtime = statSync(file).mtimeMs;
    if (!catalog || catalog.file !== file || catalog.mtime !== mtime) catalog = { file, mtime, data: JSON.parse(readFileSync(file, "utf8")) as Catalog };
    return catalog.data;
  }

  /** Texture files extracted by the asset extractor, mounted at /mc. */
  const textures: Handler = (req, res, next) => {
    const m = /^\/([a-z0-9_.-]+)\/([a-z0-9_./-]+\.png)$/.exec(req.url?.split("?")[0] ?? "");
    const file = m && !m[2]!.includes("..") ? join(opts.assets(), "textures", m[1]!, m[2]!) : null;
    if (!file || !existsSync(file)) return next();
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "max-age=3600");
    res.end(readFileSync(file));
  };

  /** Everything under /api. */
  const api: Handler = (req, res, next) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (v: unknown, code = 200) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(v));
      };
      try {
        if (url.pathname === "/blocks/env") return json(loadCatalog()?.env ?? DEFAULT_LIGHT_ENV);
        if (url.pathname === "/blocks" || url.pathname === "/blocks/lookup") {
          const cat = loadCatalog();
          if (!cat) return json({ error: opts.noCatalog, blocks: {}, frames: {}, order: [] });
          if (url.pathname === "/blocks") {
            const hits = searchCatalog(cat.blocks, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 60));
            return json({ ...toWire(cat, hits), order: hits.map((h) => h.id) });
          }
          const ids = (url.searchParams.get("ids") ?? "").split(",").filter((i) => cat.blocks[i]);
          return json(toWire(cat, ids.map((id) => ({ id, entry: cat.blocks[id]! }))));
        }
        // Only this page may change files: refuse cross-site writes to the local server.
        if (req.method !== "GET") {
          const origin = req.headers.origin;
          if (origin && origin !== "null" && new URL(origin).host !== req.headers.host) return json({ error: "cross-origin request refused" }, 403);
          if (!req.headers["content-type"]?.startsWith("application/json")) return json({ error: "expected JSON" }, 415);
        }
        const s = store();
        if (url.pathname === "/files" && req.method === "GET") {
          return json({ files: s.list().map((n) => s.info(n)), archived: s.listArchived() });
        }
        if (url.pathname === "/files" && req.method === "POST") {
          const a = await body(req);
          const name = a.name ?? "";
          const to = a.to ?? "";
          switch (a.action) {
            case "create": s.create(name, a.description || undefined); break;
            case "rename": s.rename(name, to); break;
            case "duplicate": s.duplicate(name, to); break;
            case "archive": s.archive(name); break;
            case "restore": s.restore(name); break;
            case "describe": s.describe(name, a.description ?? ""); break;
            default: return json({ error: `unknown action ${String(a.action)}` }, 400);
          }
          return json({ ok: true });
        }
        if (url.pathname === "/list") return json(s.list());
        const ex = /^\/export\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (ex) {
          const name = ex[1] as string;
          const out = exportSchema(s.load(name));
          const file = `${name}.json`;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("content-disposition", `attachment; filename="${file}"`);
          return res.end(out.text);
        }
        const ops = /^\/blueprint\/([A-Za-z0-9_-]+)\/ops$/.exec(url.pathname);
        if (ops && req.method === "POST") {
          const a = await body<{ ops: Op[] }>(req);
          const nextBlueprint = applyOps(s.load(ops[1]!), a.ops);
          s.save(nextBlueprint);
          return json({ issues: validate(nextBlueprint) });
        }
        if (url.pathname === "/new" && req.method === "POST") {
          const a = await body<{ name: string; from?: { name: string; box: Box } }>(req);
          if (s.exists(a.name)) throw new Error(`"${a.name}" already exists`);
          const blueprint = a.from ? extract(s.load(a.from.name), a.from.box, a.name) : newBlueprint(a.name);
          s.save(blueprint);
          return json({ name: blueprint.name, blocks: blueprint.blocks.length });
        }
        const gen = /^\/generate(?:\/([a-z0-9]+)(?:\/(events|stop))?)?$/.exec(url.pathname);
        const job = gen?.[1] ? jobs.get(gen[1]) : undefined;
        if (gen?.[1] && !job) return json({ error: "no such job" }, 404);
        if (job && gen?.[2] === "events") {
          // Server-sent events: the whole job each time it changes (it is small), ending when it finishes.
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          const send = (j: GenerateJob) => res.write(`data: ${JSON.stringify(j)}\n\n`);
          send(view(job));
          if (job.status !== "running") return res.end();
          const listener = (j: GenerateJob) => { send(j); if (j.status !== "running") res.end(); };
          job.listeners.add(listener);
          req.on("close", () => job.listeners.delete(listener));
          return;
        }
        if (job && gen?.[2] === "stop" && req.method === "POST") {
          if (job.status === "running") {
            job.status = "stopped";
            job.result = "Stopped. Ctrl/Cmd+Z undoes anything it already changed.";
            stop(job.child);
          }
          return json({ ok: true });
        }
        if (job) return json(view(job));
        if (gen && req.method === "POST") {
          const a = await body<{ name: string; request: string; box: Box | null; target: Vec3 | null }>(req);
          if (!a.request?.trim()) throw new Error("say what to generate");
          if ([...jobs.values()].some((job) => job.name === a.name && job.status === "running")) {
            throw new Error(`already generating for ${a.name}`);
          }
          const prompt = generatePrompt({ ...a, bp: s.load(a.name), exportDir: join(s.dir, "exports") });
          return json({ id: generate(a.name, prompt) });
        }
        const m = /^\/blueprint\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (!m) return next();
        const name = m[1] as string;
        if (req.method === "PUT") {
          const a = await body<{ blueprint: Blueprint }>(req);
          if (a.blueprint?.name !== name) throw new Error("blueprint name does not match the URL");
          s.save(a.blueprint);
          return json({ ok: true });
        }
        if (!s.exists(name)) return json({ error: "not found" }, 404);
        const blueprint = s.load(name);
        const summaryFile = join(s.dir, ".test", name, "results", "summary.json");
        let report = null;
        let version = String(statSync(s.path(name)).mtimeMs);
        if (existsSync(summaryFile)) {
          report = diffBuild(blueprint, JSON.parse(readFileSync(summaryFile, "utf8")) as TurtleSummary);
          version += ":" + statSync(summaryFile).mtimeMs;
        }
        return json({ blueprint, report, version });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400);
      }
    })();
  };

  return { api, textures };
}
