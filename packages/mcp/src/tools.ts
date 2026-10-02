import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  applyOps, bounds, buildPlan, materials, renderLayer, validate, TURTLE_SLOTS,
  type Blueprint, type Op,
} from "@tb/blueprint";
import { Store } from "@tb/blueprint/store";
import { gadgetsCells, toGadgetsJson } from "@tb/blueprint/gadgets";
import { exportSchema, normalise } from "@tb/cc-bridge";
import { formatReport, runBuildTest } from "@tb/tester";

export { Store };

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
  if (store.exists(a.name)) throw new Error(`"${a.name}" already exists; use blueprint_apply to change it`);
  store.create(a.name, a.description);
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
    return [`wrote cc-factory schema to ${p}`, ...warn].join("\n");
  }
  return [out.text, ...warn].join("\n");
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

export function listTool(store: Store): string {
  const live = store.list().map((n) => {
    const i = store.info(n);
    return `${n}: ${i.blocks} blocks, ${i.size ? i.size.join("x") : "empty"}${i.tested ? ", tested" : ""}${i.description ? ` - ${i.description}` : ""}`;
  });
  const archived = store.listArchived();
  return [
    ...(live.length ? live : ["no blueprints yet"]),
    ...(archived.length ? ["", `archived: ${archived.join(", ")}`] : []),
  ].join("\n");
}

export function manageTool(
  store: Store,
  a: { action: "rename" | "duplicate" | "archive" | "restore" | "describe"; name: string; to?: string; description?: string },
): string {
  const need = (v: string | undefined, what: string) => {
    if (!v) throw new Error(`${a.action} needs ${what}`);
    return v;
  };
  switch (a.action) {
    case "rename": store.rename(a.name, need(a.to, "to")); return `renamed ${a.name} to ${a.to}`;
    case "duplicate": store.duplicate(a.name, need(a.to, "to")); return `copied ${a.name} to ${a.to}`;
    case "archive": store.archive(a.name); return `archived ${a.name} (restore with action restore)`;
    case "restore": store.restore(a.name); return `restored ${a.name}`;
    case "describe": store.describe(a.name, a.description ?? ""); return `updated description of ${a.name}`;
  }
}

/** Gathering list for an in-game build: stacks per material and whether one turtle load covers it. */
export function formatPlan(bp: Blueprint): string {
  const p = buildPlan(bp);
  const lines = [`${bp.name}: ${p.total} blocks, ${p.slots} of ${TURTLE_SLOTS} turtle slots`];
  for (const m of p.materials) {
    const parts = [m.stacks && `${m.stacks} x 64`, m.extra && `${m.extra}`].filter(Boolean).join(" + ");
    lines.push(`  [ ] ${m.block}: ${m.count} (${parts})`);
  }
  if (!p.fitsInTurtle) {
    lines.push(`does not fit in one turtle load: cc-factory checks requirements up front, so split the build or cut materials`);
  }
  for (const i of p.issues) lines.push(`${i.level}: ${i.message}`);
  return lines.join("\n");
}

export function planTool(store: Store, a: { name: string }): string {
  return formatPlan(store.load(a.name));
}

/** Above this many bounding-box cells a template is slow to paste and may be too big to send to the server. */
export const GADGETS_WARN_CELLS = 500_000;

/** Building Gadgets 2 template JSON, written to a file because it is too long to read in chat. */
export function gadgetsTool(store: Store, a: { name: string; outPath?: string }): string {
  const bp = store.load(a.name);
  const p = resolve(a.outPath ?? join(store.dir, "exports", `${a.name}.bg2.json`));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, toGadgetsJson(bp) + "\n");
  const cells = gadgetsCells(bp);
  return [
    `wrote Building Gadgets 2 template to ${p} (${bp.blocks.length} blocks in a ${cells}-cell box)`,
    "in game: copy the file's contents, open a Template Manager with a Copy-Paste Gadget or paper in it, press Paste",
    ...(cells > GADGETS_WARN_CELLS ? [`warning: ${cells} cells is large; the paste may be slow or rejected, so consider splitting it`] : []),
  ].join("\n");
}
