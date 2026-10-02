import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { baseId, bounds, type Blueprint, type Vec3 } from "@tb/blueprint";

/**
 * Where a blueprint block ends up when cc-factory builds it with the default
 * origin (turtle at 0,0,0 facing north) and an export normalised to min=0.
 * Measured with turtlesim (a 5x5 spike): x is mirrored, z is behind the turtle,
 * y is the turtle's own level. See cc-binaries turtlesim/README.md.
 */
export function ccToWorld(rel: Vec3): Vec3 {
  return [-(rel[0] + 1), rel[1], rel[2] + 1];
}

/** Shift a blueprint so its minimum corner is 0,0,0 (cc-factory treats y as absolute). */
export function normalise(bp: Blueprint): Blueprint {
  const bb = bounds(bp);
  if (!bb) return bp;
  return {
    ...bp,
    blocks: bp.blocks.map(([x, y, z, b]) => [x - bb.min[0], y - bb.min[1], z - bb.min[2], b]),
  };
}

// One byte per cell, since cc-factory reads rows a character at a time; "." and " " are air.
// Quote and backslash are left out so the rows stay readable once JSON-escaped.
const SYMBOLS = "#GLTSWBCPFRIOMNKHDEAUXYZQVJ0123456789abcdefghijklmnopqrstuvwxyz@$%&*+!'(),-/:;<=>?[]^_`{|}~";

/** A cc-factory schema: JSON, read by cc-factory's lib_parser. */
export interface CcSchema {
  text: string;
  warnings: string[];
}

type LegendEntry = string | { material: string; meta: { state: Record<string, string> } };

function stateWarnings(bp: Blueprint): string[] {
  return bp.blocks.some((b) => b[3].includes("["))
    ? ["blockstate is carried in meta but ignored by turtles today"]
    : [];
}

/** "mod:block[k=v]" as a cc-factory material plus meta. */
function entryFor(block: string): LegendEntry {
  const m = /\[(.*)\]$/.exec(block);
  if (!m?.[1]) return block;
  return { material: baseId(block), meta: { state: Object.fromEntries(m[1].split(",").map((p) => p.split("="))) } };
}

/** cc-factory `{legend, layers:[{y, rows}]}` JSON: one symbol per distinct block state, rows x across, z down. */
export function toLayersJson(input: Blueprint): CcSchema {
  const bp = normalise(input);
  const states = [...new Set(bp.blocks.map((b) => b[3]))].sort();
  if (states.length > SYMBOLS.length) {
    throw new Error(`${states.length} block states exceed the ${SYMBOLS.length} grid symbols; use toBlocksJson`);
  }
  const symbols = new Map(states.map((b, i) => [b, SYMBOLS[i] as string]));
  const legend = Object.fromEntries(states.map((b) => [symbols.get(b)!, entryFor(b)]));
  const bb = bounds(bp);
  const layers: Array<{ y: number; rows: string[] }> = [];
  if (bb) {
    const cells = new Map(bp.blocks.map((b) => [`${b[0]},${b[1]},${b[2]}`, b[3]]));
    for (let y = 0; y <= bb.max[1]; y++) {
      const rows: string[] = [];
      for (let z = 0; z <= bb.max[2]; z++) {
        let row = "";
        for (let x = 0; x <= bb.max[0]; x++) {
          const b = cells.get(`${x},${y},${z}`);
          row += b ? symbols.get(b) : ".";
        }
        rows.push(row);
      }
      if (rows.some((r) => /[^.]/.test(r))) layers.push({ y, rows });
    }
  }
  // One row per line keeps the file readable and diffable without the bulk of full indentation.
  const text =
    `{"legend":${JSON.stringify(legend, null, 1)},\n"layers":[\n` +
    layers.map((l) => `{"y":${l.y},"rows":[\n${l.rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}`).join(",\n") +
    "\n]}\n";
  return { text, warnings: stateWarnings(bp) };
}

/** cc-factory `{blocks:[{x,y,z,material,meta}]}` JSON: no symbol limit, but several times the size of layers. */
export function toBlocksJson(input: Blueprint): CcSchema {
  const bp = normalise(input);
  const blocks = bp.blocks.map(([x, y, z, b]) => {
    const e = entryFor(b);
    return typeof e === "string" ? { x, y, z, material: e } : { x, y, z, ...e };
  });
  return { text: `{"blocks":[\n${blocks.map((b) => JSON.stringify(b)).join(",\n")}\n]}\n`, warnings: stateWarnings(bp) };
}

/** The cc-factory schema for a blueprint: layers when the block states fit the symbols, else a block list. */
export function exportSchema(bp: Blueprint): CcSchema {
  return new Set(bp.blocks.map((b) => b[3])).size <= SYMBOLS.length ? toLayersJson(bp) : toBlocksJson(bp);
}

export interface CcBinaries {
  root: string;
  turtle: string;
  factory: string;
}

/** Locate a cc-binaries checkout (with turtlesim and cc-factory) or throw. */
export function findCcBinaries(root = process.env.CC_BINARIES ?? resolve(process.cwd(), "../cc-binaries")): CcBinaries {
  const turtle = join(root, "turtlesim", "turtle");
  const factory = join(root, "cc-factory", "factory.lua");
  if (!existsSync(turtle) || !existsSync(factory)) {
    throw new Error(
      `cc-binaries not found at ${root} (need turtlesim/turtle and cc-factory/factory.lua; ` +
        `set CC_BINARIES to a checkout that has the turtlesim and the schema-path fix)`,
    );
  }
  return { root, turtle, factory };
}
