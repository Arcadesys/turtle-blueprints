# turtle-blueprints

Design a build with Claude, see it in 3D, then test it on a simulated ComputerCraft turtle.

```
Claude ──MCP──► blueprint files (.blueprint.json) ──► viewer (three.js, live reload)
                      │
                      └─► cc-factory schema ─► turtlesim ─► built vs planned ─► viewer overlay
```

Blueprint files on disk are the source of truth. The MCP server holds no state, so edits from Claude, the CLI and your editor all agree.

## Packages

| package | what it does |
| --- | --- |
| `packages/blueprint` | sparse voxel model, namespaced block ids (`mod:block[state]`), `set`/`fill`/`clear` ops, validation, material counts, build plan (64-stacks, turtle slots); `@tb/blueprint/store` reads and manages the files; `@tb/blueprint/gadgets` exports Building Gadgets 2 templates |
| `packages/cc-bridge` | exports cc-factory's layered text or blocks JSON, normalises to `layer:0`, finds a cc-binaries checkout, and `ccToWorld` (where cc-factory actually places a block) |
| `packages/tester` | builds a turtlesim world from a blueprint, runs `factory.lua`, diffs placed blocks against the blueprint |
| `packages/mcp` | stdio MCP server: `blueprint_new/apply/get/validate/export_cc/export_gadgets/list/manage/build_plan`, `test_run_build` |
| `packages/web` | viewer and file manager: create, rename, duplicate, describe, archive/restore; layer slicer; build prep checklist and schema download; test report and missing/wrong overlay |

## Setup

```bash
npm install
npm test
```

Tests that run the real simulator need CraftOS-PC and a [cc-binaries](https://github.com/Arcadesys/cc-binaries) checkout that has `turtlesim/` with `--file`, `--results` and `--dump-blocks`, plus the `factory.lua` schema-path fix. Point `CC_BINARIES` at it (default `../cc-binaries`). They skip when it is missing.

## Use with Claude Code

```json
{
  "mcpServers": {
    "turtle-blueprints": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/server.ts"],
      "env": { "TB_BLUEPRINTS": "blueprints", "CC_BINARIES": "../cc-binaries" }
    }
  }
}
```

View the blueprints (reloads as files change):

```bash
TB_BLUEPRINTS=blueprints npm run dev -w @tb/web
```

## Managing blueprints

Each blueprint is `blueprints/<name>.blueprint.json`. From the viewer or Claude (`blueprint_manage`) you can create, rename, duplicate, describe, archive and restore. Archiving moves the file to `blueprints/.archive/`; nothing is deleted. A rename carries the blueprint's turtle test results with it.

## Getting ready to build in game

1. Open the blueprint in the viewer and check **Build prep**: every material in 64-stacks and how many of the turtle's 16 slots the build needs. Fix any warnings (blocks a turtle cannot place).
2. Tick materials off as you gather them (ticks are kept in your browser), or **Copy checklist** to paste somewhere else. Claude's `blueprint_build_plan` gives the same list.
3. **Download schema** saves the cc-factory file (`<name>.txt`, or `.json` for very large palettes). Copy it onto the turtle, for example into `saves/<world>/computercraft/computer/<id>/`, and run `factory <name>.txt`.
4. Load the turtle with the materials and fuel. cc-factory builds behind-left of the turtle, mirrored left to right (see below).

### With Building Gadgets 2 (All the Mods 10)

Blueprints export as Building Gadgets 2 templates, the JSON its Template Manager copies and pastes.

1. In the viewer press **Copy for Building Gadgets** (or ask Claude for `blueprint_export_gadgets`, which writes `blueprints/exports/<name>.bg2.json`; copy that file's contents).
2. In game, open a Template Manager, put your Copy-Paste Gadget (or a template or paper) in it, and press **Paste**. The gadget now holds the build; place it like any copy.
3. In survival the gadget takes the blocks from your inventory or linked storage, so gather from the Build prep list first.

Unlike turtles, the gadget keeps blockstate (stairs facing, log axis). Two-block things such as doors and beds need both halves in the blueprint. Every cell of the bounding box is encoded, so very large builds make large templates; split them if a paste is slow or rejected.

## Limits to know about

- A turtle test must fit in the turtle's 16 inventory slots (about 1000 blocks); cc-factory does not pull from chests when checking requirements.
- Turtles place a block as the item of the same name. Blockstate (stairs, log axis) is carried but ignored, and doors, beds, redstone dust and fluids will not place.
- cc-factory builds mirrored left to right and behind-left of the turtle. The diff accounts for it; the viewer shows the blueprint as designed.
- A turtlesim exit status only says it did not crash. Judge a build by the report.
