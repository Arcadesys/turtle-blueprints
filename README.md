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
| `packages/web` | viewer: layer slicer, materials, test report, missing/wrong overlay, selector wand (copy, paste, delete, generate) |

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

### Selector wand

The viewer has a selector wand (toggle with `Q`). Click a block to ping and select it, shift-click a second block to select the box between them, or click the ground to target an empty cell. Dragging still orbits. Each click opens an action wheel:

| action | key | what it does |
| --- | --- | --- |
| Copy | `C` | copies the selected blocks (air is not copied) |
| Paste | `V` | pastes onto the clicked face, or at the clicked ground cell |
| Delete | `X` | clears the selected box |
| New | `N` | saves the selected blocks as a new blueprint (moved so the box starts at 0,0,0), or starts an empty one when nothing is selected, then switches to it |
| Generate | `G` | asks for a request in plain words, then runs headless Claude Code with only this MCP server: it edits the blueprint around the selection, validates it, exports a cc-factory schema to `blueprints/exports/`, and runs the turtle test. Progress and the result show in the sidebar. |

Press `F` to walk, first person like Minecraft creative: WASD and the mouse to look. You start flying (Space/Shift rise and sink); double-tap Space to drop and walk with gravity (Space jumps, Shift sneaks), and double-tap again to fly. Landing on the ground ends a flight. Blocks you can see are solid; if you start inside one you can move out freely. The wand aims from the crosshair while walking: left click selects, right click grows the box, and with the wheel open you flick the mouse toward an action and click (the keys still work). With the cursor free (Esc or `E`, or if the browser refuses to capture the mouse) you keep walking, drag to look, and the wand aims at the cursor; `E` captures the mouse again. Generate frees the cursor so you can type.

Paste and delete write the blueprint file directly. `Ctrl/Cmd+Z` undoes them, and undoes a whole Generate. Generate needs `claude` on the PATH (or set `TB_CLAUDE`), and passes `CC_BINARIES` through for the turtle test.

## Limits to know about

- A turtle test must fit in the turtle's 16 inventory slots (about 1000 blocks); cc-factory does not pull from chests when checking requirements.
- Turtles place a block as the item of the same name. Blockstate (stairs, log axis) is carried but ignored, and doors, beds, redstone dust and fluids will not place.
- cc-factory builds mirrored left to right and behind-left of the turtle. The diff accounts for it; the viewer shows the blueprint as designed.
- A turtlesim exit status only says it did not crash. Judge a build by the report.
