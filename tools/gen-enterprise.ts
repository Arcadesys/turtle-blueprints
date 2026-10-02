/**
 * Generates blueprints/starship-enterprise.blueprint.json: the TOS Enterprise NCC-1701 (Constitution class,
 * as seen on the 11-foot studio model), 1 block = 2.4 m, nose to the north.
 *
 * Run: npx tsx tools/gen-enterprise.ts   (writes to ./blueprints, or TB_BLUEPRINTS)
 *
 * Real size 288.6 m x 127 m x ~72 m  ->  120 x 53 x 30 blocks (the blueprint limit is 128 per axis).
 *
 * Proportions come from the 11-foot studio model (134 in long: saucer 60 in, nacelles 72.25 in,
 * secondary hull 49 in without the dish, 53.5 in with it) and the fan blueprints that redraw it.
 *
 * Coordinates: +x east, +y up, +z south. Bow is z=0, stern z=120. Centreline is x=CX; port is -x.
 * The hull is a one-block skin; every part is built as a solid shape first, merged, then hollowed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bounds, materials, validate, type Blueprint } from "../packages/blueprint/src/index";

const CX = 32;
const SAUCER_ZC = 26;
const SAUCER_R = 26.5;
const HULL_YC = 7;
const HULL_R = 7;
const NAC_Y = 23;
const NAC_R = 3.5;
const NAC_DX = 13;

// Palette (all from ATM10: vanilla plus Immersive Engineering, AE2, Mekanism)
const HULL = "minecraft:white_concrete";
const PANEL = "minecraft:light_gray_concrete";
const PLATE = "immersiveengineering:sheetmetal_colored_white";
const PLATE_GREY = "immersiveengineering:sheetmetal_colored_light_gray";
const STEEL = "immersiveengineering:sheetmetal_steel";
const GOLD = "immersiveengineering:sheetmetal_gold";
const WINDOW = "minecraft:black_stained_glass";
const DOME = "ae2:smooth_quartz_block";
const BUSSARD = "minecraft:red_stained_glass";
const BUSSARD_CORE = "minecraft:redstone_lamp";
const GLOW = "minecraft:sea_lantern";
const VENT = "minecraft:light_blue_stained_glass";
const INK = "minecraft:black_concrete";
const PORT_LIGHT = "minecraft:redstone_lamp";
const STBD_LIGHT = "minecraft:verdant_froglight";

type Comp = "saucer" | "bridge" | "hull" | "neck" | "nacelle" | "pylon" | "dish";
const solid = new Map<string, Comp>();
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const add = (x: number, y: number, z: number, c: Comp) => solid.set(key(x, y, z), c);
const drop = (x: number, y: number, z: number) => solid.delete(key(x, y, z));
const has = (x: number, y: number, z: number) => solid.has(key(x, y, z));

// ---- saucer profile -------------------------------------------------------------------------
const saucerTop = (rho: number) => 21.4 + 4.2 * Math.pow(1 - rho, 0.8);
const saucerBot = (rho: number) => 19.6 - 3.0 * (1 - rho);
const rhoOf = (x: number, z: number) => Math.hypot(x - CX, z - SAUCER_ZC) / SAUCER_R;

for (let x = CX - 27; x <= CX + 27; x++)
  for (let z = 0; z <= 53; z++) {
    const rho = rhoOf(x, z);
    if (rho > 1) continue;
    for (let y = Math.ceil(saucerBot(rho)); y <= Math.floor(saucerTop(rho)); y++) add(x, y, z, "saucer");
  }

// bridge: a low dome on the top centre with a one-block drum under it
for (let x = CX - 5; x <= CX + 5; x++)
  for (let z = SAUCER_ZC - 5; z <= SAUCER_ZC + 5; z++) {
    const d = Math.hypot(x - CX, z - SAUCER_ZC);
    if (d > 4.6) continue;
    const base = Math.floor(saucerTop(rhoOf(x, z)));
    const h = d <= 3.2 ? 1 + Math.round(2.6 * Math.sqrt(1 - (d / 4.6) ** 2)) : 1;
    for (let y = base; y <= base + h; y++) add(x, y, z, "bridge");
  }
// the little aft bump behind the bridge dome
for (let x = CX - 1; x <= CX + 1; x++)
  for (let z = SAUCER_ZC + 4; z <= SAUCER_ZC + 6; z++) add(x, Math.floor(saucerTop(rhoOf(x, z))) + 1, z, "bridge");

// ---- secondary hull ---------------------------------------------------------------------------
const hullR = (z: number) => {
  if (z < 40 || z > 89) return -1;
  if (z < 44) return 3.5 + ((z - 40) * (HULL_R - 3.5)) / 4; // dish frustum
  if (z <= 80) return HULL_R;
  return HULL_R - ((z - 80) * (HULL_R - 5)) / 9; // gentle taper to the hangar door
};
for (let z = 40; z <= 89; z++) {
  const r = hullR(z);
  for (let x = CX - 8; x <= CX + 8; x++)
    for (let y = HULL_YC - 8; y <= HULL_YC + 8; y++) {
      if (Math.hypot(x - CX, y - HULL_YC) <= r + 0.15) add(x, y, z, z < 44 ? "dish" : "hull");
    }
}
// carve the deflector dish concave
for (let z = 40; z <= 41; z++)
  for (let x = CX - 3; x <= CX + 3; x++)
    for (let y = HULL_YC - 3; y <= HULL_YC + 3; y++) if (Math.hypot(x - CX, y - HULL_YC) <= 2.7) drop(x, y, z);

// ---- neck: a fin from the hull up into the saucer, its trailing edge sloping back from the saucer rim -----
for (let z = 42; z <= 63; z++) {
  const top = z <= 52 ? 19 : 19 - ((z - 52) * 5) / 11;
  for (let y = HULL_YC; y <= Math.floor(top + 0.3); y++) {
    const half = y >= 14 ? 3.6 : 3.6 + (14 - y) * 0.2;
    for (let x = CX - 5; x <= CX + 5; x++) if (Math.abs(x - CX) <= half && !has(x, y, z)) add(x, y, z, "neck");
  }
}

// ---- nacelles ---------------------------------------------------------------------------------
const NAC_Z0 = 55;
const NAC_Z1 = 120;
const nacR = (z: number) => {
  if (z < NAC_Z0 || z > NAC_Z1) return -1;
  if (z < NAC_Z0 + 4) return Math.sqrt(NAC_R ** 2 - (NAC_Z0 + 4 - z) ** 2 * 0.85); // bussard dome
  if (z <= 108) return NAC_R;
  return NAC_R - ((z - 108) * 1.5) / 12; // tail taper
};
for (const side of [-1, 1]) {
  const nx = CX + side * NAC_DX;
  for (let z = NAC_Z0; z <= NAC_Z1; z++) {
    const r = nacR(z);
    if (r < 0) continue;
    for (let x = nx - 4; x <= nx + 4; x++)
      for (let y = NAC_Y - 4; y <= NAC_Y + 4; y++)
        if (Math.hypot(x - nx, y - NAC_Y) <= r + 0.2) add(x, y, z, "nacelle");
  }
  // pylon: a swept blade from the aft hull up and out to the nacelle
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const xc = CX + side * (4 + t * (NAC_DX - 4));
    const yc = 11 + t * 9;
    const z0 = Math.round(74 + t * 14);
    const z1 = Math.round(90 + t * 15);
    for (let z = z0; z <= z1; z++)
      for (const [dx, dy] of [[0, 0], [side, 0], [0, 1], [side, 1]]) {
        const x = Math.round(xc) + dx;
        const y = Math.round(yc) + dy;
        if (!has(x, y, z)) add(x, y, z, "pylon");
      }
  }
}

// ---- hollow to a one-block skin -----------------------------------------------------------------
const N6: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const skin: Array<[number, number, number, Comp]> = [];
for (const [k, comp] of solid) {
  const [x, y, z] = k.split(",").map(Number) as [number, number, number];
  if (N6.some(([a, b, c]) => !has(x + a, y + b, z + c))) skin.push([x, y, z, comp]);
}

// ---- surface treatment -------------------------------------------------------------------------
const out = new Map<string, string>();
const put = (x: number, y: number, z: number, b: string) => out.set(key(x, y, z), b);

function saucerBlock(x: number, y: number, z: number): string {
  const dx = x - CX;
  const dz = z - SAUCER_ZC;
  const rho = rhoOf(x, z);
  const top = y > (saucerTop(rho) + saucerBot(rho)) / 2;
  const ang = Math.atan2(dz, dx);
  const ring = (r: number, w = 0.022) => Math.abs(rho - r) < w;
  // rim: a ring of windows, every other block
  if (rho > 0.93) {
    const seg = Math.round(((ang + Math.PI) / (2 * Math.PI)) * 120);
    if (y === Math.floor(saucerTop(1)) && seg % 2 === 0) return WINDOW;
    return PANEL;
  }
  // second window ring a little inboard on the upper deck line
  if (top && ring(0.8, 0.03)) {
    const seg = Math.round(((ang + Math.PI) / (2 * Math.PI)) * 96);
    return seg % 2 === 0 ? WINDOW : HULL;
  }
  if (top) {
    if (ring(0.5)) return PANEL;
    if (ring(0.66, 0.02)) return PLATE_GREY;
    // spokes
    const spoke = ((ang + Math.PI) / (Math.PI / 8)) % 1;
    if (rho > 0.28 && rho < 0.9 && (spoke < 0.06 || spoke > 0.94)) return PANEL;
    return HULL;
  }
  // underside: sensor dome, panel rings, plated belt
  if (rho < 0.15) return STEEL;
  if (ring(0.2, 0.03) || ring(0.55) || ring(0.78, 0.02)) return PANEL;
  if (rho > 0.2 && rho < 0.5) return PLATE;
  return HULL;
}

for (const [x, y, z, comp] of skin) {
  const dx = x - CX;
  let b = HULL;
  if (comp === "saucer") b = saucerBlock(x, y, z);
  else if (comp === "bridge") {
    const ring = y === Math.floor(saucerTop(rhoOf(x, z))) + 1 && Math.hypot(dx, z - SAUCER_ZC) > 2.5;
    b = ring && (x + z) % 2 === 0 ? WINDOW : DOME;
  } else if (comp === "dish") {
    if (z === 40 || z === 41) b = Math.hypot(dx, y - HULL_YC) < 3.2 ? GOLD : STEEL;
    else b = z === 42 && Math.hypot(dx, y - HULL_YC) < 3 ? GLOW : PANEL;
  } else if (comp === "hull") {
    const side = Math.abs(dx) >= 5 && y >= 7 && y <= 8;
    if (z >= 88) b = z === 89 ? STEEL : PANEL;
    else if (side && z % 2 === 0 && z >= 50 && z <= 78) b = WINDOW;
    else if ((z - 44) % 12 === 0) b = PANEL;
    else if (y <= 1) b = PLATE_GREY;
    else b = HULL;
  } else if (comp === "neck") b = y % 4 === 0 && Math.abs(dx) < 3 ? WINDOW : HULL;
  else if (comp === "pylon") b = z % 6 === 0 ? PANEL : HULL;
  else if (comp === "nacelle") {
    const side = dx < 0 ? -1 : 1;
    const nx = CX + side * NAC_DX;
    const ox = x - nx;
    const oy = y - NAC_Y;
    const outer = Math.sign(ox) === side;
    if (z < NAC_Z0 + 4) b = BUSSARD;
    else if (z >= 117) b = GLOW;
    else if (z > 108) b = z % 2 === 0 ? VENT : PLATE_GREY;
    else if (Math.abs(oy) <= 0 && Math.abs(ox) >= NAC_R - 0.8 && z >= 62 && z <= 104) {
      // long glowing vent strips on both flanks, brighter every fourth block
      b = (z - 62) % 4 === 0 ? GLOW : VENT;
    } else if ((z - 59) % 12 === 0) b = PANEL;
    else if (outer === false && oy < -1.5) b = PLATE_GREY;
    else b = HULL;
  }
  put(x, y, z, b);
}

// bussard cores sit inside the dome as a red lamp (visible through the glass)
for (const side of [-1, 1]) {
  const nx = CX + side * NAC_DX;
  for (let z = NAC_Z0 + 1; z <= NAC_Z0 + 4; z++) put(nx, NAC_Y, z, BUSSARD_CORE);
}

// navigation lights on the saucer rim: red to port, green to starboard, white at the bow
const rimY = Math.floor(saucerTop(1));
put(CX - 26, rimY, SAUCER_ZC, PORT_LIGHT);
put(CX + 26, rimY, SAUCER_ZC, STBD_LIGHT);
put(CX, rimY, 0, GLOW);

// ---- registry: NCC-1701, black 3x5 letters, top port and underside starboard ---------------------------
const FONT: Record<string, string[]> = {
  N: ["X.X", "XXX", "XXX", "X.X", "X.X"],
  C: ["XXX", "X..", "X..", "X..", "XXX"],
  "-": ["...", "...", "XXX", "...", "..."],
  "1": [".X.", "XX.", ".X.", ".X.", "XXX"],
  "7": ["XXX", "..X", ".X.", ".X.", ".X."],
  "0": ["XXX", "X.X", "X.X", "X.X", "XXX"],
};
function stamp(text: string, x0: number, z0: number, top: boolean) {
  let z = z0;
  for (const ch of text) {
    const g = FONT[ch];
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 5; r++) {
        if (g[r][c] !== "X") continue;
        // letter tops point at the centreline: port (top) reads bow to stern with tops toward +x
        const x = top ? x0 + 4 - r : x0 + r;
        const zz = z + c;
        const ys = [...solid].filter(([k, c2]) => c2 === "saucer" && k.startsWith(`${x},`) && k.endsWith(`,${zz}`)).map(([k]) => Number(k.split(",")[1]));
        if (!ys.length) continue;
        const y = top ? Math.max(...ys) : Math.min(...ys);
        if (out.has(key(x, y, zz))) put(x, y, zz, INK);
      }
    z += 4;
  }
}
stamp("NCC-1701", CX - 20, 9, true);
stamp("NCC-1701", CX + 16, 9, false);

// ---- write --------------------------------------------------------------------------------------
const bp: Blueprint = {
  version: 1,
  name: "starship-enterprise",
  description:
    "USS Enterprise NCC-1701 (TOS, Constitution class) at 1 block = 2.4 m: 120 long, 53 wide saucer, 30 high, nose north. " +
    "One-block hollow skin from the 11-foot studio model proportions. Port is -x. Registry on the top port and underside starboard of the saucer.",
  blocks: [...out].map(([k, b]) => [...(k.split(",").map(Number) as [number, number, number]), b] as [number, number, number, string]),
};
bp.blocks.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);

const dir = resolve(process.env.TB_BLUEPRINTS ?? "blueprints");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "starship-enterprise.blueprint.json"), JSON.stringify(bp));

console.log("blocks", bp.blocks.length, "bounds", JSON.stringify(bounds(bp)));
console.log("issues", JSON.stringify(validate(bp)));
for (const m of materials(bp)) console.log(String(m.count).padStart(6), m.block);
