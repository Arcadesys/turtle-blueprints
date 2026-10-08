/**
 * Player body for walk mode, Minecraft-sized: 0.6 wide, 1.8 tall, eyes at 1.62.
 * Blocks are unit cubes centred on integer coordinates, so cell c spans c-0.5..c+0.5.
 */
export const HALF_WIDTH = 0.3;
export const HEIGHT = 1.8;
export const EYE = 1.62;

export type Solid = (x: number, y: number, z: number) => boolean;
type P3 = [number, number, number];

const EPS = 1e-4;
// Cells whose span overlaps lo..hi (open interval, so touching faces do not count).
const first = (lo: number) => Math.floor(lo + 0.5 + EPS);
const last = (hi: number) => Math.ceil(hi - 0.5 - EPS);

/** Solid cells overlapping a body whose feet are at p. */
function hits(p: P3, solid: Solid): P3[] {
  const out: P3[] = [];
  for (let x = first(p[0] - HALF_WIDTH); x <= last(p[0] + HALF_WIDTH); x++)
    for (let y = first(p[1]); y <= last(p[1] + HEIGHT); y++)
      for (let z = first(p[2] - HALF_WIDTH); z <= last(p[2] + HALF_WIDTH); z++)
        if (solid(x, y, z)) out.push([x, y, z]);
  return out;
}

export interface Moved { feet: P3; hitX: boolean; hitY: boolean; hitZ: boolean; onGround: boolean }

/**
 * Move the body by d, sliding along whatever it bumps into. Axes resolve y, then x, then z,
 * in small sub-steps so a fast fall cannot tunnel through a one-block floor. `floorY` is the
 * ground plane. A body that starts inside blocks moves freely until it is out, so nobody gets stuck.
 */
export function moveBody(feet: P3, d: P3, solid: Solid, floorY: number): Moved {
  const p: P3 = [...feet];
  const r: Moved = { feet: p, hitX: false, hitY: false, hitZ: false, onGround: false };
  const free = hits(p, solid).length === 0;
  const steps = Math.max(1, Math.ceil(Math.max(...d.map(Math.abs)) / 0.4));
  for (let s = 0; s < steps; s++) {
    for (const axis of [1, 0, 2] as const) {
      const step = d[axis] / steps;
      if (!step) continue;
      p[axis] += step;
      let blocked = false;
      if (free) {
        const cells = hits(p, solid);
        if (cells.length) {
          blocked = true;
          const lo = axis === 1 ? 0 : HALF_WIDTH; // body extent below/behind p on this axis
          const hi = axis === 1 ? HEIGHT : HALF_WIDTH; // and above/ahead
          const cs = cells.map((c) => c[axis]);
          p[axis] = step > 0 ? Math.min(...cs) - 0.5 - hi - EPS : Math.max(...cs) + 0.5 + lo + EPS;
        }
      }
      if (axis === 1 && p[1] < floorY) { p[1] = floorY; blocked = true; }
      if (blocked) {
        if (axis === 0) r.hitX = true;
        if (axis === 1) { r.hitY = true; if (step < 0) r.onGround = true; }
        if (axis === 2) r.hitZ = true;
        d = [...d] as P3;
        d[axis] = 0; // stop pushing into it for the remaining sub-steps
      }
    }
  }
  return r;
}

export interface Player { feet: P3; vy: number; flying: boolean; onGround: boolean }
export interface Input {
  /** Horizontal look direction (x, z); need not be normalised. */
  facing: [number, number];
  forward: number; // +1 W, -1 S
  right: number; // +1 D, -1 A
  up: boolean; // Space: rise when flying, jump when walking
  down: boolean; // Shift: sink when flying, sprint when walking
  sprint: boolean; // Ctrl: sprint when flying
}

// Minecraft numbers, in blocks and seconds.
export const FLY_SPEED = 10.9;
export const FLY_SPRINT_SPEED = FLY_SPEED * 2;
export const FLY_VERTICAL = 8;
export const WALK_SPEED = 4.3;
export const SPRINT_SPEED = WALK_SPEED * 2;
export const GRAVITY = 32;
export const JUMP_SPEED = 9; // about a 1.25 block jump
const TERMINAL = 78;

/** Advance the player one frame. Landing while flying ends the flight, as in Minecraft creative. */
export function stepPlayer(pl: Player, inp: Input, dt: number, solid: Solid, floorY: number): Player {
  let [fx, fz] = inp.facing;
  const len = Math.hypot(fx, fz) || 1;
  fx /= len; fz /= len;
  // Right of facing (x, z) is (-z, x): facing north (0, -1) puts east (1, 0) on the right.
  let mx = fx * inp.forward - fz * inp.right;
  let mz = fz * inp.forward + fx * inp.right;
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  const speed = pl.flying ? (inp.sprint ? FLY_SPRINT_SPEED : FLY_SPEED) : inp.down ? SPRINT_SPEED : WALK_SPEED;
  let vy = pl.vy;
  let dy: number;
  if (pl.flying) {
    vy = 0;
    dy = (Number(inp.up) - Number(inp.down)) * FLY_VERTICAL * dt;
  } else {
    if (inp.up && pl.onGround) vy = JUMP_SPEED;
    vy = Math.max(vy - GRAVITY * dt, -TERMINAL);
    dy = vy * dt;
  }
  const out = moveBody(pl.feet, [mx * speed * dt, dy, mz * speed * dt], solid, floorY);
  return {
    feet: out.feet,
    vy: out.hitY ? 0 : vy,
    flying: pl.flying && !out.onGround,
    onGround: out.onGround,
  };
}
