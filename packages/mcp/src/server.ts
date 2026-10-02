#!/usr/bin/env -S npx tsx
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { Store, applyTool, exportTool, gadgetsTool, getTool, listTool, manageTool, newTool, planTool, validateTool } from "./tools";

const store = new Store(resolve(process.env.TB_BLUEPRINTS ?? "blueprints"));
const server = new McpServer({ name: "turtle-blueprints", version: "0.1.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const guard = (fn: () => string | Promise<string>) => async () => {
  try {
    return text(await fn());
  } catch (e) {
    return { ...text(e instanceof Error ? e.message : String(e)), isError: true };
  }
};

const vec = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), at: vec, block: z.string() }),
  z.object({ op: z.literal("fill"), from: vec, to: vec, block: z.string(), mode: z.enum(["solid", "hollow", "outline"]).optional() }),
  z.object({ op: z.literal("clear"), from: vec.optional(), to: vec.optional() }),
]);
const name = z.string().describe("blueprint name: letters, digits, _ and -");

server.registerTool(
  "blueprint_list",
  { description: "List blueprints with block count, size, test status and description, plus archived names." },
  guard(() => listTool(store)),
);

server.registerTool(
  "blueprint_manage",
  {
    description:
      "Manage blueprint files: rename or duplicate (needs to), archive (moves to .archive/, restorable; nothing is deleted), " +
      "restore an archived blueprint, or describe (set the description).",
    inputSchema: {
      action: z.enum(["rename", "duplicate", "archive", "restore", "describe"]),
      name,
      to: name.optional().describe("new name for rename or duplicate"),
      description: z.string().optional(),
    },
  },
  (a) => guard(() => manageTool(store, a))(),
);

server.registerTool(
  "blueprint_build_plan",
  {
    description: "Gathering checklist for building in game: each material in 64-stacks, turtle slots needed (16 max), and validation issues.",
    inputSchema: { name },
  },
  (a) => guard(() => planTool(store, a))(),
);

server.registerTool(
  "blueprint_new",
  { description: "Create an empty blueprint file. Coordinates: +x east, +y up, +z south.", inputSchema: { name, description: z.string().optional() } },
  (a) => guard(() => newTool(store, a))(),
);

server.registerTool(
  "blueprint_apply",
  {
    description:
      "Apply edit operations in order: set (one block), fill (box; mode solid, hollow or outline), clear (region, or everything). " +
      "Use namespaced block ids such as minecraft:stone_bricks or mekanism:steel_casing; minecraft:air removes a block. " +
      "Turtles place blocks as items of the same name, so avoid doors, beds, redstone dust and fluids. Returns a summary and validation issues.",
    inputSchema: { name, ops: z.array(op).min(1) },
  },
  (a) => guard(() => applyTool(store, a))(),
);

server.registerTool(
  "blueprint_get",
  {
    description: "Show a blueprint: size, material counts, and layer-by-layer text (rows are z, columns are x).",
    inputSchema: { name, layers: z.array(z.number().int()).optional().describe("y values to show; default all") },
  },
  (a) => guard(() => getTool(store, a))(),
);

server.registerTool(
  "blueprint_validate",
  { description: "Check block ids, duplicates, size and whether turtles can place each block.", inputSchema: { name } },
  (a) => guard(() => validateTool(store, a))(),
);

server.registerTool(
  "blueprint_export_cc",
  {
    description: "Export the schema a turtle builds from: a Building Gadgets 2 template, which cc-factory reads and BG2's Template Manager pastes. Writes outPath (use .json) if given.",
    inputSchema: { name, outPath: z.string().optional() },
  },
  (a) => guard(() => exportTool(store, a))(),
);

server.registerTool(
  "blueprint_export_gadgets",
  {
    description:
      "Export as a Building Gadgets 2 template (the JSON the Template Manager pastes from the clipboard). Keeps blockstate. " +
      "Writes outPath, default <blueprints>/exports/<name>.bg2.json. The same file is what turtles build from (blueprint_export_cc).",
    inputSchema: { name, outPath: z.string().optional() },
  },
  (a) => guard(() => gadgetsTool(store, a))(),
);

void server.connect(new StdioServerTransport());
