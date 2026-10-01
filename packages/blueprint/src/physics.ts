/**
 * Walking physics against a voxel world: an upright box with gravity, jumping,
 * collision and auto-step onto half-height blocks. Pure and browser-safe.
 * Cells are unit cubes centred on integers, like everywhere else in the blueprint.
 */

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

/** Vertical extent [bottom, top] of the solid in a cell in world y, or null if the cell is empty. */
export type SolidAt = (x: number, y: number, z: number) => [number, number] | null;

export interface Body {
  /** Feet position (centre of the box's base). */
  x: number;
  y: number;
  z: number;
  vy: number;
  onGround: boolean;
}

export interface StepInput {
  /** Desired horizontal velocity in world units per second. */
  vx: number;
  vz: number;
  jump: boolean;
}

export interface StepOptions {
  /** World y of the floor under everything (the grid). Defaults to -0.5, the bottom of layer 0. */
  groundY?: number;
  gravity?: number;
  jumpSpeed?: number;
  stepHeight?: number;
}

const HALF = PLAYER_WIDTH / 2;
const EPS = 1e-6;

/** True if the player box with feet at (x, y, z) overlaps any solid. */
export function collides(x: number, y: number, z: number, solid: SolidAt): boolean {
  const x0 = Math.floor(x - HALF + 0.5 + EPS), x1 = Math.floor(x + HALF + 0.5 - EPS);
  const y0 = Math.floor(y + 0.5 + EPS), y1 = Math.floor(y + PLAYER_HEIGHT + 0.5 - EPS);
  const z0 = Math.floor(z - HALF + 0.5 + EPS), z1 = Math.floor(z + HALF + 0.5 - EPS);
  for (let ix = x0; ix <= x1; ix++)
    for (let iy = y0; iy <= y1; iy++)
      for (let iz = z0; iz <= z1; iz++) {
        const s = solid(ix, iy, iz);
        if (s && s[0] < y + PLAYER_HEIGHT - EPS && s[1] > y + EPS) return true;
      }
  return false;
}

/** Move the body by `dt` seconds. Mutates and returns it. */
export function stepBody(b: Body, input: StepInput, dt: number, solid: SolidAt, o: StepOptions = {}): Body {
  const groundY = o.groundY ?? -0.5;
  const gravity = o.gravity ?? 28;
  const stepHeight = o.stepHeight ?? 0.51;
  if (input.jump && b.onGround) b.vy = o.jumpSpeed ?? 8.6;
  b.vy = Math.max(b.vy - gravity * dt, -50);
  let grounded = b.onGround;
  b.onGround = false;

  const dx = input.vx * dt, dy = b.vy * dt, dz = input.vz * dt;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / 0.25));
  for (let i = 0; i < n; i++) {
    horizontal(b, "x", dx / n, solid, stepHeight, grounded);
    horizontal(b, "z", dz / n, solid, stepHeight, grounded);
    vertical(b, dy / n, solid);
    grounded = grounded || b.onGround;
    if (b.y <= groundY) {
      b.y = groundY;
      if (b.vy < 0) b.vy = 0;
      b.onGround = true;
    }
  }
  return b;
}

/** Binary search for the farthest free point between a free `from` and a blocked `to`. */
function settle(from: number, to: number, free: (v: number) => boolean): number {
  let lo = from, hi = to;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (free(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function horizontal(b: Body, axis: "x" | "z", d: number, solid: SolidAt, stepHeight: number, grounded: boolean) {
  if (d === 0) return;
  const at = (v: number, y = b.y) => (axis === "x" ? collides(v, y, b.z, solid) : collides(b.x, y, v, solid));
  const from = b[axis];
  const to = from + d;
  if (!at(to)) { b[axis] = to; return; }
  // Blocked: hop up onto a half block if there is room, else stop flush against the wall.
  if (grounded && !at(to, b.y + stepHeight) && !collides(b.x, b.y + stepHeight, b.z, solid)) {
    b[axis] = to;
    b.y += stepHeight;
    return;
  }
  b[axis] = settle(from, to, (v) => !at(v));
}

function vertical(b: Body, d: number, solid: SolidAt) {
  if (d === 0) return;
  const to = b.y + d;
  if (!collides(b.x, to, b.z, solid)) { b.y = to; return; }
  b.y = settle(b.y, to, (v) => !collides(b.x, v, b.z, solid));
  if (d < 0) b.onGround = true;
  b.vy = 0;
}
