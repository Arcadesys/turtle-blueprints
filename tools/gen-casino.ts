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
  { slug: "shut-the-box", label: "Shut-the-box (S 12x12x8)", block: c("light_green"), min: [90, 0, 83], max: [101, STORY, 94], door: "w", doorW: 4, doorH: 7 },
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

function roomOps(r: Room, d: [number, number, number] = [0, 0, 0]): Op[] {
  const sh = (p: [number, number, number]): [number, number, number] => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
  const door = doorOp(r) as Extract<Op, { op: "clear" }>;
  return [
    box(sh(r.min), sh(r.max), r.block),
    { op: "clear", from: sh(door.from!), to: sh(door.to!) },
  ];
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

function save(dir: string, bp: Blueprint) {
  const issues = validate(bp).filter((i) => i.level === "error");
  if (issues.length) throw new Error(`${bp.name}: ${issues.map((i) => i.message).join("; ")}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${bp.name}.blueprint.json`), JSON.stringify(bp).replace(/\],\[/g, "],\n[") + "\n");
  console.log(`${bp.name}: ${bp.blocks.length} blocks`);
}

const dir = resolve(process.env.TB_BLUEPRINTS ?? "blueprints");
save(dir, applyOps(newBlueprint("casino-hall", "Casino hall massing: concourse, gallery, skybridge and room shells (see docs/casino-brief.md)"), hallOps()));
save(dir, applyOps(newBlueprint("entrance", "Veranda, covered porch and vestibule. Local x 0..59 lines up with hall x 30..89."), entranceOps()));
for (const r of rooms) {
  const d: [number, number, number] = [-r.min[0], -r.min[1], -r.min[2]];
  save(dir, applyOps(newBlueprint(`room-${r.slug}`, `${r.label} shell at its own origin`), roomOps(r, d)));
}
