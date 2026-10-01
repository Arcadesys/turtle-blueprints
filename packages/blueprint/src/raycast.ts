import type { Vec3 } from "./index";

export interface RayHit {
  /** The cell that was hit. For a ground hit this is the (empty) cell just under the floor. */
  cell: Vec3;
  /** Normal of the face that was hit; a block goes in `cell + normal`. */
  normal: Vec3;
  /** World-space hit point (cell centres sit on integer coordinates). */
  point: Vec3;
  /** True when the ray only reached the ground plane, not a block. */
  ground: boolean;
}

export const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * Walk a ray through unit cells centred on integers (Amanatides-Woo). Falls
 * back to the ground plane at world y = groundY (the bottom face of cells at
 * layer groundY + 0.5) when no block is hit.
 */
export function raycast(
  occupied: ReadonlySet<string>,
  origin: Vec3,
  dir: Vec3,
  opts: { maxDistance?: number; groundY?: number } = {},
): RayHit | null {
  const max = opts.maxDistance ?? 160;
  const groundY = opts.groundY ?? -0.5;
  const len = Math.hypot(...dir);
  if (len === 0) return null;
  const d: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  // Shift so cells span [i, i+1).
  const o: Vec3 = [origin[0] + 0.5, origin[1] + 0.5, origin[2] + 0.5];
  const cell: Vec3 = [Math.floor(o[0]), Math.floor(o[1]), Math.floor(o[2])];
  const step = d.map((v) => (v > 0 ? 1 : v < 0 ? -1 : 0)) as Vec3;
  const tDelta = d.map((v) => (v === 0 ? Infinity : Math.abs(1 / v))) as Vec3;
  const tMax = d.map((v, i) => {
    if (v === 0) return Infinity;
    const next = v > 0 ? (cell[i] as number) + 1 : (cell[i] as number);
    return (next - (o[i] as number)) / v;
  }) as Vec3;

  const groundT = d[1] < 0 ? (groundY + 0.5 - o[1]) / d[1] : Infinity;
  let normal: Vec3 = [0, 0, 0];
  let t = 0;
  // A ray starting inside a block hits nothing from the inside; skip the start cell.
  while (t <= max) {
    const axis = tMax[0] <= tMax[1] && tMax[0] <= tMax[2] ? 0 : tMax[1] <= tMax[2] ? 1 : 2;
    t = tMax[axis] as number;
    if (t > max) break;
    if (groundT < t && groundT >= 0) break;
    cell[axis] = (cell[axis] as number) + (step[axis] as number);
    tMax[axis] = (tMax[axis] as number) + (tDelta[axis] as number);
    normal = [0, 0, 0];
    normal[axis] = -(step[axis] as number);
    if (occupied.has(cellKey(...cell))) {
      return { cell: [...cell], normal, point: [o[0] + d[0] * t - 0.5, o[1] + d[1] * t - 0.5, o[2] + d[2] * t - 0.5], ground: false };
    }
  }
  if (groundT >= 0 && groundT <= max) {
    const px = o[0] + d[0] * groundT, pz = o[2] + d[2] * groundT;
    return { cell: [Math.floor(px), Math.floor(groundY + 0.5) - 1, Math.floor(pz)], normal: [0, 1, 0], point: [px - 0.5, groundY, pz - 0.5], ground: true };
  }
  return null;
}
