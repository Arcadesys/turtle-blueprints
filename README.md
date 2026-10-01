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
| `packages/blueprint` | sparse voxel model, namespaced block ids (`mod:block[state]`), `set`/`fill`/`clear` ops, validation, material counts |
| `packages/cc-bridge` | exports cc-factory's layered text or blocks JSON, normalises to `layer:0`, finds a cc-binaries checkout, and `ccToWorld` (where cc-factory actually places a block) |
| `packages/tester` | builds a turtlesim world from a blueprint, runs `factory.lua`, diffs placed blocks against the blueprint |
| `packages/mcp` | stdio MCP server: `blueprint_new/apply/get/validate/export_cc/list`, `test_run_build` |
| `packages/assets` | `npm run assets`: builds a block catalog and texture cache from your local ATM10 install (jars, not committed) |
| `packages/web` | viewer and editor: search ATM10 blocks, place/break by hand, layer slicer, materials, test report, missing/wrong overlay |

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

Build the block catalog and textures once (reads your CurseForge ATM10 instance and the vanilla 1.21.1 jar; takes seconds, output goes to the gitignored `.assets/`). Override paths with `ATM10_INSTANCE`, `MC_CLIENT_JAR` and `TB_ASSETS`:

```bash
npm run assets
```

View and edit the blueprints (reloads as files change):

```bash
TB_BLUEPRINTS=blueprints npm run dev -w @tb/web
```

## Editing by hand

When editing is on you hold a wand: it glows in the selected block's colour and swings when you place or break. If no blueprint exists the viewer starts an empty `my-build`.

Search any ATM10 block in the sidebar and click a result to put it in the selected hotbar slot (keys 1-9). Edits write straight to the blueprint file, so Claude and the viewer see each other's changes.

| input | action |
| --- | --- |
| right click | place on the clicked face (blockstate follows Minecraft: stairs face you and take top/bottom from where you click, logs take the clicked axis, furnaces face you, slabs merge into doubles) |
| left click | break |
| middle click | pick the block under the cursor |
| drag | orbit/pan as before; a click only counts if the mouse barely moved |
| `F` or the "Walk mode" button | first person, walking: WASD, Space jump, Ctrl sprint, gravity and collision (steps onto half blocks, jumps one block); double-tap Space to fly (Space up, Shift down, no collision) and again to walk; Esc leaves |
| Cmd/Ctrl+Z, plus Shift | undo / redo |

Slabs render at half height; stairs are approximated as half-height slabs, and other non-cube models as textured cubes. Blocks with custom or runtime textures (about 3,000 of 53,000) show a flat colour.

## Limits to know about

- A turtle test must fit in the turtle's 16 inventory slots (about 1000 blocks); cc-factory does not pull from chests when checking requirements.
- Turtles place a block as the item of the same name. Blockstate (stairs, log axis) is carried but ignored, and doors, beds, redstone dust and fluids will not place.
- cc-factory builds mirrored left to right and behind-left of the turtle. The diff accounts for it; the viewer shows the blueprint as designed.
- A turtlesim exit status only says it did not crash. Judge a build by the report.
