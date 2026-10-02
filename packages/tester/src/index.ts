import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { baseId, materials, type Blueprint, type Vec3 } from "@tb/blueprint";
import { ccToWorld, exportSchema, findCcBinaries, normalise } from "@tb/cc-bridge";

const run = promisify(execFile);

const STACK = 64;
const SLOTS = 16;

export interface WorldPlan {
  lua: string;
  slots: number;
}

/**
 * A turtlesim world for a build test: turtle at 0,0,0 facing north (cc-factory's
 * hardcoded origin), nothing else. cc-factory only counts the turtle's own
 * inventory, so every material has to fit in its 16 slots.
 */
export function makeWorld(bp: Blueprint, opts: { fuel?: number } = {}): WorldPlan {
  const mats = materials(bp);
  const stacks: string[] = [];
  for (const m of mats) {
    for (let left = m.count; left > 0; left -= STACK) stacks.push(`${m.block}:${Math.min(left, STACK)}`);
  }
  if (stacks.length > SLOTS) {
    throw new Error(
      `needs ${stacks.length} inventory slots for ${bp.blocks.length} blocks / ${mats.length} materials; ` +
        `a turtle test holds ${SLOTS} (cc-factory ignores chests when checking requirements)`,
    );
  }
  const fuel = opts.fuel ?? Math.min(20000, 500 + bp.blocks.length * 8);
  const inv = stacks.map((s, i) => `[${i + 1}] = "${s}"`).join(", ");
  const lua = `return {\n  turtle = { x = 0, y = 0, z = 0, facing = "north", fuel = ${fuel}, inventory = { ${inv} } },\n}\n`;
  return { lua, slots: stacks.length };
}

export interface TurtleSummary {
  ok?: boolean;
  fuelUsed: number;
  moves: number;
  dug: number;
  actions: number;
  failures: Record<string, number> | never[];
  finalPos: Vec3;
  blocks?: Array<[number, number, number, string, string?]>;
  note?: string;
}

export interface BuildReport {
  planned: number;
  built: number;
  missing: Array<{ at: Vec3; world: Vec3; block: string }>;
  wrong: Array<{ at: Vec3; world: Vec3; expected: string; actual: string }>;
  extra: number;
  fuelUsed: number;
  moves: number;
  failures: Record<string, number>;
  complete: boolean;
  note?: string;
}

/** Compare the blocks a turtle placed with the blueprint, via the measured cc-factory transform. */
export function diffBuild(bp: Blueprint, summary: TurtleSummary): BuildReport {
  const norm = normalise(bp);
  const actual = new Map<string, string>();
  // Lua encodes an empty table as {}, so only trust real arrays.
  const placed = Array.isArray(summary.blocks) ? summary.blocks : [];
  for (const [x, y, z, name] of placed) actual.set(`${x},${y},${z}`, name);
  const expectedKeys = new Set<string>();
  const missing: BuildReport["missing"] = [];
  const wrong: BuildReport["wrong"] = [];
  let built = 0;
  for (const [x, y, z, block] of norm.blocks) {
    const world = ccToWorld([x, y, z]);
    const key = world.join(",");
    expectedKeys.add(key);
    const have = actual.get(key);
    if (have === undefined) missing.push({ at: [x, y, z], world, block: baseId(block) });
    else if (have !== baseId(block)) wrong.push({ at: [x, y, z], world, expected: baseId(block), actual: have });
    else built++;
  }
  let extra = 0;
  for (const key of actual.keys()) if (!expectedKeys.has(key)) extra++;
  return {
    planned: norm.blocks.length,
    built,
    missing,
    wrong,
    extra,
    fuelUsed: summary.fuelUsed ?? 0,
    moves: summary.moves ?? 0,
    failures: Array.isArray(summary.failures) ? {} : (summary.failures ?? {}),
    complete: missing.length === 0 && wrong.length === 0 && built === norm.blocks.length,
    ...(summary.note ? { note: summary.note } : {}),
  };
}

export interface RunOptions {
  /** cc-binaries checkout; defaults to $CC_BINARIES or ../cc-binaries. */
  ccBinaries?: string;
  /** Where to write the schema, world and turtlesim results. */
  workDir?: string;
  timeoutSec?: number;
  fuel?: number;
}

export interface RunResult {
  report: BuildReport;
  schemaPath: string;
  resultsDir: string;
  output: string;
}

export async function runBuildTest(bp: Blueprint, opts: RunOptions = {}): Promise<RunResult> {
  const cc = findCcBinaries(opts.ccBinaries);
  const work = resolve(opts.workDir ?? join(".turtle-test", bp.name.replace(/[^a-z0-9_-]+/gi, "_")));
  mkdirSync(work, { recursive: true });

  const schema = exportSchema(bp);
  const file = "blueprint.json";
  const schemaPath = join(work, file);
  writeFileSync(schemaPath, schema.text);
  const worldPath = join(work, "world.lua");
  writeFileSync(worldPath, makeWorld(normalise(bp), { fuel: opts.fuel }).lua);
  const resultsDir = join(work, "results");

  const args = [
    cc.turtle, "--world", worldPath, "--file", `${schemaPath}:/${file}`,
    "--results", resultsDir, "--dump-blocks", "--timeout", String(opts.timeoutSec ?? 300),
    cc.factory, file,
  ];
  let output = "";
  try {
    const r = await run("python3", args, { cwd: cc.root, maxBuffer: 64 * 1024 * 1024 });
    output = r.stdout;
  } catch (e) {
    // turtlesim exits non-zero for scripts that finish "unsuccessfully"; the summary still tells the story.
    output = String((e as { stdout?: string }).stdout ?? e);
  }
  const summaryPath = join(resultsDir, "summary.json");
  if (!existsSync(summaryPath)) throw new Error(`turtlesim produced no summary.json; output:\n${output.slice(-2000)}`);
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as TurtleSummary;
  return { report: diffBuild(bp, summary), schemaPath, resultsDir, output };
}

export function formatReport(r: BuildReport): string {
  const lines = [
    `${r.complete ? "PASS" : "FAIL"}: built ${r.built} of ${r.planned} blocks, fuel used ${r.fuelUsed}, moves ${r.moves}`,
  ];
  if (r.missing.length) lines.push(`missing ${r.missing.length}: ${r.missing.slice(0, 5).map((m) => `${m.block}@${m.at}`).join(", ")}${r.missing.length > 5 ? ", ..." : ""}`);
  if (r.wrong.length) lines.push(`wrong ${r.wrong.length}: ${r.wrong.slice(0, 5).map((m) => `${m.expected}->${m.actual}@${m.at}`).join(", ")}`);
  if (r.extra) lines.push(`${r.extra} blocks placed outside the blueprint`);
  const fails = Object.entries(r.failures);
  if (fails.length) lines.push(`failures: ${fails.map(([k, n]) => `${k} x${n}`).join(", ")}`);
  if (r.note) lines.push(`note: ${r.note}`);
  return lines.join("\n");
}
