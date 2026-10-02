/**
 * Generates the casino massing blueprints (see docs/casino-brief.md):
 *   casino-hall   the whole hall as coloured room shells, concourse, gallery and skybridge
 *   entrance      veranda, covered porch and vestibule (local origin, x 0..59 lines up with hall x 30..89)
 *   room-<slug>   each room alone, at its own origin, so it can be reviewed and replaced
 *
 * Run: npx tsx tools/gen-casino.ts   (writes to ./blueprints, or TB_BLUEPRINTS)
 *
 * Coordinates: +x east, +y up, +z south. North is z=0, the entrance is at the south.
 * Room shells are hollow boxes; a shell's listed size is its outer size.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyOps, newBlueprint, validate, type Blueprint, type Op } from "../packages/blueprint/src/index";

type Side = "e" | "w" | "s";
interface Room {
  slug: string;
  label: string;
  block: string;
  min: [number, number, number];
  max: [number, number, number];
  door: Side; // face that opens onto the concourse
  doorW: number;
  doorH: number;
  walls?: Partial<Record<Side | "n", Wall>>; // overrides for the pop art wall treatment
}

type Motif = "panel" | "slash" | "stripe" | "dots" | "none";
interface Wall {
  base: string; // concrete colour name
  accent: string;
  motif: Motif;
}

const c = (name: string) => `minecraft:${name}_concrete`;
const STORY = 12; // ground story height; gallery floor is y=12
const TOP = 24;

const rooms: Room[] = [
  // North leg (z 6..29)
  { slug: "derby-bar", label: "Derby bar", block: c("orange"), min: [30, 0, 6], max: [53, TOP, 29], door: "s", doorW: 14, doorH: 10 },
  { slug: "stair-hall", label: "Grand stair", block: c("white"), min: [54, 0, 6], max: [65, TOP, 29], door: "s", doorW: 8, doorH: 10 },
  { slug: "theater", label: "Theater", block: c("purple"), min: [66, 0, 6], max: [89, TOP, 29], door: "s", doorW: 10, doorH: 10 },
  // West leg, casino arm (x 6..29, doors face east)
  { slug: "cashier", label: "Cashier cage", block: c("lime"), min: [6, 0, 88], max: [29, STORY, 94], door: "e", doorW: 6, doorH: 7 },
  { slug: "slots-hall", label: "Slots hall", block: c("yellow"), min: [6, 0, 64], max: [29, STORY, 87], door: "e", doorW: 14, doorH: 8 },
  { slug: "blackjack-pit", label: "Blackjack pit", block: c("red"), min: [6, 0, 44], max: [29, STORY, 63], door: "e", doorW: 14, doorH: 8 },
  // West leg, floor 2
  { slug: "vip-1", label: "VIP 1", block: c("magenta"), min: [6, STORY, 78], max: [29, TOP, 94], door: "e", doorW: 4, doorH: 6 },
  { slug: "vip-2", label: "VIP 2", block: c("magenta"), min: [6, STORY, 61], max: [29, TOP, 77], door: "e", doorW: 4, doorH: 6 },
  { slug: "vip-3", label: "VIP 3", block: c("magenta"), min: [6, STORY, 44], max: [29, TOP, 60], door: "e", doorW: 4, doorH: 6 },
  // East leg, ground (doors face west)
  {
    slug: "shut-the-box", label: "Shut-the-box (S 12x12x8)", block: c("light_green"), min: [90, 0, 83], max: [101, STORY, 94], door: "w", doorW: 4, doorH: 7,
    walls: {
      n: { base: "cyan", accent: "yellow", motif: "panel" },
      s: { base: "yellow", accent: "light_blue", motif: "slash" },
      e: { base: "magenta", accent: "white", motif: "stripe" },
      w: { base: "red", accent: "white", motif: "none" },
    },
  },
  { slug: "golf-sim", label: "Golf sim (M 16x16x10)", block: c("green"), min: [90, 0, 67], max: [105, STORY, 82], door: "w", doorW: 4, doorH: 7 },
  { slug: "dungeon-crawler", label: "Dungeon crawler (M stub)", block: c("gray"), min: [90, 0, 51], max: [105, STORY, 66], door: "w", doorW: 4, doorH: 7 },
  // East leg, floor 2 (L 16x24x12)
  { slug: "baseball", label: "Baseball (L)", block: c("blue"), min: [90, STORY, 79], max: [113, TOP, 94], door: "w", doorW: 4, doorH: 7 },
  { slug: "faceball", label: "Faceball (L)", block: c("cyan"), min: [90, STORY, 63], max: [113, TOP, 78], door: "w", doorW: 4, doorH: 7 },
  { slug: "bowling", label: "Bowling (L)", block: c("light_blue"), min: [90, STORY, 47], max: [113, TOP, 62], door: "w", doorW: 4, doorH: 7 },
];

const box = (a: [number, number, number], b: [number, number, number], block: string): Op =>
  ({ op: "fill", from: a, to: b, block, mode: "hollow" });

function doorOp(r: Room): Op {
  const [x0, y0, z0] = r.min;
  const [x1, , z1] = r.max;
  const lo = (mid: number) => mid - Math.floor(r.doorW / 2);
  const hi = (mid: number) => lo(mid) + r.doorW - 1;
  const yTop = y0 + r.doorH;
  if (r.door === "s") {
    const mid = Math.floor((x0 + x1) / 2);
    return { op: "clear", from: [lo(mid), y0 + 1, z1], to: [hi(mid), yTop, z1] };
  }
  const mid = Math.floor((z0 + z1) / 2);
  const x = r.door === "e" ? x1 : x0;
  return { op: "clear", from: [x, y0 + 1, lo(mid)], to: [x, yTop, hi(mid)] };
}

// Pop art treatment: every room is a flat-colour panel world with black ink lines, in the
// manner of a comic panel. Each wall gets a base colour, a black frame and one motif.
// Themes. "pop" is dyed concrete; "neon" is steel and glowing blocks with no dye at all.
// Run `npx tsx tools/gen-casino.ts neon` to write the *-neon blueprints next to the pop ones.
type Role = "base" | "accent" | "ink" | "floor" | "rim";
interface Theme {
  suffix: string;
  paint: (col: string, role: Role) => string;
  swap: Record<string, string>; // hall and entrance materials
  arch: { body: string; band: (i: number) => string }; // giant arch ribs: body and the glowing or gilded rings
}
const STEEL = ["polished_deepslate", "deepslate_tiles", "smooth_stone", "polished_blackstone_bricks"];
// Four neon colours: three dyed Simply Light illuminant blocks and white sea lanterns (no dye).
const NEON: Record<string, string> = {
  cyan: "simplylight:illuminant_cyan_block_on[on=true]",
  magenta: "simplylight:illuminant_magenta_block_on[on=true]",
  yellow: "simplylight:illuminant_yellow_block_on[on=true]",
  white: "minecraft:sea_lantern",
};
const NEON_COLOURS = Object.keys(NEON);
const hash = (str: string) => [...str].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
const themes: Record<string, Theme> = {
  pop: { suffix: "", paint: (col, role) => c(role === "ink" || role === "rim" ? "black" : role === "floor" ? "white" : col), swap: {},
    arch: { body: "minecraft:polished_blackstone", band: () => "minecraft:gold_block" },
  },
  neon: {
    suffix: "-neon",
    paint: (col, role) =>
      role === "accent" || role === "rim"
        ? NEON[col]
        : "minecraft:" + (role === "ink" ? "blackstone" : role === "floor" ? "polished_deepslate" : STEEL[hash(col) % STEEL.length]),
    arch: { body: "minecraft:polished_deepslate", band: (i) => NEON[NEON_COLOURS[i % 3]] },
    swap: {
      "minecraft:gold_block": NEON.cyan,
      "minecraft:smooth_quartz": "minecraft:polished_deepslate",
      "minecraft:quartz_block": "minecraft:iron_block",
      "minecraft:glass": "minecraft:tinted_glass",
    },
  },
};
const theme = themes[process.argv[2] ?? "pop"] ?? (() => { throw new Error(`unknown theme ${process.argv[2]}`); })();

const POP = ["red", "yellow", "cyan", "magenta", "blue", "orange", "lime", "light_blue"];
const OPPOSITE: Record<"n" | Side, "n" | Side> = { n: "s", s: "n", e: "w", w: "e" };

function wallsFor(r: Room): Record<"n" | Side, Wall> {
  const k = rooms.indexOf(r);
  const own = r.block.replace("minecraft:", "").replace("_concrete", "");
  const picks: string[] = [own];
  for (let i = 0; picks.length < 4; i++) {
    const col = POP[(k + i * 2) % POP.length];
    if (!picks.includes(col)) picks.push(col);
  }
  const side: ("n" | Side)[] = (["n", "s", "e", "w"] as const).filter((f) => f !== r.door && f !== OPPOSITE[r.door]);
  const faces: Record<string, Wall> = {};
  const order: ("n" | Side)[] = [OPPOSITE[r.door], r.door, side[0], side[1]];
  const motifs: Motif[] = ["panel", "dots", "slash", "stripe"];
  order.forEach((f, i) => (faces[f] = { base: picks[i], accent: theme.suffix ? NEON_COLOURS[(k + i) % 4] : picks[(i + 1) % 4], motif: motifs[i] }));
  return { ...(faces as Record<"n" | Side, Wall>), ...(theme.suffix ? {} : r.walls) };
}

function popOps(r: Room, d: [number, number, number]): Op[] {
  const ops: Op[] = [];
  const [x0, y0, z0] = r.min;
  const [x1, y1, z1] = r.max;
  const W = x1 - x0 + 1;
  const D = z1 - z0 + 1;
  const H = y1 - y0 + 1;
  const put = (x: number, y: number, z: number, col: string, role: Role) =>
    ops.push({ op: "set", at: [x + d[0], y + d[1], z + d[2]], block: theme.paint(col, role) });

  // Floor: white with a black diagonal and a coloured one, black at the corners.
  const walls = wallsFor(r);
  const rimIdx = rooms.indexOf(r) % 3; // rim lines use the three dyed colours, never white
  ops.push({ op: "fill", from: [x0 + d[0], y0 + d[1], z0 + d[2]], to: [x1 + d[0], y0 + d[1], z1 + d[2]], block: theme.paint("white", "floor") });
  for (let i = 0; i < W; i++) put(x0 + i, y0, z1 - Math.round((i / (W - 1)) * (D - 1)), theme.suffix ? walls.w.accent : walls.w.base, "accent");
  for (let i = 0; i < W; i++) put(x0 + i, y0, z0 + Math.round((i / (W - 1)) * (D - 1)), "black", "ink");
  for (const [x, z] of [[x0, z1], [x1, z0]]) put(x, y0, z, "black", "ink");

  const faces: { f: "n" | Side; len: number; at: (u: number, v: number) => [number, number, number] }[] = [
    { f: "n", len: W, at: (u, v) => [x0 + u, y0 + v, z0] },
    { f: "s", len: W, at: (u, v) => [x0 + u, y0 + v, z1] },
    { f: "w", len: D, at: (u, v) => [x0, y0 + v, z0 + u] },
    { f: "e", len: D, at: (u, v) => [x1, y0 + v, z0 + u] },
  ];
  for (const { f, len, at } of faces) {
    const wall = walls[f];
    const paint = (u: number, v: number, col: string, role: Role) => put(...at(u, v), col, role);
    for (let v = 1; v <= H - 2; v++) {
      for (let u = 0; u < len; u++) {
        const frame = u === 0 || u === len - 1 || v === H - 2;
        if (v === H - 2 && u > 0 && u < len - 1) paint(u, v, NEON_COLOURS[rimIdx], "rim");
        else paint(u, v, frame ? "black" : wall.base, frame ? "ink" : "base");
      }
    }
    const inner = (u: number, v: number) => u >= 1 && u <= len - 2 && v >= 1 && v <= H - 3;
    if (wall.motif === "panel") {
      const w = Math.max(2, Math.round(len / 3));
      const h = Math.max(2, Math.round(H / 6));
      const u0 = Math.floor((len - w) / 2);
      const v0 = Math.floor((H - h) / 2);
      for (let v = v0 - 1; v <= v0 + h; v++)
        for (let u = u0 - 1; u <= u0 + w; u++) {
          const core = u >= u0 && u < u0 + w && v >= v0 && v < v0 + h;
          if (inner(u, v)) paint(u, v, core ? "black" : wall.accent, core ? "ink" : "accent");
        }
    } else if (wall.motif === "slash" || wall.motif === "stripe") {
      for (let v = 1; v <= H - 3; v++) {
        const run = Math.round(((v - 1) * (len - 3)) / (H - 4));
        if (wall.motif === "slash") {
          if (inner(1 + run + 1, v)) paint(1 + run + 1, v, wall.accent, "accent");
          paint(1 + run, v, "black", "ink");
        } else paint(len - 2 - run, v, wall.accent, "accent");
      }
    } else if (wall.motif === "dots") {
      // Ben-Day dots: staggered rows, every other block row.
      for (let v = 2; v <= H - 4; v += 2)
        for (let u = 1 + ((v / 2) % 2) * 2; u <= len - 2; u += 4) paint(u, v, wall.accent, "accent");
    }
  }
  return ops;
}

function roomOps(r: Room, d: [number, number, number] = [0, 0, 0]): Op[] {
  const sh = (p: [number, number, number]): [number, number, number] => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  const door = doorOp(r) as Extract<Op, { op: "clear" }>;
  return [
    box(sh(r.min), sh(r.max), theme.suffix ? theme.paint(r.block, "base") : r.block),
    ...popOps(r, d),
    { op: "clear", from: sh(door.from!), to: sh(door.to!) },
  ];
}

// Giant arches: superellipse ribs spanning the whole site east-west, stilted so they clear the room roofs.
// Rise varies along the building (tallest over the atrium), tied by a crown spine and two purlins.
const ARCH = { cx: 59.5, a: 60, n: 3, zs: [10, 26, 42, 58, 74, 90, 106], depth: 2, ring: 10 };
const archRise = (z: number) => 42 + 20 * (1 - ((z - 58) / 52) ** 2);
const archY = (x: number, rise: number) => rise * (1 - (Math.abs(x - ARCH.cx) / ARCH.a) ** ARCH.n) ** (1 / ARCH.n);

function archOps(): Op[] {
  const ops: Op[] = [];
  const seen = new Set<string>();
  const put = (x: number, y: number, z: number, block: string) => {
    const k = `${x},${y},${z}`;
    if (y < 0 || seen.has(k)) return;
    seen.add(k);
    ops.push({ op: "set", at: [x, y, z], block });
  };
  const plus = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  ARCH.zs.forEach((z, i) => {
    const rise = archRise(z);
    const N = 900;
    let prev: [number, number] | null = null;
    let len = 0;
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * Math.PI;
      const ct = Math.cos(t);
      const x = ARCH.cx + Math.sign(ct) * ARCH.a * Math.abs(ct) ** (2 / ARCH.n);
      const y = rise * Math.abs(Math.sin(t)) ** (2 / ARCH.n);
      if (prev) len += Math.hypot(x - prev[0], y - prev[1]);
      prev = [x, y];
      const ring = len % ARCH.ring < 2;
      const block = ring ? theme.arch.band(i) : theme.arch.body;
      for (const [dx, dy] of plus)
        for (let dz = 0; dz < ARCH.depth; dz++) put(Math.round(x) + dx, Math.round(y) + dy, z + dz, block);
    }
  });
  // Crown spine and purlins follow the arch tops, interpolating the rise between ribs.
  const lines: [number, number][] = [[0, 2], [-24, 1], [24, 1]];
  for (let z = ARCH.zs[0]; z <= ARCH.zs[ARCH.zs.length - 1] + 1; z++) {
    for (const [dx, w] of lines) {
      const x = Math.round(ARCH.cx + dx);
      const y = Math.round(archY(x, archRise(z)));
      for (let ox = 0; ox < w; ox++) for (let oy = 0; oy < w; oy++) put(x + ox, y + oy, z, dx === 0 ? theme.arch.band(0) : theme.arch.body);
    }
  }
  return ops;
}

function hallOps(): Op[] {
  const ops: Op[] = [];
  // Ground: concourse floor and atrium court.
  ops.push({ op: "fill", from: [30, 0, 30], to: [89, 0, 94], block: "minecraft:polished_blackstone" });
  ops.push({ op: "fill", from: [44, 0, 44], to: [75, 0, 94], block: "minecraft:smooth_quartz" });
  // Atrium centrepiece (placeholder).
  ops.push({ op: "fill", from: [57, 1, 66], to: [62, 3, 71], block: "minecraft:quartz_block" });
  ops.push({ op: "fill", from: [58, 4, 67], to: [61, 4, 70], block: "minecraft:sea_lantern" });
  // Lobby across the south end.
  ops.push(box([30, 0, 95], [89, 14, 108], "minecraft:smooth_quartz"));
  ops.push({ op: "clear", from: [52, 1, 108], to: [67, 9, 108] }); // to the vestibule
  ops.push({ op: "clear", from: [44, 1, 95], to: [75, 9, 95] }); // lobby opens onto the concourse
  // Gallery (floor 2) ring on the outer 6 of the concourse, with gold balustrade.
  ops.push({ op: "fill", from: [30, STORY, 30], to: [35, STORY, 94], block: "minecraft:polished_blackstone" });
  ops.push({ op: "fill", from: [84, STORY, 30], to: [89, STORY, 94], block: "minecraft:polished_blackstone" });
  ops.push({ op: "fill", from: [36, STORY, 30], to: [83, STORY, 35], block: "minecraft:polished_blackstone" });
  ops.push({ op: "fill", from: [35, STORY + 1, 36], to: [35, STORY + 1, 94], block: "minecraft:gold_block" });
  ops.push({ op: "fill", from: [84, STORY + 1, 36], to: [84, STORY + 1, 94], block: "minecraft:gold_block" });
  ops.push({ op: "fill", from: [36, STORY + 1, 35], to: [83, STORY + 1, 35], block: "minecraft:gold_block" });
  // Skybridge across the atrium at z 58..62.
  ops.push({ op: "clear", from: [35, STORY + 1, 58], to: [35, STORY + 1, 62] });
  ops.push({ op: "clear", from: [84, STORY + 1, 58], to: [84, STORY + 1, 62] });
  ops.push({ op: "fill", from: [36, STORY, 58], to: [83, STORY, 62], block: "minecraft:smooth_quartz" });
  ops.push({ op: "fill", from: [36, STORY + 1, 58], to: [83, STORY + 1, 58], block: "minecraft:gold_block" });
  ops.push({ op: "fill", from: [36, STORY + 1, 62], to: [83, STORY + 1, 62], block: "minecraft:gold_block" });
  // Glass roof over the concourse and atrium.
  ops.push({ op: "fill", from: [36, TOP, 36], to: [83, TOP, 94], block: "minecraft:glass" });
  for (const r of rooms) ops.push(...roomOps(r));
  ops.push(...archOps());
  return ops;
}

function entranceOps(): Op[] {
  const ops: Op[] = [];
  // Vestibule: z 0..5, centred on the lobby doorway (hall x 52..67 -> local 22..37).
  ops.push(box([18, 0, 0], [41, 16, 5], "minecraft:smooth_quartz"));
  ops.push({ op: "clear", from: [22, 1, 0], to: [37, 9, 0] }); // to the lobby
  ops.push({ op: "clear", from: [22, 1, 5], to: [37, 9, 5] }); // to the porch
  // Covered porch: z 6..13, roof at y 12, gold-banded columns.
  ops.push({ op: "fill", from: [18, 0, 6], to: [41, 0, 13], block: "minecraft:polished_blackstone" });
  ops.push({ op: "fill", from: [18, 12, 6], to: [41, 12, 13], block: "minecraft:smooth_quartz" });
  for (const x of [18, 24, 30, 35, 41]) {
    ops.push({ op: "fill", from: [x, 1, 13], to: [x, 11, 13], block: "minecraft:polished_blackstone" });
    for (const y of [3, 7, 11]) ops.push({ op: "set", at: [x, y, 13], block: "minecraft:gold_block" });
  }
  // Veranda: z 14..21 at floor level, 50 wide, then steps down to the street.
  ops.push({ op: "fill", from: [5, 0, 14], to: [54, 0, 21], block: "minecraft:polished_blackstone" });
  ops.push({ op: "fill", from: [18, 0, 6], to: [41, 0, 13], block: "minecraft:polished_blackstone" });
  ops.push({ op: "fill", from: [5, -1, 22], to: [54, 0, 22], block: "minecraft:polished_blackstone_bricks" });
  ops.push({ op: "fill", from: [5, -2, 23], to: [54, 0, 23], block: "minecraft:polished_blackstone_bricks" });
  ops.push({ op: "fill", from: [5, -3, 24], to: [54, 0, 24], block: "minecraft:polished_blackstone_bricks" });
  ops.push({ op: "fill", from: [5, -3, 25], to: [54, -3, 25], block: "minecraft:stone_bricks" });
  // Balustrade along the front edge, broken for the grand stair, with lamp posts at each end.
  ops.push({ op: "fill", from: [5, 1, 21], to: [14, 1, 21], block: "minecraft:gold_block" });
  ops.push({ op: "fill", from: [45, 1, 21], to: [54, 1, 21], block: "minecraft:gold_block" });
  for (const x of [5, 54]) {
    ops.push({ op: "fill", from: [x, 1, 16], to: [x, 4, 16], block: "minecraft:polished_blackstone" });
    ops.push({ op: "set", at: [x, 5, 16], block: "minecraft:sea_lantern" });
  }
  return ops;
}

const themed = (ops: Op[]): Op[] =>
  ops.map((o) => ("block" in o && o.block in theme.swap ? { ...o, block: theme.swap[o.block] } : o));

function save(dir: string, bp: Blueprint) {
  bp.name += theme.suffix;
  const issues = validate(bp).filter((i) => i.level === "error");
  if (issues.length) throw new Error(`${bp.name}: ${issues.map((i) => i.message).join("; ")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${bp.name}.blueprint.json`), JSON.stringify(bp).replace(/\],\[/g, "],\n[") + "\n");
  console.log(`${bp.name}: ${bp.blocks.length} blocks`);
}

const dir = resolve(process.env.TB_BLUEPRINTS ?? "blueprints");
save(dir, applyOps(newBlueprint("casino-hall", "Casino hall massing: concourse, gallery, skybridge, room shells and giant arches (see docs/casino-brief.md)"), themed(hallOps())));
save(dir, applyOps(newBlueprint("entrance", "Veranda, covered porch and vestibule. Local x 0..59 lines up with hall x 30..89."), themed(entranceOps())));
for (const r of rooms) {
  const d: [number, number, number] = [-r.min[0], -r.min[1], -r.min[2]];
  save(dir, applyOps(newBlueprint(`room-${r.slug}`, `${r.label} shell at its own origin`), roomOps(r, d)));
}
