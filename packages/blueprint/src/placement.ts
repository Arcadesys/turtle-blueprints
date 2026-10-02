/**
 * Minecraft-style placement rules: given the block being placed and where the
 * player clicked, pick the blockstate. Pure and browser-safe.
 */
import { baseId, type Vec3 } from "./index";

/** Property name -> allowed values, as read from the block's blockstate files. */
export type Props = Record<string, string[]>;

export interface Hit {
  /** Face normal of the clicked face (unit axis vector, pointing out of the clicked block). */
  normal: Vec3;
  /** Height of the click within the clicked block, 0 (bottom) to 1 (top). */
  fracY: number;
  /** Direction the player is looking. */
  look: Vec3;
}

const HORIZONTAL = ["north", "south", "east", "west"];
const AXIS = ["x", "y", "z"];

function dirName(v: Vec3): string {
  const [x, y, z] = v;
  if (Math.abs(y) > Math.abs(x) && Math.abs(y) > Math.abs(z)) return y > 0 ? "up" : "down";
  if (Math.abs(x) >= Math.abs(z)) return x > 0 ? "east" : "west";
  return z > 0 ? "south" : "north";
}

const OPPOSITE: Record<string, string> = { north: "south", south: "north", east: "west", west: "east", up: "down", down: "up" };

/** True when the click was on the upper half: the underside of a block, or the upper half of a side face. */
export function clickedUpper(hit: Hit): boolean {
  if (hit.normal[1] < 0) return true;
  if (hit.normal[1] > 0) return false;
  return hit.fracY > 0.5;
}

/** Block id plus state for a block placed with this click. Only sets properties the block really has. */
export function placementState(block: string, props: Props, hit: Hit): string {
  const base = baseId(block);
  const state: Record<string, string> = {};
  const has = (name: string, value: string) => props[name]?.includes(value) === true;

  if (props.axis && has("axis", AXIS[hit.normal.findIndex((n) => n !== 0)] ?? "y")) {
    state.axis = AXIS[hit.normal.findIndex((n) => n !== 0)] ?? "y";
  }

  const facing = props.facing;
  if (facing) {
    const look = dirName(hit.look);
    const horizontal = HORIZONTAL.includes(look) ? look : dirName([hit.look[0], 0, hit.look[2]]);
    let want: string;
    if (facing.includes("up") || facing.includes("down")) {
      // pistons, dispensers, droppers face the player; observers face away.
      want = base.endsWith("observer") ? look : (OPPOSITE[look] as string);
    } else if (base.endsWith("_stairs")) {
      want = horizontal;
    } else {
      want = OPPOSITE[horizontal] as string;
    }
    if (facing.includes(want)) state.facing = want;
  }

  const upper = clickedUpper(hit);
  if (props.half && has("half", "top") && has("half", "bottom")) state.half = upper ? "top" : "bottom";
  if (props.type && has("type", "top") && has("type", "bottom")) state.type = upper ? "top" : "bottom";

  const entries = Object.entries(state);
  return entries.length ? `${base}[${entries.map(([k, v]) => `${k}=${v}`).join(",")}]` : base;
}

function stateOf(block: string, key: string): string | undefined {
  const m = new RegExp(`[\\[,]${key}=([a-z0-9_]+)`).exec(block);
  return m?.[1];
}

/**
 * Placing a slab by clicking an existing half slab of the same kind fills it:
 * returns the double-slab id, or null when the click should place a new block.
 * `hit` is relative to the existing slab.
 */
export function slabMerge(existing: string | undefined, placing: string, hit: Hit): string | null {
  if (!existing || baseId(existing) !== baseId(placing)) return null;
  const type = stateOf(existing, "type");
  if (type !== "bottom" && type !== "top") return null;
  const wantsTop = hit.normal[1] > 0 || (hit.normal[1] === 0 && hit.fracY > 0.5);
  const fills = (type === "bottom" && wantsTop && hit.normal[1] >= 0) || (type === "top" && !wantsTop && hit.normal[1] <= 0);
  if (!fills) return null;
  return existing.replace(/type=(bottom|top)/, "type=double");
}
