import { describe, expect, it } from "vitest";
import { applyEvent, describeOps, toolLabel, type GenerateJob } from "./checkpoints";

const job = (): GenerateJob => ({ name: "hut", status: "running", checkpoints: [], result: "", started: 0 });
const assistant = (...content: unknown[]) => ({ type: "assistant", message: { content } });
const toolResult = (id: string, text: string, is_error = false) => ({
  type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error, content: [{ type: "text", text }] }] },
});

describe("checkpoints", () => {
  it("labels tool calls in plain words", () => {
    expect(toolLabel("mcp__turtle-blueprints__blueprint_get")).toBe("Reading the blueprint");
    expect(toolLabel("mcp__turtle-blueprints__blueprint_validate")).toBe("Validating");
    expect(toolLabel("mcp__turtle-blueprints__something_new")).toBe("something_new");
  });

  it("summarises blueprint_apply ops", () => {
    expect(describeOps([{ op: "fill" }, { op: "set" }, { op: "set" }, { op: "clear" }])).toBe("1 fill, 2 blocks, 1 clear");
    expect(describeOps([])).toBe("no changes");
    expect(toolLabel("mcp__turtle-blueprints__blueprint_apply", { ops: [{ op: "set" }] })).toBe("Placing 1 block");
  });

  it("follows a run: start, narration, a tool call and its result, the final answer", () => {
    const j = job();
    expect(applyEvent(j, { type: "system", subtype: "init" }, 1)).toBe(true);
    applyEvent(j, assistant({ type: "text", text: "I'll look at the hut first." }, { type: "tool_use", id: "t1", name: "mcp__turtle-blueprints__blueprint_get", input: {} }), 2);
    expect(j.checkpoints.map((c) => [c.kind, c.text, c.state])).toEqual([
      ["note", "Claude Code started", undefined],
      ["note", "I'll look at the hut first.", undefined],
      ["tool", "Reading the blueprint", "running"],
    ]);
    applyEvent(j, toolResult("t1", "hut: 120 blocks, 5x4x5\nmore detail"), 3);
    expect(j.checkpoints[2]).toMatchObject({ state: "ok", detail: "hut: 120 blocks, 5x4x5" });
    applyEvent(j, assistant({ type: "tool_use", id: "t2", name: "mcp__turtle-blueprints__blueprint_validate", input: {} }), 4);
    applyEvent(j, toolResult("t2", "error: floating block", true), 5);
    expect(j.checkpoints[3]).toMatchObject({ text: "Validating", state: "error", detail: "error: floating block" });
    applyEvent(j, { type: "result", result: "Built a hut.", is_error: false }, 6);
    expect(j.result).toBe("Built a hut.");
    expect(j.status).toBe("running"); // the process exit decides done
  });

  it("ignores events with nothing to show", () => {
    const j = job();
    expect(applyEvent(j, assistant({ type: "text", text: "  " }))).toBe(false);
    expect(applyEvent(j, { type: "stream_event" })).toBe(false);
    expect(applyEvent(j, toolResult("unknown", "x"))).toBe(false);
  });
});
