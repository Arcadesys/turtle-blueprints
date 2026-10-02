/**
 * Selector wand: the pure part. Selections are inclusive boxes in blueprint
 * coordinates; the clipboard stores blocks relative to the box's min corner.
 */
import { applyOps, materials, newBlueprint, type Blueprint, type Op, type Vec3 } from "@tb/blueprint";

export interface Box { min: Vec3; max: Vec3 }

export interface Clip {
  size: Vec3;
  /** [dx, dy, dz, blockId] relative to the copied box's min corner. */
  blocks: Array<[number, number, number, string]>;
}

export function boxOf(a: Vec3, b: Vec3): Box {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

export function boxSize(box: Box): Vec3 {
  return [box.max[0] - box.min[0] + 1, box.max[1] - box.min[1] + 1, box.max[2] - box.min[2] + 1];
}

const inside = (box: Box, x: number, y: number, z: number) =>
  x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2];

export function blocksIn(bp: Blueprint, box: Box): Blueprint["blocks"] {
  return bp.blocks.filter(([x, y, z]) => inside(box, x, y, z));
}

export function copy(bp: Blueprint, box: Box): Clip {
  const [x0, y0, z0] = box.min;
  return { size: boxSize(box), blocks: blocksIn(bp, box).map(([x, y, z, b]) => [x - x0, y - y0, z - z0, b]) };
}

/** Paste with the clip's min corner at `at`. Air in the clip is not stored, so it never overwrites. */
export function pasteOps(clip: Clip, at: Vec3): Op[] {
  return clip.blocks.map(([dx, dy, dz, block]) => ({ op: "set", at: [at[0] + dx, at[1] + dy, at[2] + dz], block }));
}

export function deleteOps(box: Box): Op[] {
  return [{ op: "clear", from: box.min, to: box.max }];
}

/** A new blueprint holding the box's blocks, shifted so the box's min corner is the origin. */
export function extract(bp: Blueprint, box: Box, name: string): Blueprint {
  const desc = `from ${bp.name}, ${box.min.join(",")} to ${box.max.join(",")}`;
  return applyOps(newBlueprint(name, desc), pasteOps(copy(bp, box), [0, 0, 0]));
}

/** Wheel actions clockwise from the top; the page lays the buttons out in this order. */
export const WHEEL = ["copy", "paste", "delete", "new", "generate"] as const;
export type WheelAction = (typeof WHEEL)[number];

/** Angle of slice i, clockwise from straight up, in radians. */
export const wheelAngle = (i: number) => (i / WHEEL.length) * 2 * Math.PI;

/** Which wheel action a mouse flick points at (screen y grows downward), or null inside the dead zone. */
export function wheelSlice(dx: number, dy: number, deadZone = 15): WheelAction | null {
  if (Math.hypot(dx, dy) < deadZone) return null;
  const a = Math.atan2(dx, -dy); // 0 is up, clockwise positive
  const i = Math.round(a / wheelAngle(1)) % WHEEL.length;
  return WHEEL[(i + WHEEL.length) % WHEEL.length]!;
}

const fmt = (v: Vec3) => `[${v.join(", ")}]`;

/** The request handed to headless Claude Code, which drives the turtle-blueprints MCP tools. */
export function generatePrompt(a: {
  name: string;
  request: string;
  bp: Blueprint;
  box: Box | null;
  target: Vec3 | null;
  exportDir: string;
}): string {
  const where: string[] = [];
  if (a.box) {
    const inBox = { ...a.bp, blocks: blocksIn(a.bp, a.box) };
    const mats = materials(inBox).map((m) => `${m.count} x ${m.block}`).join(", ") || "only air";
    where.push(
      `The player selected the box from ${fmt(a.box.min)} to ${fmt(a.box.max)} (size ${boxSize(a.box).join("x")}, x by y by z), which holds ${mats}.`,
      "Build inside that box, or grow outward from it if the request needs more room. Leave blocks outside it alone unless the request says otherwise.",
    );
  } else if (a.target) {
    where.push(`The player pointed at the empty cell ${fmt(a.target)}. Build there, with that cell as the min corner.`);
  } else {
    where.push("Nothing is selected; build wherever fits the existing design.");
  }
  return [
    `You are editing the blueprint "${a.name}" with the turtle-blueprints MCP tools. Coordinates: +x east, +y up, +z south.`,
    ...where,
    "",
    "Request from the player:",
    a.request.trim(),
    "",
    "Steps:",
    `1. blueprint_get "${a.name}" to see the current design.`,
    "2. blueprint_apply to make the change.",
    "3. blueprint_validate and fix any errors.",
    `4. blueprint_export_cc with outPath "${a.exportDir}/${a.name}.txt" (use .json instead if it reports blocks-json).`,
    "5. test_run_build. If the turtle test fails because of the design, fix it and run the test again, at most 3 runs.",
    "Finish with two or three plain sentences: what you built, the test result, and where the export is.",
  ].join("\n");
}
