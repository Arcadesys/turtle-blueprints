import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  applyOps, bounds, materials, newBlueprint, renderLayer, validate,
  type Blueprint, type Op,
} from "@tb/blueprint";
import { exportSchema, normalise } from "@tb/cc-bridge";
import { formatReport, runBuildTest } from "@tb/tester";

/** Blueprint files on disk are the source of truth; every handler reads and writes them. */
export class Store {
  // No parameter property: the viewer's vite config loads this file with Node's type stripping.
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  path(name: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`bad blueprint name "${name}" (letters, digits, _ and - only)`);
    return join(this.dir, `${name}.blueprint.json`);
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".blueprint.json")).map((f) => f.replace(/\.blueprint\.json$/, "")).sort();
  }

  load(name: string): Blueprint {
    const p = this.path(name);
    if (!existsSync(p)) throw new Error(`no blueprint named "${name}" (have: ${this.list().join(", ") || "none"})`);
    return JSON.parse(readFileSync(p, "utf8")) as Blueprint;
  }

  save(bp: Blueprint): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(bp.name), JSON.stringify(bp) .replace(/\],\[/g, "],\n[") + "\n");
  }
}

function summary(bp: Blueprint): string {
  const bb = bounds(bp);
  const mats = materials(bp).map((m) => `${m.count} x ${m.block}`).join(", ") || "none";
  return `${bp.name}: ${bp.blocks.length} blocks, size ${bb ? bb.size.join("x") : "empty"} (x by y by z); materials: ${mats}`;
}

const MAX_LAYERS_SHOWN = 24;

export function describe(bp: Blueprint, layers?: number[]): string {
  const bb = bounds(bp);
  const lines = [summary(bp)];
  if (!bb) return lines.join("\n");
  const mats = materials(bp);
  const symbols = new Map(mats.map((m, i) => [m.block, "#GLTSWBCPFRIOMNKHDEAUXYZQVJ0123456789abcdefghijklmnopqrstuvwxyz@$%&*+"[i] ?? "?"]));
  lines.push("legend: " + [...symbols].map(([b, s]) => `${s}=${b}`).join("  "));
  lines.push(`columns are x ${bb.min[0]}..${bb.max[0]}, rows are z ${bb.min[2]}..${bb.max[2]}, '.' is air`);
  const wanted: number[] = layers ?? Array.from({ length: bb.size[1] }, (_, i) => bb.min[1] + i);
  for (const y of wanted.slice(0, MAX_LAYERS_SHOWN)) {
    lines.push("", `y=${y}`, ...renderLayer(bp, y, symbols));
  }
  if (wanted.length > MAX_LAYERS_SHOWN) lines.push("", `(${wanted.length - MAX_LAYERS_SHOWN} more layers; pass layers to see them)`);
  return lines.join("\n");
}

export function newTool(store: Store, a: { name: string; description?: string }): string {
  if (existsSync(store.path(a.name))) throw new Error(`"${a.name}" already exists; use blueprint_apply to change it`);
  store.save(newBlueprint(a.name, a.description));
  return `created ${a.name}`;
}

export function applyTool(store: Store, a: { name: string; ops: Op[] }): string {
  const next = applyOps(store.load(a.name), a.ops);
  store.save(next);
  const issues = validate(next);
  return [`applied ${a.ops.length} op(s)`, summary(next), ...issues.map((i) => `${i.level}: ${i.message}`)].join("\n");
}

export function getTool(store: Store, a: { name: string; layers?: number[] }): string {
  return describe(store.load(a.name), a.layers);
}

export function validateTool(store: Store, a: { name: string }): string {
  const issues = validate(store.load(a.name));
  return issues.length ? issues.map((i) => `${i.level}: ${i.message}`).join("\n") : "ok: no issues";
}

export function exportTool(store: Store, a: { name: string; outPath?: string }): string {
  const out = exportSchema(store.load(a.name));
  const warn = out.warnings.map((w) => `warning: ${w}`);
  if (a.outPath) {
    const p = resolve(a.outPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, out.text);
    return [`wrote ${out.format} to ${p}`, ...warn].join("\n");
  }
  return [`${out.format}:`, out.text, ...warn].join("\n");
}

export async function testTool(store: Store, a: { name: string; timeoutSec?: number; ccBinaries?: string }): Promise<string> {
  const bp = store.load(a.name);
  const errors = validate(bp).filter((i) => i.level === "error");
  if (errors.length) return "fix validation errors first:\n" + errors.map((e) => e.message).join("\n");
  const r = await runBuildTest(normalise(bp), {
    ccBinaries: a.ccBinaries,
    timeoutSec: a.timeoutSec,
    workDir: join(store.dir, ".test", a.name),
  });
  return [formatReport(r.report), `results: ${r.resultsDir}`].join("\n");
}
