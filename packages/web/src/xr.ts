/**
 * WebXR (Quest) controls: the pure part. Gamepad numbers in, walk-mode input and rig motion out.
 * Stick y is +down (like screen y), so pushing forward reads negative.
 */
import type { Input } from "./walk";

export const DEADZONE = 0.2;
export const SNAP_ANGLE = Math.PI / 6; // 30 degrees per snap turn
const SNAP_ON = 0.7; // stick x past this turns...
const SNAP_OFF = 0.3; // ...and must come back inside this to turn again

/** The thumbstick of an xr-standard gamepad: axes 2/3, or 0/1 on a pad that only reports one stick. */
export const stickOf = (axes: readonly number[]): [number, number] =>
  axes.length >= 4 ? [axes[2] ?? 0, axes[3] ?? 0] : [axes[0] ?? 0, axes[1] ?? 0];

/** Radial deadzone, rescaled so the stick still ramps up from 0 at the edge of it and reaches 1 at the rim. */
export function deadzone(x: number, y: number, dz = DEADZONE): [number, number] {
  const m = Math.hypot(x, y);
  if (m < dz) return [0, 0];
  const k = Math.min(1, (m - dz) / (1 - dz)) / m;
  return [x * k, y * k];
}

export interface Pad {
  move: readonly [number, number]; // left stick
  rise: readonly [number, number]; // right stick
  jump: boolean; // right B: jump when walking, rise when flying
  sprint: boolean; // left Y: sprint when walking, sink when flying
  flying: boolean;
  /** Horizontal look direction of the headset (x, z). */
  facing: [number, number];
}

/** Left stick walks (up is forward); while flying the right stick's y also rises and sinks. */
export function walkInput(p: Pad): Input {
  const [x, y] = deadzone(p.move[0], p.move[1]);
  const ry = p.flying ? deadzone(p.rise[0], p.rise[1])[1] : 0;
  return {
    facing: p.facing,
    forward: -y,
    right: x,
    up: p.jump || ry < -0.5,
    down: p.sprint || ry > 0.5,
    sprint: false,
  };
}

export interface Snap { turn: -1 | 0 | 1; armed: boolean }

/** Snap turn with edge detection: one turn per flick, then the stick must return to centre. */
export function snapTurn(armed: boolean, x: number): Snap {
  if (!armed) return { turn: 0, armed: Math.abs(x) < SNAP_OFF };
  if (x > SNAP_ON) return { turn: 1, armed: false };
  if (x < -SNAP_ON) return { turn: -1, armed: false };
  return { turn: 0, armed: true };
}

export interface RigPose { x: number; z: number; yaw: number }

/**
 * Turn the rig by `angle` radians (counterclockwise seen from above) so that the point
 * (px, pz), the headset, stays where it is in the world.
 */
export function rotateAbout(r: RigPose, px: number, pz: number, angle: number): RigPose {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = r.x - px, dz = r.z - pz;
  return { x: px + dx * c + dz * s, z: pz - dx * s + dz * c, yaw: r.yaw + angle };
}

/** Rig yaw that makes a headset looking straight ahead face (dx, dz). */
export const yawFacing = (dx: number, dz: number) => Math.atan2(-dx, -dz);

/** Break text into lines of at most `max` characters, at spaces where possible. */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = word;
    while (w.length > max) { // a word longer than a line is cut
      if (cur) { lines.push(cur); cur = ""; }
      lines.push(w.slice(0, max));
      w = w.slice(max);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}
