# Changelog

Versions follow [semantic versioning](https://semver.org). The version lives in the root `package.json` and every package matches it.

## v0.1.0 — 2026-10-08

The first versioned release.

- **Blueprints:** `.blueprint.json` files on disk are the source of truth. An MCP server lets Claude create and edit them, and a cc-factory bridge and turtle simulator test builds.
- **Viewer:** a three.js view that reloads live as files change, with Minecraft block textures and lighting, using light levels read from the game and mod code.
- **Selector wand:** select a box and copy, paste, delete, generate with Claude, or save it as a new blueprint from the wheel.
- **Build tool:** place and break blocks by hand, with search across the ATM10 blocks.
- **Walk mode:** first person like Minecraft creative, with gravity, jumping, flight and collision. Shift sprints while walking, Ctrl sprints while flying, and the controls recover cleanly after the window loses focus.
- **VR:** edit blueprints in WebXR (Quest Browser): walk, fly, select and use the wheel with the controllers.
- **Export:** Building Gadgets 2 templates and cc-factory schemas as JSON.
- **Desktop app:** Electron app for macOS and Windows with live Generate progress and a block catalog builder. It shows its version in the window title and About box.
