/**
 * Generate progress: turns Claude Code's stream-json events into checkpoints a player can follow.
 * The server builds them; the viewer only renders what it is sent.
 */

export interface Checkpoint {
  /** note: something Claude said; tool: an MCP tool call. */
  kind: "note" | "tool";
  text: string;
  /** First line of a tool's result. */
  detail?: string;
  state?: "running" | "ok" | "error";
  /** tool_use id, to match the result to its call. */
  id?: string;
  at: number;
}

export interface GenerateJob {
  name: string;
  status: "running" | "done" | "failed" | "stopped";
  checkpoints: Checkpoint[];
  result: string;
  started: number;
  finished?: number;
}

type Input = Record<string, unknown>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an op list does, e.g. "2 fills, 14 blocks, 1 clear". */
export function describeOps(ops: unknown): string {
  if (!Array.isArray(ops)) return "changes";
  const n = { set: 0, fill: 0, clear: 0 };
  for (const o of ops) {
    const k = (o as Input | null)?.op;
    if (k === "set" || k === "fill" || k === "clear") n[k]++;
  }
  const parts = [n.fill && plural(n.fill, "fill"), n.set && plural(n.set, "block"), n.clear && plural(n.clear, "clear")].filter(Boolean);
  return parts.join(", ") || "no changes";
}

/** A plain-words label for a turtle-blueprints tool call. */
export function toolLabel(tool: string, input: Input = {}): string {
  const name = tool.replace(/^mcp__turtle-blueprints__/, "");
  switch (name) {
    case "blueprint_get": return "Reading the blueprint";
    case "blueprint_list": return "Listing blueprints";
    case "blueprint_apply": return `Placing ${describeOps(input.ops)}`;
    case "blueprint_validate": return "Validating";
    case "blueprint_export_cc": return "Exporting the cc-factory schema";
    case "blueprint_export_gadgets": return "Exporting the Building Gadgets template";
    case "blueprint_build_plan": return "Working out materials";
    case "blueprint_new": return `Creating ${String(input.name ?? "a blueprint")}`;
    case "blueprint_manage": return `${String(input.action ?? "Managing")} ${String(input.name ?? "")}`.trim();
    default: return name;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("\n");
  return "";
}

const firstLine = (s: string, max = 160) => {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Fold one stream-json event into the job. Returns true if anything a viewer shows changed. */
export function applyEvent(job: GenerateJob, ev: any, now = Date.now()): boolean {
  if (ev?.type === "system" && ev.subtype === "init") {
    job.checkpoints.push({ kind: "note", text: "Claude Code started", at: now });
    return true;
  }
  if (ev?.type === "assistant") {
    let changed = false;
    for (const c of ev.message?.content ?? []) {
      if (c.type === "text" && String(c.text).trim()) {
        job.checkpoints.push({ kind: "note", text: String(c.text).trim(), at: now });
        changed = true;
      } else if (c.type === "tool_use") {
        job.checkpoints.push({ kind: "tool", text: toolLabel(String(c.name), c.input), state: "running", id: c.id, at: now });
        changed = true;
      }
    }
    return changed;
  }
  if (ev?.type === "user") {
    let changed = false;
    for (const c of ev.message?.content ?? []) {
      if (c.type !== "tool_result") continue;
      const cp = job.checkpoints.find((p) => p.id === c.tool_use_id);
      if (!cp) continue;
      cp.state = c.is_error ? "error" : "ok";
      const line = firstLine(resultText(c.content));
      if (line) cp.detail = line;
      changed = true;
    }
    return changed;
  }
  if (ev?.type === "result") {
    job.result = String(ev.result ?? "");
    if (ev.is_error) job.status = "failed";
    return true;
  }
  return false;
}
