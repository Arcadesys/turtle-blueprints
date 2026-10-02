/**
 * Builds a block catalog and texture cache from a local Minecraft/ATM10 install.
 * Reads the vanilla client jar, every mod jar and kubejs/assets (later sources win)
 * and writes .assets/catalog.json plus the PNGs it references. Nothing here is committed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import type { Catalog, CatalogEntry, Faces, Variant } from "@tb/blueprint/editor";

type Json = Record<string, any>;

/** What one pass over the sources collects. */
export interface Sources {
  /** "assets/<ns>/<kind>/<path>.json" -> parsed JSON, for blockstates, models and en_us lang files. */
  json: Map<string, Json>;
  /** "ns:path" -> index into `readers` of the source holding textures/<ns>/<path>.png. */
  textures: Map<string, number>;
  /** Read several entries at once (one pass over a jar). */
  readers: Array<(entries: Set<string>) => Record<string, Uint8Array>>;
}

const DIRS = ["down", "up", "north", "south", "east", "west"] as const;
const WANTED = /^assets\/[^/]+\/(blockstates\/.+\.json|models\/.+\.json|lang\/en_us\.json)$/;
const TEXTURE = /^assets\/([^/]+)\/textures\/(.+)\.png$/;

export function newSources(): Sources {
  return { json: new Map(), textures: new Map(), readers: [] };
}

function addEntries(src: Sources, files: Record<string, Uint8Array>, reader: (entries: Set<string>) => Record<string, Uint8Array>) {
  const idx = src.readers.push(reader) - 1;
  for (const [name, data] of Object.entries(files)) {
    if (WANTED.test(name)) {
      try { src.json.set(name, JSON.parse(strFromU8(data).replace(/^\uFEFF/, ""))); } catch { /* some mods ship lenient JSON; skip */ }
    }
  }
  // Textures are indexed by name only; the bytes are read later for the ones the catalog uses.
  return idx;
}

/** Add a zip (jar). Only the JSON we need is decompressed; textures are indexed by name. */
export function addJar(src: Sources, load: () => Uint8Array): void {
  const bytes = load();
  const files = unzipSync(bytes, { filter: (f) => WANTED.test(f.name) });
  // Re-read on demand instead of holding every jar in memory.
  const idx = addEntries(src, files, (entries) => {
    try { return unzipSync(load(), { filter: (f) => entries.has(f.name) }); } catch { return {}; }
  });
  unzipSync(bytes, {
    filter: (f) => {
      const m = TEXTURE.exec(f.name);
      if (m) src.textures.set(`${m[1]}:${m[2]}`, idx);
      return false;
    },
  });
}

/** Add a loose assets/ directory (kubejs/assets and the like). */
export function addDir(src: Sources, root: string): void {
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = "assets/" + full.slice(root.length + 1).split("\\").join("/");
        if (WANTED.test(rel)) files[rel] = readFileSync(full);
        else if (TEXTURE.test(rel)) files[rel] = new Uint8Array();
      }
    }
  };
  if (!existsSync(root)) return;
  walk(root);
  const idx = addEntries(src, files, (entries) => {
    const out: Record<string, Uint8Array> = {};
    for (const entry of entries) {
      const p = join(root, entry.slice("assets/".length));
      if (existsSync(p)) out[entry] = readFileSync(p);
    }
    return out;
  });
  for (const name of Object.keys(files)) {
    const m = TEXTURE.exec(name);
    if (m) src.textures.set(`${m[1]}:${m[2]}`, idx);
  }
}

const split = (id: string, fallbackNs = "minecraft"): [string, string] => {
  const i = id.indexOf(":");
  return i < 0 ? [fallbackNs, id] : [id.slice(0, i), id.slice(i + 1)];
};

interface Resolved {
  textures: Record<string, string>;
  elements: Json[];
}

/** Follow a model's parent chain: child textures override, the first model that has elements supplies them. */
function resolveModel(src: Sources, id: string, depth = 0): Resolved | null {
  if (depth > 12) return null;
  const [ns, path] = split(id);
  const model = src.json.get(`assets/${ns}/models/${path}.json`);
  if (!model) return null;
  const parent = typeof model.parent === "string" ? resolveModel(src, model.parent, depth + 1) : null;
  return {
    textures: { ...(parent?.textures ?? {}), ...(model.textures ?? {}) },
    elements: Array.isArray(model.elements) ? model.elements : (parent?.elements ?? []),
  };
}

function deref(textures: Record<string, string>, ref: unknown): string | null {
  let cur = ref;
  for (let i = 0; i < 8 && typeof cur === "string" && cur.startsWith("#"); i++) cur = textures[cur.slice(1)];
  return typeof cur === "string" && !cur.startsWith("#") ? cur : null;
}

const volume = (e: Json) => {
  const f = e.from as number[], t = e.to as number[];
  return Math.abs((t[0]! - f[0]!) * (t[1]! - f[1]!) * (t[2]! - f[2]!));
};

/** Turn a resolved model into six face textures plus a slab shape. Largest elements win per face. */
function modelFaces(m: Resolved): { faces: Array<string | null>; shape?: "bottom" | "top" } {
  const faces: Array<string | null> = DIRS.map((): string | null => null);
  const els = m.elements.filter((e) => Array.isArray(e.from) && Array.isArray(e.to) && e.faces).sort((a, b) => volume(b) - volume(a));
  for (const e of els) {
    DIRS.forEach((d, i) => {
      if (faces[i] === null && e.faces[d]) faces[i] = deref(m.textures, e.faces[d].texture);
    });
  }
  if (!faces.some((f) => f !== null)) {
    const t = deref(m.textures, "#particle") ?? deref(m.textures, Object.values(m.textures)[0]);
    if (t) faces.fill(t);
  }
  let shape: "bottom" | "top" | undefined;
  if (els.length) {
    const cover = (e: Json) => (e.to as number[])[0]! - (e.from as number[])[0]! >= 16 && (e.to as number[])[2]! - (e.from as number[])[2]! >= 16;
    const big = els.filter(cover);
    if (big.length && big.every((e) => (e.to as number[])[1]! <= 8)) shape = "bottom";
    else if (big.length && big.every((e) => (e.from as number[])[1]! >= 8)) shape = "top";
  }
  return { faces, shape };
}

function pickApply(v: Json | Json[] | undefined): Json | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Collect property -> values from variant keys and multipart `when` clauses. */
function collectProps(bs: Json): Record<string, string[]> {
  const props: Record<string, Set<string>> = {};
  const add = (k: string, v: string) => (props[k] ??= new Set()).add(v);
  for (const key of Object.keys(bs.variants ?? {})) {
    if (!key || key === "normal") continue;
    for (const kv of key.split(",")) {
      const [k, v] = kv.split("=");
      if (k && v !== undefined) add(k, v);
    }
  }
  const when = (w: Json | undefined) => {
    if (!w) return;
    for (const [k, v] of Object.entries(w)) {
      if (k === "OR" || k === "AND") (v as Json[]).forEach(when);
      else for (const val of String(v).split("|")) add(k, val);
    }
  };
  for (const part of bs.multipart ?? []) when(part.when);
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, [...v].sort()]));
}

const titleCase = (path: string) => path.split(/[/_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

export function buildCatalog(src: Sources): { catalog: Catalog; used: string[] } {
  const textures: string[] = [];
  const texIndex = new Map<string, number>();
  const tex = (id: string | null): number => {
    if (!id) return -1;
    const [ns, path] = split(id);
    const full = `${ns}:${path}`;
    if (!src.textures.has(full)) return -1;
    let i = texIndex.get(full);
    if (i === undefined) { i = textures.push(full) - 1; texIndex.set(full, i); }
    return i;
  };
  const blocks: Record<string, CatalogEntry> = {};

  for (const name of src.json.keys()) {
    const m = /^assets\/([^/]+)\/blockstates\/(.+)\.json$/.exec(name);
    if (!m) continue;
    const [, ns, path] = m as unknown as [string, string, string];
    const bs = src.json.get(name)!;
    const lang = src.json.get(`assets/${ns}/lang/en_us.json`);
    const display = lang?.[`block.${ns}.${path.replace(/\//g, ".")}`];
    const v: Record<string, Variant> = {};

    const addVariant = (key: string, apply: Json | undefined) => {
      if (!apply || typeof apply.model !== "string") return;
      const model = resolveModel(src, apply.model);
      if (!model) return;
      const r = modelFaces(model);
      const f = r.faces.map(tex) as Faces;
      if (f.every((i) => i < 0)) return;
      v[key] = { f, ...(r.shape ? { s: r.shape } : {}), ...(apply.x ? { x: apply.x } : {}), ...(apply.y ? { y: apply.y } : {}) };
    };

    if (bs.variants) for (const [key, val] of Object.entries(bs.variants)) addVariant(key === "normal" ? "" : key, pickApply(val as Json));
    else if (Array.isArray(bs.multipart)) {
      // One representative look: the unconditional part, or else the first part.
      const part = bs.multipart.find((p: Json) => !p.when) ?? bs.multipart[0];
      addVariant("", pickApply(part?.apply));
    }
    const props = collectProps(bs);
    blocks[`${ns}:${path}`] = {
      n: typeof display === "string" ? display : titleCase(path),
      ...(Object.keys(props).length ? { p: props } : {}),
      v,
    };
  }
  return { catalog: { version: 1, textures, frames: {}, blocks }, used: textures };
}

/** Frame count for a vertical animation strip, from the PNG header. */
export function pngFrames(png: Uint8Array): number {
  if (png.length < 24) return 1;
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  return w > 0 && h > w && h % w === 0 ? h / w : 1;
}

export function writeAssets(src: Sources, outDir: string): { blocks: number; textures: number } {
  const { catalog } = buildCatalog(src);
  const bySource = new Map<number, Set<string>>();
  for (const id of catalog.textures) {
    const [ns, path] = split(id);
    const idx = src.textures.get(id)!;
    (bySource.get(idx) ?? bySource.set(idx, new Set()).get(idx)!).add(`assets/${ns}/textures/${path}.png`);
  }
  const loaded = new Map<string, Uint8Array>();
  for (const [idx, names] of bySource) for (const [k, v] of Object.entries(src.readers[idx]!(names))) loaded.set(k, v);
  catalog.textures.forEach((id, i) => {
    const [ns, path] = split(id);
    const bytes = loaded.get(`assets/${ns}/textures/${path}.png`);
    const file = join(outDir, "textures", ns, `${path}.png`);
    if (!bytes || bytes.length === 0) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const n = pngFrames(bytes);
    if (n > 1) catalog.frames[i] = n;
  });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "catalog.json"), JSON.stringify(catalog));
  return { blocks: Object.keys(catalog.blocks).length, textures: catalog.textures.length };
}

/** Where CurseForge and the vanilla launcher usually keep ATM10 and the 1.21.1 client jar on this OS. */
export function defaultPaths(home = homedir(), platform = process.platform, env = process.env): { instance: string[]; clientJar: string[] } {
  const curseforge = platform === "win32" ? [join(home, "curseforge", "minecraft"), join(home, "Documents", "curseforge", "minecraft")] : [join(home, "Documents", "curseforge", "minecraft")];
  const vanilla =
    platform === "win32" ? join(env.APPDATA ?? join(home, "AppData", "Roaming"), ".minecraft")
    : platform === "darwin" ? join(home, "Library", "Application Support", "minecraft")
    : join(home, ".minecraft");
  return {
    instance: curseforge.map((c) => join(c, "Instances", "All the Mods 10 - ATM10")),
    clientJar: [...curseforge.map((c) => join(c, "Install", "versions", "1.21.1", "1.21.1.jar")), join(vanilla, "versions", "1.21.1", "1.21.1.jar")],
  };
}

/** Read the client jar, the instance's mods and kubejs/assets, and write the catalog and textures to `out`. */
export function buildAssets(a: { instance: string; clientJar: string; out: string; progress?: (msg: string, done?: number, total?: number) => void }) {
  const say = a.progress ?? (() => {});
  for (const p of [a.instance, a.clientJar]) if (!existsSync(p)) throw new Error(`not found: ${p}`);
  const mods = join(a.instance, "mods");
  if (!existsSync(mods)) throw new Error(`no mods folder in ${a.instance}: pick the ATM10 instance folder`);
  const src = newSources();
  say(`vanilla ${a.clientJar}`);
  addJar(src, () => readFileSync(a.clientJar));
  const jars = readdirSync(mods).filter((f) => f.endsWith(".jar")).sort();
  jars.forEach((j, i) => {
    say(j, i + 1, jars.length);
    try { addJar(src, () => readFileSync(join(mods, j))); } catch (e) { say(`skipped ${j}: ${(e as Error).message}`); }
  });
  addDir(src, join(a.instance, "kubejs", "assets"));
  say("building catalog...");
  return writeAssets(src, a.out);
}
