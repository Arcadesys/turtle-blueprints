import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { applyOps, validate, type Blueprint, type Op, type Vec3 } from "@tb/blueprint";
import { Store } from "@tb/mcp";
import { diffBuild, type TurtleSummary } from "@tb/tester";
import { generatePrompt, type Box } from "./src/wand";

const dir = resolve(process.env.TB_BLUEPRINTS ?? "../../blueprints");
const store = new Store(dir);
const repo = fileURLToPath(new URL("../..", import.meta.url));

async function body<T>(req: IncomingMessage): Promise<T> {
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

/** Serves blueprint files (the source of truth) and the latest test diff; the page polls `version`. */
function blueprintApi(): Plugin {
  return {
    name: "blueprint-api",
    configureServer(server) {
      server.middlewares.use("/api", (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const json = (v: unknown, code = 200) => {
          res.statusCode = code;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(v));
        };
        const fail = (e: unknown) => json({ error: e instanceof Error ? e.message : String(e) }, 400);
        if (url.pathname === "/list") {
          const names = existsSync(dir)
            ? readdirSync(dir).filter((f) => f.endsWith(".blueprint.json")).map((f) => f.replace(/\.blueprint\.json$/, "")).sort()
            : [];
          return json(names);
        }
        // Wand edits: copy is client-side; paste and delete arrive here as ops.
        const ops = /^\/blueprint\/([A-Za-z0-9_-]+)\/ops$/.exec(url.pathname);
        if (ops && req.method === "POST") {
          void body<{ ops: Op[] }>(req).then((b) => {
            const next = applyOps(store.load(ops[1]!), b.ops);
            store.save(next);
            json({ issues: validate(next) });
          }).catch(fail);
          return;
        }
        const gen = /^\/generate(?:\/([a-z0-9]+))?$/.exec(url.pathname);
        if (gen?.[1]) return jobs.has(gen[1]) ? json(jobs.get(gen[1])) : json({ error: "no such job" }, 404);
        if (gen && req.method === "POST") {
          void body<{ name: string; request: string; box: Box | null; target: Vec3 | null }>(req).then((b) => {
            if (!b.request?.trim()) throw new Error("say what to generate");
            if ([...jobs.values()].some((j) => j.name === b.name && j.status === "running")) {
              throw new Error(`already generating for ${b.name}`);
            }
            const prompt = generatePrompt({ ...b, bp: store.load(b.name), exportDir: join(dir, "exports") });
            json({ id: generate(b.name, prompt) });
          }).catch(fail);
          return;
        }
        const m = /^\/blueprint\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
        if (!m) return next();
        if (req.method === "PUT") {
          // Undo: put back a whole blueprint the page saw earlier.
          void body<{ blueprint: Blueprint }>(req).then((b) => {
            if (b.blueprint?.name !== m[1]) throw new Error("blueprint name does not match the URL");
            store.save(b.blueprint);
            json({ ok: true });
          }).catch(fail);
          return;
        }
        const file = join(dir, `${m[1]}.blueprint.json`);
        if (!existsSync(file)) return json({ error: "not found" }, 404);
        const blueprint = JSON.parse(readFileSync(file, "utf8"));
        const summaryFile = join(dir, ".test", m[1] as string, "results", "summary.json");
        let report = null;
        let version = String(statSync(file).mtimeMs);
        if (existsSync(summaryFile)) {
          report = diffBuild(blueprint, JSON.parse(readFileSync(summaryFile, "utf8")) as TurtleSummary);
          version += ":" + statSync(summaryFile).mtimeMs;
        }
        json({ blueprint, report, version });
      });
    },
  };
}

export default defineConfig({ plugins: [blueprintApi()], server: { port: 5173 } });
