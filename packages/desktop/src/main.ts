/**
 * Turtle Blueprints desktop app: hosts the viewer and its backend on a private localhost port
 * and opens it in a window. Settings (blueprints folder, Claude Code) live in the
 * app's user data folder and are changed from the menus.
 */
import { createServer, type Server } from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { app, BrowserWindow, clipboard, dialog, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { defaultPaths } from "@tb/assets";
import { CATALOG_VERSION } from "@tb/blueprint/editor";
import { createApi } from "../../web/server/routes";
import { findClaude, loadSettings, loginShellPath, saveSettings, type Settings } from "./settings";

const dist = __dirname;
/** Files a separate process runs can't be read from inside app.asar; electron-builder unpacks them. */
const unpacked = (f: string) => join(dist, f).replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const settingsFile = () => join(app.getPath("userData"), "settings.json");
const assetsDir = () => join(app.getPath("userData"), "assets");

/** The catalog's version, read from the start of the file (it is large), or 0 when there is none. */
function catalogVersion(): number {
  try {
    const fd = openSync(join(assetsDir(), "catalog.json"), "r");
    const head = Buffer.alloc(64);
    readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    return Number(/"version":(\d+)/.exec(head.toString("utf8"))?.[1] ?? 0);
  } catch {
    return 0;
  }
}

let settings: Settings = {};
let win: BrowserWindow | null = null;
let origin = "";

const shellPath = loginShellPath();
if (shellPath) process.env.PATH = [shellPath, process.env.PATH].filter(Boolean).join(":");

function update(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  saveSettings(settingsFile(), settings);
}

function blueprintsDir(): string {
  return settings.blueprints ?? join(app.getPath("documents"), "Turtle Blueprints");
}

/** A new blueprints folder starts with the sample blueprints shipped with the app. */
function ensureBlueprints() {
  const dir = blueprintsDir();
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  const samples = join(dist, "samples");
  if (!existsSync(samples)) return;
  for (const f of readdirSync(samples)) writeFileSync(join(dir, f), readFileSync(join(samples, f)));
}

function claudePath(): string {
  return findClaude({ configured: settings.claude, path: process.env.PATH, home: homedir(), appData: process.env.APPDATA });
}

/** How Claude Code starts the MCP server: this app's own binary, running as plain Node. */
function mcpServer(blueprints: string) {
  return {
    command: process.execPath,
    args: [unpacked("mcp.cjs")],
    env: { ELECTRON_RUN_AS_NODE: "1", TB_BLUEPRINTS: blueprints },
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

/** The viewer's static files plus /api and /mc, on 127.0.0.1 only. */
function startServer(): Promise<Server> {
  const { api, textures } = createApi({
    blueprints: blueprintsDir,
    assets: assetsDir,
    mcpServer,
    claude: claudePath,
    cwd: blueprintsDir,
    noCatalog: "No block catalog yet: use Tools › Build Block Catalog.",
  });
  const web = join(dist, "web");
  const server = createServer((req, res) => {
    // Answer only requests addressed to this server, so a web page can't reach it by DNS rebinding.
    if (req.headers.host !== new URL(origin).host) {
      res.statusCode = 403;
      return res.end();
    }
    const notFound = () => { res.statusCode = 404; res.end("not found"); };
    const path = (req.url ?? "/").split("?")[0]!;
    for (const [mount, handler] of [["/api", api], ["/mc", textures]] as const) {
      if (path === mount || path.startsWith(mount + "/")) {
        req.url = req.url!.slice(mount.length) || "/";
        return handler(req, res, notFound);
      }
    }
    const file = normalize(join(web, decodeURIComponent(path === "/" ? "/index.html" : path)));
    if (!file.startsWith(web + sep) || !existsSync(file) || !statSync(file).isFile()) return notFound();
    res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve(server);
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 800, minHeight: 500,
    title: `Turtle Blueprints v${app.getVersion()}`,
    backgroundColor: "#161715",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); void shell.openExternal(url); }
  });
  win.on("closed", () => { win = null; });
  void win.loadURL(origin);
}

async function chooseBlueprints() {
  const r = await dialog.showOpenDialog(win!, {
    title: "Choose blueprints folder", defaultPath: blueprintsDir(),
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return;
  update({ blueprints: r.filePaths[0] });
  win?.reload();
}

async function chooseClaude() {
  const r = await dialog.showOpenDialog(win!, {
    title: "Locate the claude CLI", defaultPath: settings.claude ?? homedir(),
    message: `Currently using: ${claudePath()}`, properties: ["openFile", "showHiddenFiles"],
  });
  if (!r.canceled && r.filePaths[0]) update({ claude: r.filePaths[0] });
}

let building = false;
/** Find (or ask for) the ATM10 instance and client jar, then build the catalog in a worker. */
async function buildCatalog() {
  if (building || !win) return;
  const d = defaultPaths();
  const found = (saved: string | undefined, list: string[]) => [saved, ...list].find((p): p is string => !!p && existsSync(p));
  let instance = found(settings.instance, d.instance);
  let clientJar = found(settings.clientJar, d.clientJar);
  if (instance && clientJar) {
    const r = await dialog.showMessageBox(win, {
      type: "question", message: "Build the block catalog from these files?",
      detail: `ATM10 instance:\n${instance}\n\nMinecraft 1.21.1 jar:\n${clientJar}`,
      buttons: ["Build", "Choose Other Files…", "Cancel"], defaultId: 0, cancelId: 2,
    });
    if (r.response === 2) return;
    if (r.response === 1) instance = clientJar = undefined;
  }
  if (!instance) {
    const r = await dialog.showOpenDialog(win, {
      title: "Choose your ATM10 instance folder (the one with mods/ in it)",
      message: "Choose your ATM10 instance folder (the one with mods/ in it)",
      defaultPath: settings.instance ?? homedir(), properties: ["openDirectory"],
    });
    if (r.canceled || !r.filePaths[0]) return;
    instance = r.filePaths[0];
  }
  if (!clientJar) {
    const r = await dialog.showOpenDialog(win, {
      title: "Choose the Minecraft 1.21.1 client jar (versions/1.21.1/1.21.1.jar)",
      message: "Choose the Minecraft 1.21.1 client jar (versions/1.21.1/1.21.1.jar)",
      defaultPath: settings.clientJar ?? instance, properties: ["openFile"], filters: [{ name: "Jar", extensions: ["jar"] }],
    });
    if (r.canceled || !r.filePaths[0]) return;
    clientJar = r.filePaths[0];
  }
  update({ instance, clientJar });
  building = true;
  win.setProgressBar(0.01);
  const worker = new Worker(unpacked("assets-worker.cjs"), { workerData: { instance, clientJar, out: assetsDir() } });
  worker.on("message", (m: { type: string; done?: number; total?: number; message?: string; blocks?: number; textures?: number }) => {
    if (m.type === "progress" && m.total) {
      win?.setProgressBar(m.done! / m.total);
      win?.setTitle(`Turtle Blueprints — building block catalog ${m.done}/${m.total}`);
    }
    if (m.type === "done" || m.type === "error") {
      building = false;
      win?.setProgressBar(-1);
      win?.setTitle("Turtle Blueprints");
      if (m.type === "done") {
        void dialog.showMessageBox(win!, { message: "Block catalog ready", detail: `${m.blocks} blocks and ${m.textures} textures.` });
        win?.reload();
      } else {
        void dialog.showMessageBox(win!, { type: "error", message: "Could not build the block catalog", detail: m.message });
      }
    }
  });
  worker.on("error", (e) => {
    building = false;
    win?.setProgressBar(-1);
    void dialog.showMessageBox(win!, { type: "error", message: "Could not build the block catalog", detail: e.message });
  });
}

/** The MCP entry for a user's own Claude Code config, pointing at this installed app. */
function copyMcpConfig() {
  const s = mcpServer(blueprintsDir());
  clipboard.writeText(JSON.stringify({ mcpServers: { "turtle-blueprints": s } }, null, 2));
  void dialog.showMessageBox(win!, {
    message: "Copied the MCP server config",
    detail: "Paste it into your Claude Code settings (for example .mcp.json in a project) to use the turtle-blueprints tools from Claude Code with this app's blueprints folder.",
  });
}

function buildMenu() {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "Choose Blueprints Folder…", accelerator: "CmdOrCtrl+O", click: () => void chooseBlueprints() },
        { label: mac ? "Show Blueprints Folder in Finder" : "Show Blueprints Folder", click: () => void shell.openPath(blueprintsDir()) },
        { type: "separator" },
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Tools",
      submenu: [
        { label: "Build Block Catalog…", click: () => void buildCatalog() },
        { type: "separator" },
        { label: "Locate Claude Code…", click: () => void chooseClaude() },
        { label: "Copy MCP Config for Claude Code", click: copyMcpConfig },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Project on GitHub", click: () => void shell.openExternal("https://github.com/Arcadesys/turtle-blueprints") },
        { label: "Release Notes", click: () => void shell.openExternal(`https://github.com/Arcadesys/turtle-blueprints/releases/tag/v${app.getVersion()}`) },
        ...(mac ? [] : [{ type: "separator" as const }, { role: "about" as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    app.setAboutPanelOptions({ applicationName: "Turtle Blueprints", applicationVersion: app.getVersion(), website: "https://github.com/Arcadesys/turtle-blueprints" });
    settings = loadSettings(settingsFile());
    ensureBlueprints();
    await startServer();
    buildMenu();
    createWindow();
    const version = catalogVersion();
    if (version < CATALOG_VERSION) {
      win!.webContents.once("did-finish-load", async () => {
        const r = await dialog.showMessageBox(win!, {
          type: "info", message: version ? "Rebuild the block catalog?" : "Build the block catalog?",
          detail: version
            ? "Your block catalog is from an older version of Turtle Blueprints and is missing newer details, such as how much light each block gives off. You can do this later from Tools › Build Block Catalog."
            : "Turtle Blueprints draws blocks with real textures and searches every block in your modpack. It reads them once from your local ATM10 install. You can do this later from Tools › Build Block Catalog.",
          buttons: ["Build Now", "Later"], defaultId: 0, cancelId: 1,
        });
        if (r.response === 0) void buildCatalog();
      });
    }
    app.on("activate", () => { if (!win) createWindow(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
