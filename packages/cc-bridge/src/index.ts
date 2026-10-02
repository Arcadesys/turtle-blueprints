import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { bounds, type Blueprint, type Vec3 } from "@tb/blueprint";
import { toGadgetsJson } from "@tb/blueprint/gadgets";

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

/** A turtle's disk holds 1,000,000 bytes by default (CC:Tweaked computer_space_limit). */
export const TURTLE_DISK_BYTES = 1_000_000;

/** A cc-factory schema: a Building Gadgets 2 template, which cc-factory builds from and BG2 pastes. */
export interface CcSchema {
  text: string;
  warnings: string[];
}

export function exportSchema(bp: Blueprint): CcSchema {
  const text = toGadgetsJson(bp) + "\n";
  const warnings: string[] = [];
  if (bp.blocks.some((b) => b[3].includes("["))) warnings.push("blockstate is in the template but turtles ignore it today");
  if (text.length > TURTLE_DISK_BYTES) {
    warnings.push(`${Math.round(text.length / 1024)} KB is more than a turtle's default 1 MB disk; split the build or raise computer_space_limit`);
  }
  return { text, warnings };
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
