import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { searchCatalog, toWire, type Catalog } from "@tb/blueprint/editor";

const assetsDir = resolve(process.env.TB_ASSETS ?? "../../.assets");

type Next = () => void;

let catalog: { mtime: number; data: Catalog } | null = null;
/** The block catalog from `npm run assets`, reloaded when the file changes. */
function loadCatalog(): Catalog | null {
  const file = join(assetsDir, "catalog.json");
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  if (!catalog || catalog.mtime !== mtime) catalog = { mtime, data: JSON.parse(readFileSync(file, "utf8")) as Catalog };
  return catalog.data;
}

/** Texture files extracted by `npm run assets`. */
export function serveTexture(req: IncomingMessage, res: ServerResponse, next: Next) {
  const m = /^\/([a-z0-9_.-]+)\/([a-z0-9_./-]+\.png)$/.exec(req.url?.split("?")[0] ?? "");
  const file = m && !m[2]!.includes("..") ? join(assetsDir, "textures", m[1]!, m[2]!) : null;
  if (!file || !existsSync(file)) return next();
  res.setHeader("content-type", "image/png");
  res.setHeader("cache-control", "max-age=3600");
  res.end(readFileSync(file));
}

/** Block search and lookup over the catalog. Other /api routes belong to vite.config.ts. */
export function serveBlocks(req: IncomingMessage, res: ServerResponse, next: Next) {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/blocks" && url.pathname !== "/blocks/lookup") return next();
  const json = (v: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(v));
  };
  const cat = loadCatalog();
  if (!cat) return json({ error: "no catalog: run `npm run assets`", blocks: {}, frames: {}, order: [] });
  if (url.pathname === "/blocks") {
    const hits = searchCatalog(cat.blocks, url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 60));
    return json({ ...toWire(cat, hits), order: hits.map((h) => h.id) });
  }
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter((i) => cat.blocks[i]);
  return json(toWire(cat, ids.map((id) => ({ id, entry: cat.blocks[id]! }))));
}
