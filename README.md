# turtle-blueprints

**Version 0.1.0** · [Changelog](CHANGELOG.md) · [Releases](https://github.com/Arcadesys/turtle-blueprints/releases)

Design a build with Claude, see it in 3D, then build it with a ComputerCraft turtle or Building Gadgets 2.

```
Claude ──MCP──► blueprint files (.blueprint.json) ──► viewer (three.js, live reload)
                      │
                      └─► Building Gadgets 2 template ─► cc-factory turtle, or BG2 Template Manager
```

Blueprint files on disk are the source of truth. The MCP server holds no state, so edits from Claude, the CLI and your editor all agree.

## Packages

| package | what it does |
| --- | --- |
| `packages/blueprint` | sparse voxel model, namespaced block ids (`mod:block[state]`), `set`/`fill`/`clear` ops, validation, material counts, build plan (64-stacks, turtle slots); `@tb/blueprint/store` reads and manages the files; `@tb/blueprint/gadgets` exports Building Gadgets 2 templates |
| `packages/cc-bridge` | exports the turtle schema (a Building Gadgets 2 template, which cc-factory reads) and warns when it will not fit on a turtle |
| `packages/mcp` | stdio MCP server: `blueprint_new/apply/get/validate/export_cc/export_gadgets/list/manage/build_plan` |
| `packages/assets` | `npm run assets`: builds a block catalog and texture cache from your local ATM10 install (jars, not committed), with each block's light level read from the game and mod code |
| `packages/desktop` | Electron app for Windows and macOS: hosts the viewer and its backend, builds the block catalog from a menu, runs Generate and the MCP server with its own bundled Node |
| `packages/web` | viewer and file manager: create, rename, duplicate, describe, archive/restore; layer slicer; Minecraft lighting with time of day; build prep checklist and schema download; selector wand (copy, paste, delete, generate) |

## Desktop app (Windows and macOS)

The easiest way to use it: no Node, terminal or repo checkout needed.

1. Download the installer (`.dmg` for Mac, `.exe` for Windows) from the [Releases](https://github.com/Arcadesys/turtle-blueprints/releases) page and install it. The builds are not code signed yet: on a Mac, right click the app and choose **Open** the first time; on Windows, choose **More info › Run anyway**.
2. On first launch it offers to build the block catalog. It looks for ATM10 and the Minecraft 1.21.1 jar where CurseForge and the vanilla launcher put them, and asks you to pick the folders if they are somewhere else (**Tools › Build Block Catalog** reruns it, for example after a modpack update).
3. Blueprints live in `Documents/Turtle Blueprints` (starting with the samples from this repo). **File › Choose Blueprints Folder** points the app somewhere else, such as this repo's `blueprints/`.

Generate needs [Claude Code](https://claude.com/claude-code) installed and signed in (`claude auth login`). The app finds it on PATH or where its installers put it; **Tools › Locate Claude Code** sets the path by hand. **Tools › Copy MCP Config for Claude Code** copies an MCP server entry that runs from the installed app, for using the turtle-blueprints tools from your own Claude Code sessions.

To build the app from source:

```bash
npm install
npm run start -w @tb/desktop
```

`npm run dist:mac -w @tb/desktop` or `npm run dist:win -w @tb/desktop` makes an installer in `packages/desktop/release/`; build each on its own OS. Pushing a `v*` tag (or running the **Desktop app** workflow by hand) builds both on GitHub Actions and attaches them to the release.

### Versions

The version is set in the root `package.json`, and every package under `packages/` carries the same one (a test checks). The viewer shows it next to its title, the desktop app in its window title and **About** box. To release: add a section to [CHANGELOG.md](CHANGELOG.md), bump every `package.json` with `npm version <x.y.z> --workspaces --include-workspace-root --no-git-tag-version`, merge, then tag `v<x.y.z>` and push the tag.

## Setup

```bash
npm install
npm test
```

How a template becomes turtle moves, and testing that on a simulated turtle, lives in [cc-binaries](https://github.com/Arcadesys/cc-binaries) (cc-factory and turtlesim).

## Use with Claude Code

```json
{
  "mcpServers": {
    "turtle-blueprints": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/server.ts"],
      "env": { "TB_BLUEPRINTS": "blueprints" }
    }
  }
}
```

Build the block catalog and textures once (reads your CurseForge ATM10 instance and the vanilla 1.21.1 jar, takes seconds, writes the gitignored `.assets/`). Override paths with `ATM10_INSTANCE`, `MC_CLIENT_JAR` and `TB_ASSETS`:

```bash
npm run assets
```

Light levels are not in resource packs; they are in code. The extractor reads them from the deobfuscated client NeoForge installs (`libraries/net/neoforged/neoforge/<v>/neoforge-<v>-client.jar` and `libraries/net/minecraft/client/<v>/client-<v>-srg.jar`; override with `MC_CODE_JARS`, colon-separated) and from each mod jar: it follows every block's `Properties.lightLevel(...)` and `noOcclusion()`, and runs the light function for each blockstate, so a lit furnace is 13 and an unlit one 0, and four lit candles are 12. It also records the overworld's `ambient_light`, the plains sky colour, and your Brightness and Smooth Lighting from the instance's `options.txt`.

View the blueprints (reloads as files change):

```bash
TB_BLUEPRINTS=blueprints npm run dev -w @tb/web
```

## Managing blueprints

Each blueprint is `blueprints/<name>.blueprint.json`. From the viewer or Claude (`blueprint_manage`) you can create, rename, duplicate, describe, archive and restore. Archiving moves the file to `blueprints/.archive/`; nothing is deleted.

## Getting ready to build in game

1. Open the blueprint in the viewer and check **Build prep**: every material in 64-stacks and how many of the turtle's 16 slots the build needs. Fix any warnings (blocks a turtle cannot place).
2. Tick materials off as you gather them (ticks are kept in your browser), or **Copy checklist** to paste somewhere else. Claude's `blueprint_build_plan` gives the same list.
3. **Download schema** saves `<name>.json`, a Building Gadgets 2 template: the same file pastes into a Template Manager and builds on a turtle. Copy it onto the turtle, for example into `saves/<world>/computercraft/computer/<id>/`, and run `factory <name>.json`. A turtle's disk holds 1 MB by default and a template encodes every cell of the bounding box (air too), so the export warns when a build is too big; split it or raise `computer_space_limit` in the CC:Tweaked server config.
4. Load the turtle with the materials and fuel. cc-factory builds behind-left of the turtle, mirrored left to right (see below).

### With Building Gadgets 2 (All the Mods 10)

Blueprints export as Building Gadgets 2 templates, the JSON its Template Manager copies and pastes. It is the same file turtles build from, and cc-factory also builds templates copied out of the game.

1. In the viewer press **Copy for Building Gadgets** (or ask Claude for `blueprint_export_gadgets`, which writes `blueprints/exports/<name>.bg2.json`; copy that file's contents).
2. In game, open a Template Manager, put your Copy-Paste Gadget (or a template or paper) in it, and press **Paste**. The gadget now holds the build; place it like any copy.
3. In survival the gadget takes the blocks from your inventory or linked storage, so gather from the Build prep list first.

Unlike turtles, the gadget keeps blockstate (stairs facing, log axis). Two-block things such as doors and beds need both halves in the blueprint. Every cell of the bounding box is encoded, so very large builds make large templates; split them if a paste is slow or rejected.

### Build tool

Search any ATM10 block in the sidebar and click a result to put it in the selected hotbar slot (keys 1-9). Press `B` (or the Build button; it swaps with the wand) and build by hand: right click places on the clicked face, left click breaks, middle click picks the block under the cursor. Placement follows Minecraft: stairs and furnaces face you, stairs take top or bottom from where you click, logs take the clicked axis, and two slabs merge into a double. It works from orbit view and, while walking, from the crosshair. Undo is the same Ctrl/Cmd+Z as the wand's.

Blocks are drawn with their real textures from your local install. Slabs render at half height and stairs as half-height slabs; other non-cube models are textured cubes, and about 3,000 of the 53,000 blocks with custom textures show a flat colour.

### Lighting

The viewer lights blocks the way Minecraft 1.21.1 does. Sky light falls straight down and block light spreads from torches, lamps and other light blocks, both losing one level per block. Each face takes the light of the cell in front of it through the game's lightmap: warm torchlight, blue moonlight, and your Brightness setting. Faces are shaded as in game (top 1.0, north/south 0.8, east/west 0.6, bottom 0.5). The **Lighting** slider sets the time of day (`/time set` values; the sky colour follows), and **Smooth lighting** blends light across faces and darkens corners the way Minecraft's smooth lighting and ambient occlusion do. The lightmap, face shading and day cycle are ported from the client's `LightTexture`, `ClientLevel` and `DimensionType`. The light-level numbers come from your install (see Setup). Light is worked out for the layers shown, so slicing opens a building to the sky.

### Selector wand

![Box selection of a monitor with the action wheel open](docs/screenshots/01-wand-wheel.jpg)

The viewer has a selector wand (toggle with `Q`). Click a block to ping and select it, shift-click a second block to select the box between them, or click the ground to target an empty cell. Dragging still orbits. Each click opens an action wheel:

| action | key | what it does |
| --- | --- | --- |
| Copy | `C` | copies the selected blocks (air is not copied) |
| Paste | `V` | pastes onto the clicked face, or at the clicked ground cell |
| Delete | `X` | clears the selected box |
| New | `N` | saves the selected blocks as a new blueprint (moved so the box starts at 0,0,0), or starts an empty one when nothing is selected, then switches to it |
| Generate | `G` | asks for a request in plain words, then runs headless Claude Code with only this MCP server: it edits the blueprint around the selection, validates it, and exports the schema (a Building Gadgets 2 template) to `blueprints/exports/`. A card in the top right follows it live: each step Claude takes (reading, placing blocks, validating, exporting) with its result, what Claude says along the way, and the elapsed time. **Stop** ends it early. |

Press `F` to walk, first person like Minecraft creative: WASD and the mouse to look. You start flying (Space/Shift rise and sink, Ctrl sprints at double speed); double-tap Space to drop and walk with gravity (Space jumps, Shift sprints at double speed), and double-tap again to fly. Landing on the ground ends a flight. Blocks you can see are solid; if you start inside one you can move out freely. The wand aims from the crosshair while walking: left click selects, right click grows the box, and with the wheel open you flick the mouse toward an action and click (the keys still work). With the cursor free (Esc or `E`, or if the browser refuses to capture the mouse) you keep walking, drag to look, and the wand aims at the cursor; `E` captures the mouse again. Generate frees the cursor so you can type.

| | |
| --- | --- |
| ![Generate dialog with a plain-language request](docs/screenshots/02-generate.jpg) | ![New blueprint dialog saving a selection](docs/screenshots/03-new-blueprint.jpg) |

![First-person walk mode: crosshair selection with the action wheel](docs/screenshots/04-walking.jpg)

Paste and delete write the blueprint file directly. `Ctrl/Cmd+Z` undoes them, and undoes a whole Generate. Generate needs `claude` on the PATH (or set `TB_CLAUDE`).

### VR (Meta Quest)

An **Enter VR** button appears next to Walk when the browser supports immersive VR (Quest Browser does). WebXR needs HTTPS or localhost, so either plug the Quest in over USB and run `adb reverse tcp:5173 tcp:5173`, then open `http://localhost:5173` in Quest Browser, or serve the dev server over HTTPS (`npm run dev -w @tb/web -- --host` behind a TLS proxy or tunnel). You stand on the ground where the orbit camera was. Left stick walks, right stick flicks to turn 30°, left X (or stick click) toggles flight (right B rises or jumps, left Y sinks or sprints), right trigger selects (hold the grip to grow the box), and holding right A opens the wheel: aim with the right stick, release A or pull the trigger to choose. The Build tool is not available in VR.

## Limits to know about

- Turtles place a block as the item of the same name. Blockstate (stairs, log axis) is carried but ignored, and doors, beds, redstone dust and fluids will not place.
- cc-factory builds mirrored left to right and behind-left of the turtle; the viewer shows the blueprint as designed.
