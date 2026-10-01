import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyOps, newBlueprint, searchCatalog, toWire, validate, type Catalog, type Op } from "@tb/blueprint";
import { Store } from "@tb/blueprint/store";
import { diffBuild, type TurtleSummary } from "@tb/tester";

const dir = resolve(process.env.TB_BLUEPRINTS ?? "../../blueprints");
const assetsDir = resolve(process.env.TB_ASSETS ?? "../../.assets");
const store = new Store(dir);

let catalog: { mtime: number; data: Catalog } | null = null;
/** The block catalog from `npm run assets`, reloaded when the file changes. */
function loadCatalog(): Catalog | null {
  const file = join(assetsDir, "catalog.json");
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  if (!catalog || catalog.mtime !== mtime) catalog = { mtime, data: JSON.parse(readFileSync(file, "utf8")) as Catalog };
  return catalog.data;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { fail(e); } });
    req.on("error", fail);
  });
}

/** The blueprint and, if a test has run, its diff; the page polls `version`. */
function payload(name: string) {
  const blueprint = store.load(name);
  const summaryFile = join(dir, ".test", name, "results", "summary.json");
  let report = null;
  let version = String(statSync(store.path(name)).mtimeMs);
  if (existsSync(summaryFile)) {
    report = diffBuild(blueprint, JSON.parse(readFileSync(summaryFile, "utf8")) as TurtleSummary);
    version += ":" + statSync(summaryFile).mtimeMs;
  }
  return { blueprint, report, version };
}


type Next = () => void;

/** Texture files extracted by `npm run assets`. */
export function serveTexture(req: IncomingMessage, res: ServerResponse, next: Next) {
  const m = /^\/([a-z0-9_.-]+)\/([a-z0-9_./-]+\.png)$/.exec(req.url?.split("?")[0] ?? "");
  const file = m && !m[2]!.includes("..") ? join(assetsDir, "textures", m[1]!, m[2]!) : null;
  if (!file || !existsSync(file)) return next();
  res.setHeader("content-type", "image/png");
  res.setHeader("cache-control", "max-age=3600");
  res.end(readFileSync(file));
}

/** Blueprint files (the source of truth), edits to them, and the block catalog. */
export async function serveApi(req: IncomingMessage, res: ServerResponse, next: Next) {
  const url = new URL(req.url ?? "/", "http://x");
  const json = (v: unknown, code = 200) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(v));
  };
    try {
      if (url.pathname === "/list") return json(store.list());

      if (url.pathname === "/new" && req.method === "POST") {
        const { name } = (await readBody(req)) as { name?: string };
        if (!name) return json({ error: "name required" }, 400);
        if (store.list().includes(name)) return json({ error: `"${name}" already exists` }, 409);
        store.save(newBlueprint(name));
        return json(payload(name));
      }

      if (url.pathname === "/blocks") {
        const cat = loadCatalog();
        if (!cat) return json({ error: "no catalog: run `npm run assets`", blocks: {}, frames: {}, order: [] });
        const hits = searchCatalog(cat.blocks, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 60));
        return json({ ...toWire(cat, hits), order: hits.map((h) => h.id) });
      }

      if (url.pathname === "/blocks/lookup") {
        const cat = loadCatalog();
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter((i) => cat?.blocks[i]);
        if (!cat) return json({ blocks: {}, frames: {} });
        return json(toWire(cat, ids.map((id) => ({ id, entry: cat.blocks[id]! }))));
      }

      const m = /^\/blueprint\/([A-Za-z0-9_-]+)(\/ops)?$/.exec(url.pathname);
      if (!m) return next();
      const name = m[1]!;
      if (!existsSync(store.path(name))) return json({ error: "not found" }, 404);
      if (m[2]) {
        if (req.method !== "POST") return json({ error: "POST only" }, 405);
        const ops = (await readBody(req)) as Op[];
        if (!Array.isArray(ops)) return json({ error: "body must be an array of ops" }, 400);
        const next2 = applyOps(store.load(name), ops);
        const errors = validate(next2).filter((i) => i.level === "error");
        if (errors.length) return json({ error: errors.map((e) => e.message).join("; ") }, 400);
        store.save(next2);
      }
      return json(payload(name));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
}
