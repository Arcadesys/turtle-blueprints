/**
 * Blueprint core: a sparse voxel model with namespaced block ids.
 *
 * Coordinates: +x east, +y up, +z south (Minecraft). A block id may carry
 * blockstate in Minecraft's syntax, e.g. "minecraft:oak_stairs[facing=north]".
 */

export const AIR = "minecraft:air";

export interface Blueprint {
  version: 1;
  name: string;
  description?: string;
  /** [x, y, z, blockId] — air is never stored. */
  blocks: Array<[number, number, number, string]>;
}

export type Vec3 = [number, number, number];

export type Op =
  | { op: "set"; at: Vec3; block: string }
  | { op: "fill"; from: Vec3; to: Vec3; block: string; mode?: "solid" | "hollow" | "outline" }
  | { op: "clear"; from?: Vec3; to?: Vec3 };

export interface Issue {
  level: "error" | "warning";
  message: string;
}

export const MAX_BLOCKS = 100_000;
const MAX_EXTENT = 128;

const BLOCK_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?$/;

export function newBlueprint(name: string, description?: string): Blueprint {
  return { version: 1, name, ...(description ? { description } : {}), blocks: [] };
}

export function qualify(id: string): string {
  return id.includes(":") ? id : `minecraft:${id}`;
}

/** "mod:block[state]" -> "mod:block" */
export function baseId(block: string): string {
  const i = block.indexOf("[");
  return i < 0 ? block : block.slice(0, i);
}

const k = (x: number, y: number, z: number) => `${x},${y},${z}`;

function toMap(bp: Blueprint): Map<string, [number, number, number, string]> {
  const m = new Map<string, [number, number, number, string]>();
  for (const b of bp.blocks) m.set(k(b[0], b[1], b[2]), b);
  return m;
}

function order(bp: Blueprint): Blueprint {
  bp.blocks.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
  return bp;
}

function checkInt(v: Vec3, what: string) {
  if (!v.every((n) => Number.isInteger(n))) throw new Error(`${what} must be integers, got ${JSON.stringify(v)}`);
}

function lo(a: Vec3, b: Vec3): Vec3 {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}
function hi(a: Vec3, b: Vec3): Vec3 {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

/** Apply operations in order and return a new blueprint (input is not mutated). */
export function applyOps(bp: Blueprint, ops: Op[]): Blueprint {
  const cells = toMap(bp);
  const put = (x: number, y: number, z: number, block: string) => {
    const id = qualify(block);
    if (baseId(id) === AIR) cells.delete(k(x, y, z));
    else cells.set(k(x, y, z), [x, y, z, id]);
  };
  for (const op of ops) {
    if (op.op === "set") {
      checkInt(op.at, "set.at");
      put(...op.at, op.block);
    } else if (op.op === "fill") {
      checkInt(op.from, "fill.from");
      checkInt(op.to, "fill.to");
      const [x0, y0, z0] = lo(op.from, op.to);
      const [x1, y1, z1] = hi(op.from, op.to);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_BLOCKS) {
        throw new Error(`fill covers more than ${MAX_BLOCKS} cells`);
      }
      const mode = op.mode ?? "solid";
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          for (let x = x0; x <= x1; x++) {
            const faces = [x === x0 || x === x1, y === y0 || y === y1, z === z0 || z === z1].filter(Boolean).length;
            if (mode === "hollow" && faces === 0) continue;
            if (mode === "outline" && faces < 2) continue;
            put(x, y, z, op.block);
          }
    } else if (op.op === "clear") {
      if (!op.from || !op.to) {
        cells.clear();
      } else {
        checkInt(op.from, "clear.from");
        checkInt(op.to, "clear.to");
        const [x0, y0, z0] = lo(op.from, op.to);
        const [x1, y1, z1] = hi(op.from, op.to);
        for (const [key, b] of [...cells]) {
          if (b[0] >= x0 && b[0] <= x1 && b[1] >= y0 && b[1] <= y1 && b[2] >= z0 && b[2] <= z1) cells.delete(key);
        }
      }
    } else {
      throw new Error(`unknown op ${JSON.stringify(op)}`);
    }
  }
  return order({ ...bp, blocks: [...cells.values()] });
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}

export function bounds(bp: Blueprint): Bounds | null {
  if (bp.blocks.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const [x, y, z] of bp.blocks) {
    min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
    min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
    min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
  }
  return { min, max, size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1] };
}

/** Material counts by base block id (blockstate stripped), most first. */
export function materials(bp: Blueprint): Array<{ block: string; count: number }> {
  const counts = new Map<string, number>();
  for (const b of bp.blocks) counts.set(baseId(b[3]), (counts.get(baseId(b[3])) ?? 0) + 1);
  return [...counts].map(([block, count]) => ({ block, count })).sort((a, b) => b.count - a.count || a.block.localeCompare(b.block));
}

// Blocks a turtle cannot place as an item of the same name.
const UNPLACEABLE = /(^|[:_])(redstone_wire|water|lava|fire|door|bed|portal|piston_head|moving_piston|cauldron|wall_torch|wall_sign|wall_banner|wall_head|tall_grass|large_fern|double_plant|kelp_plant|bubble_column)$/;

export function isLikelyPlaceable(block: string): boolean {
  return !UNPLACEABLE.test(baseId(block));
}

export function validate(bp: Blueprint): Issue[] {
  const issues: Issue[] = [];
  if (bp.version !== 1) issues.push({ level: "error", message: `unsupported version ${String(bp.version)}` });
  if (!bp.name) issues.push({ level: "error", message: "blueprint needs a name" });
  if (bp.blocks.length > MAX_BLOCKS) issues.push({ level: "error", message: `more than ${MAX_BLOCKS} blocks` });
  const seen = new Set<string>();
  const bad = new Set<string>();
  const unplaceable = new Set<string>();
  for (const [x, y, z, block] of bp.blocks) {
    if (![x, y, z].every(Number.isInteger)) {
      issues.push({ level: "error", message: `non-integer coordinate at ${x},${y},${z}` });
      continue;
    }
    const key = k(x, y, z);
    if (seen.has(key)) issues.push({ level: "error", message: `duplicate block at ${key}` });
    seen.add(key);
    if (!BLOCK_ID.test(block)) bad.add(block);
    else if (baseId(block) === AIR) issues.push({ level: "error", message: `air stored at ${key}` });
    else if (!isLikelyPlaceable(block)) unplaceable.add(baseId(block));
  }
  for (const b of bad) issues.push({ level: "error", message: `invalid block id "${b}" (want namespace:name[state=value])` });
  for (const b of unplaceable) {
    issues.push({ level: "warning", message: `${b} probably cannot be placed by a turtle as an item of the same name` });
  }
  const bb = bounds(bp);
  if (bb && bb.size.some((n) => n > MAX_EXTENT)) {
    issues.push({ level: "error", message: `size ${bb.size.join("x")} exceeds ${MAX_EXTENT} on an axis` });
  }
  if (bp.blocks.some((b) => b[3].includes("["))) {
    issues.push({ level: "warning", message: "blockstate is ignored by turtles today; only the block id is placed" });
  }
  return issues;
}

/** Render one y layer as text: rows are z, columns are x, '.' is air. */
export function renderLayer(bp: Blueprint, y: number, symbols: Map<string, string>): string[] {
  const bb = bounds(bp);
  if (!bb) return [];
  const rows: string[] = [];
  const cells = toMap(bp);
  for (let z = bb.min[2]; z <= bb.max[2]; z++) {
    let row = "";
    for (let x = bb.min[0]; x <= bb.max[0]; x++) {
      const b = cells.get(k(x, y, z));
      row += b ? (symbols.get(baseId(b[3])) ?? "?") : ".";
    }
    rows.push(row);
  }
  return rows;
}

export * from "./placement";
export * from "./raycast";
export * from "./catalog";
