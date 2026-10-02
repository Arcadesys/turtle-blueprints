import * as THREE from "three";
import { baseId } from "@tb/blueprint";
import { pickVariant, type WireBlocks, type WireEntry, type WireVariant } from "@tb/blueprint/editor";

/** Block catalog entries the viewer has fetched so far, keyed by base block id. */
const entries = new Map<string, WireEntry>();
const missing = new Set<string>();
const frames = new Map<string, number>();
export let catalogMissing = false;

export const entryOf = (id: string): WireEntry | undefined => entries.get(baseId(id));

function remember(res: WireBlocks) {
  for (const [id, e] of Object.entries(res.blocks)) entries.set(id, e);
  for (const [t, n] of Object.entries(res.frames)) frames.set(t, n);
}

/** Fetch catalog entries for block ids we have not seen. Resolves true if anything new arrived. */
export async function ensureBlocks(ids: Iterable<string>): Promise<boolean> {
  const need = [...new Set([...ids].map(baseId))].filter((i) => !entries.has(i) && !missing.has(i));
  if (!need.length) return false;
  for (let i = 0; i < need.length; i += 150) {
    const chunk = need.slice(i, i + 150);
    const res = (await (await fetch(`/api/blocks/lookup?ids=${encodeURIComponent(chunk.join(","))}`)).json()) as WireBlocks & { error?: string };
    if (res.error) catalogMissing = true;
    remember(res);
    for (const id of chunk) if (!entries.has(id)) missing.add(id);
  }
  return true;
}

export function rememberSearch(res: WireBlocks) {
  remember(res);
}

export const textureUrl = (tex: string) => {
  const i = tex.indexOf(":");
  return `/mc/${tex.slice(0, i)}/${tex.slice(i + 1)}.png`;
};

const loader = new THREE.TextureLoader();
const textures = new Map<string, THREE.Texture>();

function texture(id: string): THREE.Texture {
  let t = textures.get(id);
  if (!t) {
    t = loader.load(textureUrl(id));
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    const n = frames.get(id) ?? 1;
    if (n > 1) {
      // Animated strip: show the first frame.
      t.repeat.set(1, 1 / n);
      t.offset.set(0, 1 - 1 / n);
    }
    textures.set(id, t);
  }
  return t;
}

export function hashColor(block: string): THREE.Color {
  let h = 0;
  for (const c of baseId(block)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.45, 0.55);
}

// three's BoxGeometry material order is +x, -x, +y, -y, +z, -z; the catalog's is down, up, north, south, east, west.
const THREE_TO_CATALOG = [4, 5, 1, 0, 3, 2] as const;

export function variantOf(block: string): WireVariant | undefined {
  const e = entryOf(block);
  return e ? pickVariant(e, block) : undefined;
}

const materials = new Map<string, THREE.Material[] | THREE.Material>();

/** Textured materials for a block, or a flat hash colour when the catalog has no texture for it. */
export function materialsFor(block: string): THREE.Material[] | THREE.Material {
  const cached = materials.get(block);
  if (cached) return cached;
  const v = variantOf(block);
  let m: THREE.Material[] | THREE.Material;
  if (v && v.f.some((f) => f)) {
    const fallback = v.f.find((f) => f) as string;
    m = THREE_TO_CATALOG.map((ci) => new THREE.MeshLambertMaterial({ map: texture(v.f[ci] ?? fallback), transparent: true, alphaTest: 0.1 }));
  } else {
    m = new THREE.MeshLambertMaterial({ color: hashColor(block) });
  }
  materials.set(block, m);
  return m;
}

/** Forget cached materials for blocks that rendered as plain colour, once real entries arrive. */
export function dropFallbackMaterials() {
  for (const [k, m] of materials) if (!Array.isArray(m)) materials.delete(k);
}

/** Texture to show as an icon: the north face, else any face. */
export function iconOf(block: string): string | null {
  const v = variantOf(block);
  return v ? (v.f[2] ?? v.f.find((f) => f) ?? null) : null;
}

export type Shape = "cube" | "bottom" | "top";

const geometries: Record<Shape, THREE.BoxGeometry> = {
  cube: new THREE.BoxGeometry(1, 1, 1),
  bottom: halfBox(false),
  top: halfBox(true),
};

/** A half-height box that crops the side textures to the matching half instead of squashing them. */
function halfBox(top: boolean): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(1, 0.5, 1);
  g.translate(0, top ? 0.25 : -0.25, 0);
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  // Faces 0..3 (+x, -x, ...) 4 vertices each; the four side faces are groups 0, 1, 4, 5.
  for (const face of [0, 1, 4, 5]) {
    for (let i = 0; i < 4; i++) {
      const idx = face * 4 + i;
      const v = uv.getY(idx);
      uv.setY(idx, top ? 0.5 + v * 0.5 : v * 0.5);
    }
  }
  return g;
}

export const geometryFor = (shape: Shape) => geometries[shape];

/** Instance orientation: blockstate x then y rotation, both clockwise in Minecraft. */
export function rotationFor(v: WireVariant | undefined): THREE.Euler {
  return new THREE.Euler(-((v?.x ?? 0) * Math.PI) / 180, -((v?.y ?? 0) * Math.PI) / 180, 0, "YXZ");
}
