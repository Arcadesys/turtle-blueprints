import * as THREE from "three";
import type { LightVolume } from "./lighting";
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

// --- Minecraft lighting ----------------------------------------------------
// Blocks are unlit materials whose colour is multiplied, per fragment, the way the game does:
// lightmap(block light, sky light) x face shade x ambient occlusion. Light levels come from a
// 3D texture of the cells around the build (see lighting.ts), sampled one half block out from
// the face. Nearest filtering gives flat lighting; linear filtering gives Smooth Lighting, with
// solid cells darkening corners as Minecraft's AO does.

const lightmapTex = new THREE.DataTexture(new Uint8Array(16 * 16 * 4).fill(255), 16, 16);
lightmapTex.magFilter = lightmapTex.minFilter = THREE.LinearFilter;
lightmapTex.needsUpdate = true;
let volumeTex = new THREE.Data3DTexture(new Uint8Array([0, 255, 255, 255]), 1, 1, 1);
const shared = {
  uLightVol: { value: volumeTex },
  uLightmap: { value: lightmapTex },
  uLightOrigin: { value: new THREE.Vector3() },
  uLightSize: { value: new THREE.Vector3(1, 1, 1) },
  uSmooth: { value: 1 },
};

/** Upload the 16x16 lightmap (RGB 0-1, [sky * 16 + block]). */
export function setLightmap(rgb: Float32Array) {
  const d = lightmapTex.image.data as Uint8Array;
  for (let i = 0; i < 256; i++) {
    d[i * 4] = Math.round(rgb[i * 3]! * 255);
    d[i * 4 + 1] = Math.round(rgb[i * 3 + 1]! * 255);
    d[i * 4 + 2] = Math.round(rgb[i * 3 + 2]! * 255);
  }
  lightmapTex.needsUpdate = true;
}

/** Upload the light volume from computeLight. */
export function setLightVolume(v: LightVolume) {
  const [w, h, d] = v.size;
  if (volumeTex.image.width !== w || volumeTex.image.height !== h || volumeTex.image.depth !== d) {
    volumeTex.dispose();
    volumeTex = new THREE.Data3DTexture(v.data, w, h, d);
    shared.uLightVol.value = volumeTex;
  } else volumeTex.image.data = v.data;
  volumeTex.magFilter = volumeTex.minFilter = shared.uSmooth.value ? THREE.LinearFilter : THREE.NearestFilter;
  volumeTex.needsUpdate = true;
  shared.uLightOrigin.value.set(...v.origin);
  shared.uLightSize.value.set(w, h, d);
}

export function setSmoothLighting(on: boolean) {
  shared.uSmooth.value = on ? 1 : 0;
  volumeTex.magFilter = volumeTex.minFilter = on ? THREE.LinearFilter : THREE.NearestFilter;
  volumeTex.needsUpdate = true;
}

/** Make a basic material lit like a Minecraft block; `emit` is the block's own light level. */
function minecraftLit<M extends THREE.MeshBasicMaterial>(m: M, emit: number): M {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, { uEmit: { value: emit / 15 } });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLightPos;\nvarying vec3 vLightN;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        vec4 lightPos = vec4(transformed, 1.0);
        vec3 lightN = normal;
        #ifdef USE_INSTANCING
          lightPos = instanceMatrix * lightPos;
          lightN = mat3(instanceMatrix) * lightN;
        #endif
        vLightPos = (modelMatrix * lightPos).xyz;
        vLightN = mat3(modelMatrix) * lightN;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        precision highp sampler3D;
        uniform sampler3D uLightVol;
        uniform sampler2D uLightmap;
        uniform vec3 uLightOrigin;
        uniform vec3 uLightSize;
        uniform float uSmooth;
        uniform float uEmit;
        varying vec3 vLightPos;
        varying vec3 vLightN;
        vec3 minecraftLight() {
          vec3 n = normalize(vLightN);
          vec3 a = abs(n);
          // ClientLevel.getShade: up 1.0, down 0.5, north/south 0.8, east/west 0.6
          float shade = a.y > 0.5 ? (n.y > 0.0 ? 1.0 : 0.5) : (a.z > a.x ? 0.8 : 0.6);
          vec4 s = texture(uLightVol, (vLightPos + n * 0.5 - uLightOrigin + 0.5) / uLightSize);
          // R and G are light levels with solid cells counted as 0; dividing by B (the share of
          // open cells) averages over the open ones only, as smooth lighting does.
          float open = s.b;
          float blockL = open > 0.01 ? min(s.r / open, 1.0) : 0.0;
          float skyL = open > 0.01 ? min(s.g / open, 1.0) : 0.0;
          blockL = max(blockL, uEmit);
          float ao = mix(1.0, s.a, uSmooth);
          vec3 lm = texture(uLightmap, (vec2(blockL, skyL) * 15.0 + 0.5) / 16.0).rgb;
          // The game multiplies sRGB texture colours; here colours are linear, so decode the factor.
          return pow(lm * shade * ao, vec3(2.2));
        }`)
      .replace("#include <map_fragment>", "#include <map_fragment>\ndiffuseColor.rgb *= minecraftLight();");
  };
  m.customProgramCacheKey = () => "minecraft-lit";
  return m;
}

const materials = new Map<string, THREE.Material[] | THREE.Material>();

/** Textured materials for a block, or a flat hash colour when the catalog has no texture for it. */
export function materialsFor(block: string): THREE.Material[] | THREE.Material {
  const cached = materials.get(block);
  if (cached) return cached;
  const v = variantOf(block);
  const emit = v?.l ?? 0;
  let m: THREE.Material[] | THREE.Material;
  if (v && v.f.some((f) => f)) {
    const fallback = v.f.find((f) => f) as string;
    m = THREE_TO_CATALOG.map((ci) => minecraftLit(new THREE.MeshBasicMaterial({ map: texture(v.f[ci] ?? fallback), transparent: true, alphaTest: 0.1 }), emit));
  } else {
    m = minecraftLit(new THREE.MeshBasicMaterial({ color: hashColor(block) }), emit);
  }
  materials.set(block, m);
  return m;
}

/** What the light pass needs for a block: does it stop light, and how much does it give off. */
export function lightOf(block: string): { opaque: boolean; emit: number } {
  const v = variantOf(block);
  // Without a catalog entry, treat it as an ordinary solid block.
  return { opaque: !v || (!v.t && !v.s), emit: v?.l ?? 0 };
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
