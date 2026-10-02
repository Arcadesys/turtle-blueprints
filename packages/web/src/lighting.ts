/**
 * Minecraft 1.21.1 lighting, ported from the client: the lightmap (LightTexture.updateLightTexture),
 * the day cycle (DimensionType.timeOfDay, ClientLevel.getSkyDarken, Level.getSkyColor) and the
 * block and sky light flood fill. Per-world numbers (ambient light, sky colour, Brightness,
 * Smooth Lighting) come from the extracted catalog's env; block emission and opacity from its variants.
 */
import type { LightEnv } from "@tb/blueprint/editor";

/** DimensionType.timeOfDay: the sun angle as a fraction of a turn, 0 at noon (dayTime 6000) and 0.5 at midnight. */
export function timeOfDay(dayTime: number): number {
  const d0 = frac(dayTime / 24000 - 0.25);
  const d1 = 0.5 - Math.cos(d0 * Math.PI) / 2;
  return (d0 * 2 + d1) / 3;
}

const frac = (x: number) => x - Math.floor(x);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const lerp = (t: number, a: number, b: number) => a + t * (b - a);

/** ClientLevel.getSkyDarken with clear weather: 1 at noon, 0.2 at midnight. */
export function skyDarken(dayTime: number): number {
  let f = 1 - (Math.cos(timeOfDay(dayTime) * Math.PI * 2) * 2 + 0.2);
  f = 1 - clamp(f, 0, 1);
  return f * 0.8 + 0.2;
}

/** Level.getSkyColor without biome blending or weather: the biome's sky colour dimmed by the sun angle. */
export function skyColor(env: LightEnv, dayTime: number): [number, number, number] {
  const f = clamp(Math.cos(timeOfDay(dayTime) * Math.PI * 2) * 2 + 0.5, 0, 1);
  return [((env.sky >> 16) & 255) / 255 * f, ((env.sky >> 8) & 255) / 255 * f, (env.sky & 255) / 255 * f];
}

/** LightTexture.getBrightness. */
function brightness(ambient: number, level: number): number {
  const f = level / 15;
  return lerp(ambient, f / (4 - 3 * f), 1);
}

const notGamma = (v: number) => 1 - (1 - v) ** 4;

/**
 * LightTexture.updateLightTexture for the overworld in clear weather, no potion effects, the
 * torch flicker at rest. Returns 16x16 RGB in 0-1, indexed [sky * 16 + block], in the game's
 * (sRGB) space: the game multiplies texture colours by it directly.
 */
export function lightmap(env: LightEnv, dayTime: number): Float32Array {
  const out = new Float32Array(16 * 16 * 3);
  const darken = skyDarken(dayTime);
  const skyFactor = darken * 0.95 + 0.05;
  // new Vector3f(darken, darken, 1).lerp(new Vector3f(1, 1, 1), 0.35)
  const skyCol = [lerp(0.35, darken, 1), lerp(0.35, darken, 1), 1];
  const blockFactor = 1.5; // blockLightRedFlicker + 1.5, flicker averaging 0
  for (let sky = 0; sky < 16; sky++) {
    for (let block = 0; block < 16; block++) {
      const s = brightness(env.ambient, sky) * skyFactor;
      const b = brightness(env.ambient, block) * blockFactor;
      let c = [b, b * ((b * 0.6 + 0.4) * 0.6 + 0.4), b * (b * b * 0.6 + 0.4)];
      c = c.map((v, i) => lerp(0.04, v + skyCol[i]! * s, 0.75));
      // clampColor, then the Brightness setting pulls toward notGamma
      c = c.map((v) => clamp(v, 0, 1));
      c = c.map((v) => lerp(Math.max(0, env.gamma), v, notGamma(v)));
      c = c.map((v) => clamp(lerp(0.04, v, 0.75), 0, 1));
      out.set(c, (sky * 16 + block) * 3);
    }
  }
  return out;
}

/** What the light pass needs to know about a cell. */
export interface LightCell {
  /** Blocks light (a full cube without noOcclusion). */
  opaque: boolean;
  /** Light it gives off, 0-15. */
  emit: number;
}

export interface LightVolume {
  /** World cell at texel (0, 0, 0). */
  origin: [number, number, number];
  size: [number, number, number];
  /**
   * RGBA per cell, x fastest then y then z: R block light and G sky light (level * 17),
   * B 255 where light can be (not opaque), A the ambient-occlusion weight (255 open, 51 opaque, as Minecraft's 0.2).
   */
  data: Uint8Array<ArrayBuffer>;
}

const PAD = 4;

/**
 * Flood-fill block and sky light over the cells' bounding box plus a margin. Sky light comes
 * straight down from the top at 15 through anything not opaque, then spreads losing one per
 * step, as does block light from emitters. Everything below `floorY` is solid ground.
 */
export function computeLight(cells: ReadonlyArray<readonly [number, number, number, LightCell]>, floorY: number): LightVolume {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    for (let i = 0; i < 3; i++) {
      const v = c[i] as number;
      if (v < lo[i]!) lo[i] = v;
      if (v > hi[i]!) hi[i] = v;
    }
  }
  const ground = Math.round(floorY + 0.5); // lowest buildable layer
  if (!cells.length) { lo.splice(0, 3, 0, ground, 0); hi.splice(0, 3, 0, ground, 0); }
  const origin: [number, number, number] = [lo[0]! - PAD, Math.min(lo[1]!, ground) - 1, lo[2]! - PAD];
  const size: [number, number, number] = [hi[0]! - lo[0]! + 1 + 2 * PAD, hi[1]! + PAD + 1 - origin[1], hi[2]! - lo[2]! + 1 + 2 * PAD];
  const [w, h, d] = size;
  const n = w * h * d;
  const opaque = new Uint8Array(n);
  const block = new Uint8Array(n);
  const sky = new Uint8Array(n);
  const idx = (x: number, y: number, z: number) => x + w * (y + h * z);
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) for (let y = 0; y < h && origin[1] + y < ground; y++) opaque[idx(x, y, z)] = 1;
  const queue: number[] = [];
  for (const [x, y, z, c] of cells) {
    const i = idx(x - origin[0], y - origin[1], z - origin[2]);
    if (c.opaque) opaque[i] = 1;
    if (c.emit > block[i]!) { block[i] = c.emit; queue.push(i); }
  }
  spread(block, opaque, queue, w, h, d);
  // Sky: straight down at full strength until something opaque.
  queue.length = 0;
  for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
    for (let y = h - 1; y >= 0; y--) {
      const i = idx(x, y, z);
      if (opaque[i]) break;
      sky[i] = 15;
      queue.push(i);
    }
  }
  spread(sky, opaque, queue, w, h, d);
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = block[i]! * 17;
    data[i * 4 + 1] = sky[i]! * 17;
    data[i * 4 + 2] = opaque[i] ? 0 : 255;
    data[i * 4 + 3] = opaque[i] ? 51 : 255;
  }
  return { origin, size, data };
}

/** Breadth-first spread: each step to a non-opaque neighbour loses one level. */
function spread(level: Uint8Array, opaque: Uint8Array, queue: number[], w: number, h: number, d: number) {
  const wh = w * h;
  const to = (j: number, l: number) => {
    if (!opaque[j] && level[j]! < l) { level[j] = l; queue.push(j); }
  };
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    const l = level[i]! - 1;
    if (l <= 0) continue;
    const x = i % w, y = ((i / w) | 0) % h, z = (i / wh) | 0;
    if (x > 0) to(i - 1, l);
    if (x < w - 1) to(i + 1, l);
    if (y > 0) to(i - w, l);
    if (y < h - 1) to(i + w, l);
    if (z > 0) to(i - wh, l);
    if (z < d - 1) to(i + wh, l);
  }
}
