/** Block catalog types shared by the asset extractor, the dev server and the viewer. Pure and browser-safe. */
import type { Props } from "./placement";

/** Face order everywhere in the catalog: down, up, north, south, east, west. -1 means no texture. */
export type Faces = [number, number, number, number, number, number];

export interface Variant {
  /** Indices into Catalog.textures. */
  f: Faces;
  /** "bottom" or "top" when the model is a half-height box (slabs; stairs are approximated the same way). */
  s?: "bottom" | "top";
  /** Model rotations in degrees (Minecraft blockstate x/y). */
  x?: number;
  y?: number;
  /** Light the block gives off in this state, 1-15 (from the game code's lightLevel). */
  l?: number;
  /** 1 when light passes through: not a full cube, or noOcclusion in the game code. */
  t?: 1;
}

/** World lighting settings read from the game data and the instance's options.txt. */
export interface LightEnv {
  /** dimension_type/overworld.json ambient_light. */
  ambient: number;
  /** worldgen/biome/plains.json effects.sky_color, as 0xRRGGBB. */
  sky: number;
  /** options.txt gamma (the Brightness slider: 0 moody, 1 bright). */
  gamma: number;
  /** options.txt ao (Smooth Lighting). */
  smooth: boolean;
}

export const DEFAULT_LIGHT_ENV: LightEnv = { ambient: 0, sky: 0x78a7ff, gamma: 0.5, smooth: true };

export interface CatalogEntry {
  /** English display name. */
  n: string;
  /** Property name -> values. */
  p?: Props;
  /** Blockstate key ("facing=north,half=bottom", or "") -> variant. The first one is the default. */
  v: Record<string, Variant>;
}

export interface Catalog {
  version: 1;
  /** Texture ids as "namespace:path" (file at textures/<namespace>/<path>.png). */
  textures: string[];
  /** Texture index -> animation frame count, when more than one. */
  frames: Record<number, number>;
  blocks: Record<string, CatalogEntry>;
  /** Lighting settings, when the extractor found them. */
  env?: LightEnv;
}

function parseState(block: string): Array<[string, string]> {
  const i = block.indexOf("[");
  if (i < 0) return [];
  return block.slice(i + 1, -1).split(",").map((kv) => kv.split("=") as [string, string]);
}

/** The variant to draw for a placed block id such as "minecraft:oak_stairs[facing=north]". */
export function pickVariant<V>(entry: { v: Record<string, V> }, block: string): V | undefined {
  const want = parseState(block);
  const keys = Object.keys(entry.v);
  if (want.length) {
    const hit = keys.find((key) => {
      const have = new Set(key.split(","));
      return want.every(([k, v]) => have.has(`${k}=${v}`));
    });
    if (hit) return entry.v[hit];
  }
  const first = keys[0];
  return first === undefined ? undefined : entry.v[first];
}

export interface SearchHit {
  id: string;
  entry: CatalogEntry;
}

/** Rank: exact name/id, prefix, word-prefix, substring. Every query word must match. */
export function searchCatalog(blocks: Record<string, CatalogEntry>, query: string, limit = 60): SearchHit[] {
  const words = query.toLowerCase().split(/[\s]+/).filter(Boolean);
  if (!words.length) return [];
  const scored: Array<{ score: number; id: string; len: number }> = [];
  for (const id in blocks) {
    const name = blocks[id]!.n.toLowerCase();
    const path = id.slice(id.indexOf(":") + 1).replace(/_/g, " ");
    const hay = `${name} ${path} ${id.slice(0, id.indexOf(":"))}`;
    let score = 0;
    let ok = true;
    for (const w of words) {
      if (name === w || id === w || path === w) score += 100;
      else if (name.startsWith(w) || path.startsWith(w)) score += 60;
      else if (new RegExp(`(^|[\\s:_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(hay)) score += 30;
      else if (hay.includes(w)) score += 10;
      else { ok = false; break; }
    }
    if (ok) scored.push({ score, id, len: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.len - b.len || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((s) => ({ id: s.id, entry: blocks[s.id]! }));
}

/** A catalog entry as sent to the viewer: face texture ids instead of indices. */
export interface WireVariant { f: Array<string | null>; s?: "bottom" | "top"; x?: number; y?: number; l?: number; t?: 1 }
export interface WireEntry { n: string; p?: Props; v: Record<string, WireVariant> }
export interface WireBlocks {
  blocks: Record<string, WireEntry>;
  /** Texture id -> animation frame count, for the textures used. */
  frames: Record<string, number>;
}

export function toWire(cat: Catalog, ids: Array<{ id: string; entry: CatalogEntry }>): WireBlocks {
  const blocks: Record<string, WireEntry> = {};
  const frames: Record<string, number> = {};
  for (const { id, entry } of ids) {
    const v: Record<string, WireVariant> = {};
    for (const [key, variant] of Object.entries(entry.v)) {
      v[key] = {
        f: variant.f.map((i) => {
          if (i < 0) return null;
          const tex = cat.textures[i]!;
          if (cat.frames[i]) frames[tex] = cat.frames[i]!;
          return tex;
        }),
        ...(variant.s ? { s: variant.s } : {}),
        ...(variant.x ? { x: variant.x } : {}),
        ...(variant.y ? { y: variant.y } : {}),
        ...(variant.l ? { l: variant.l } : {}),
        ...(variant.t ? { t: variant.t } : {}),
      };
    }
    blocks[id] = { n: entry.n, ...(entry.p ? { p: entry.p } : {}), v };
  }
  return { blocks, frames };
}
