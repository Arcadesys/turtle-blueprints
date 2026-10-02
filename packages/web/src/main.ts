import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { baseId, buildPlan, TURTLE_SLOTS, type Blueprint, type Op, type Vec3 } from "@tb/blueprint";
import { toGadgetsJson } from "@tb/blueprint/gadgets";
import { EYE, HALF_WIDTH, HEIGHT, stepPlayer } from "./walk";
import { dropFallbackMaterials, ensureBlocks, geometryFor, lightOf, materialsFor, rotationFor, setLightmap, setLightVolume, setSmoothLighting, variantOf, type Shape } from "./textures";
import { computeLight, lightmap, skyColor, skyDarken } from "./lighting";
import { DEFAULT_LIGHT_ENV, type LightEnv } from "@tb/blueprint/editor";
import { initPalette, selectSlot } from "./palette";
import { createBuilder } from "./build";
import { WHEEL, blocksIn, boxOf, boxSize, copy, deleteOps, pasteOps, wheelAngle, wheelSlice, type Box, type Clip } from "./wand";

// Shape of the /api/blueprint response; the report is computed server-side by @tb/tester.
interface Report {
  planned: number; built: number; fuelUsed: number; moves: number; extra: number; complete: boolean;
  missing: Array<{ at: [number, number, number]; block: string }>;
  wrong: Array<{ at: [number, number, number]; expected: string; actual: string }>;
  failures: Record<string, number>;
}
interface Payload { blueprint: Blueprint; report: Report | null; version: string }
interface FileInfo { name: string; description?: string; blocks: number; size: [number, number, number] | null; modified: number; tested: boolean }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$("view").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
const grid = new THREE.GridHelper(64, 64, 0x888888, 0xbbbbbb);
(grid.material as THREE.Material).opacity = 0.35;
(grid.material as THREE.Material).transparent = true;
grid.position.y = -0.5;
scene.add(grid);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// --- Lighting --------------------------------------------------------------
// Minecraft's own lighting (see lighting.ts): the time of day drives the lightmap and the sky,
// and the world settings (ambient light, sky colour, Brightness, Smooth Lighting) come from the
// extracted game files. Time and the smooth toggle are per-browser preferences.
let env: LightEnv = DEFAULT_LIGHT_ENV;
const LIGHT_KEY = "tb.lighting";
function savedLighting(): { time?: number; smooth?: boolean } {
  try { return JSON.parse(localStorage.getItem(LIGHT_KEY) ?? "{}") as { time?: number; smooth?: boolean }; } catch { return {}; }
}
function saveLighting() {
  try { localStorage.setItem(LIGHT_KEY, JSON.stringify({ time: Number($<HTMLInputElement>("time").value), smooth: $<HTMLInputElement>("smooth").checked })); } catch { /* ignore */ }
}
const clock24 = (t: number) => {
  const mins = Math.round((((t / 1000 + 6) % 24) * 60));
  return `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
};
function applyTime() {
  const t = Number($<HTMLInputElement>("time").value);
  setLightmap(lightmap(env, t));
  const [r, g, b] = skyColor(env, t);
  renderer.setClearColor(new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace));
  (grid.material as THREE.Material).opacity = 0.35 * skyDarken(t); // the floor grid fades with the daylight
  $("timeLabel").textContent = `${clock24(t)} · /time set ${t}`;
}
function applySmooth() {
  setSmoothLighting($<HTMLInputElement>("smooth").checked);
}
{
  const saved = savedLighting();
  if (typeof saved.time === "number") $<HTMLInputElement>("time").value = String(saved.time);
  if (typeof saved.smooth === "boolean") $<HTMLInputElement>("smooth").checked = saved.smooth;
  applyTime();
  applySmooth();
  void fetch("/api/blocks/env").then((r) => r.json()).then((e: LightEnv) => {
    env = { ...DEFAULT_LIGHT_ENV, ...e };
    if (typeof savedLighting().smooth !== "boolean") $<HTMLInputElement>("smooth").checked = env.smooth;
    $("lightNote").textContent = `From your game: Brightness ${Math.round(env.gamma * 100)}%, ambient light ${env.ambient}, plains sky. Torches and other light blocks use their in-game levels.`;
    applyTime();
    applySmooth();
  }).catch(() => { /* keep the defaults */ });
}
$("time").addEventListener("input", () => { applyTime(); saveLighting(); });
$("smooth").addEventListener("change", () => { applySmooth(); saveLighting(); });
for (const [id, t] of [["tNoon", 6000], ["tSunset", 12500], ["tNight", 18000]] as const) {
  $(id).addEventListener("click", () => { $<HTMLInputElement>("time").value = String(t); applyTime(); saveLighting(); });
}

const colorOf = (block: string): THREE.Color => {
  let h = 0;
  for (const c of baseId(block)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.45, 0.55);
};

const unit = new THREE.BoxGeometry(1, 1, 1);
const group = new THREE.Group();
scene.add(group);
let current: Payload | null = null;
/** Cells the walking player collides with: the blocks currently shown. */
let solidCells = new Set<string>();
/** The same cells with their block ids, for the build tool. */
let cellBlocks = new Map<string, string>();
let renderToken = 0;
let framed = "";

function render() {
  group.clear();
  if (!current) return;
  const { blueprint: bp, report } = current;
  const maxY = Number($<HTMLInputElement>("slice").value);
  const shown = bp.blocks.filter((b) => b[1] <= maxY);
  solidCells = new Set(shown.map((b) => `${b[0]},${b[1]},${b[2]}`));
  cellBlocks = new Map(shown.map((b) => [`${b[0]},${b[1]},${b[2]}`, b[3]]));
  setLightVolume(computeLight(shown.map(([x, y, z, b]) => [x, y, z, lightOf(b)] as const), grid.position.y));
  // Group by full block id (state included) so each orientation gets its own textured mesh.
  const byBlock = new Map<string, Array<[number, number, number]>>();
  for (const [x, y, z, b] of shown) (byBlock.get(b) ?? byBlock.set(b, []).get(b)!).push([x, y, z]);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (const [id, cells] of byBlock) {
    const v = variantOf(id);
    const mesh = new THREE.InstancedMesh(geometryFor((v?.s ?? "cube") as Shape), materialsFor(id), cells.length);
    q.setFromEuler(rotationFor(v));
    cells.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.compose(new THREE.Vector3(x, y, z), q, one)));
    mesh.userData.cells = cells; // lets the wand map a hit instance back to its block
    group.add(mesh);
  }
  // Fetch catalog entries for blocks without a texture yet, then draw again with them.
  const token = ++renderToken;
  void ensureBlocks(byBlock.keys()).then((fresh) => {
    if (fresh && token === renderToken) { dropFallbackMaterials(); render(); }
  });
  if (report && $<HTMLInputElement>("ghosts").checked) {
    const ghost = (cells: Array<[number, number, number]>, color: number) => {
      const cells2 = cells.filter((c) => c[1] <= maxY);
      if (!cells2.length) return;
      const mesh = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color, wireframe: true }), cells2.length);
      cells2.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
      group.add(mesh);
    };
    ghost(report.missing.map((r) => r.at), 0xd23b2a);
    ghost(report.wrong.map((r) => r.at), 0xe08a00);
  }
}

function sidebar() {
  if (!current) return;
  const { blueprint: bp, report } = current;
  const ys = bp.blocks.map((b) => b[1]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const slice = $<HTMLInputElement>("slice");
  const wasTop = Number(slice.value) >= Number(slice.max);
  slice.min = String(lo);
  slice.max = String(hi);
  if (wasTop || Number(slice.value) < lo || Number(slice.value) > hi) slice.value = String(hi);
  $("sliceLabel").textContent = bp.blocks.length ? `showing y ${lo} to ${slice.value} of ${hi}` : "empty blueprint";
  prep(bp);
  const r = $("report");
  if (!report) {
    r.textContent = "No test run yet. Ask Claude to run test_run_build.";
    return;
  }
  const fails = Object.entries(report.failures).map(([k, n]) => `${k} x${n}`).join(", ");
  r.innerHTML = "";
  const head = document.createElement("div");
  head.className = report.complete ? "pass" : "fail";
  head.textContent = `${report.complete ? "PASS" : "FAIL"}: built ${report.built} of ${report.planned}`;
  const body = document.createElement("div");
  body.textContent = `fuel ${report.fuelUsed}, moves ${report.moves}; missing ${report.missing.length}, wrong ${report.wrong.length}, extra ${report.extra}` + (fails ? `; failures: ${fails}` : "");
  r.append(head, body);
}

// Gathering ticks are a per-browser convenience; storage may be unavailable.
const ticksKey = (name: string) => `tb:ticks:${name}`;
function getTicks(name: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(ticksKey(name)) ?? "[]") as string[]); } catch { return new Set(); }
}
function setTicks(name: string, ticks: Set<string>) {
  try { localStorage.setItem(ticksKey(name), JSON.stringify([...ticks])); } catch { /* ignore */ }
}

const stackText = (stacks: number, extra: number) => [stacks && `${stacks}×64`, extra && `${extra}`].filter(Boolean).join(" + ");

function prep(bp: Blueprint) {
  const plan = buildPlan(bp);
  $("slots").textContent = plan.total
    ? `${plan.total} blocks · ${plan.slots} of ${TURTLE_SLOTS} turtle slots` + (plan.fitsInTurtle ? "" : " · too much for one load")
    : "Nothing to build yet.";
  const meter = $("meter");
  meter.classList.toggle("over", !plan.fitsInTurtle);
  (meter.firstElementChild as HTMLElement).style.width = `${Math.min(100, (plan.slots / TURTLE_SLOTS) * 100)}%`;
  const ticks = getTicks(bp.name);
  $("mats").replaceChildren(...plan.materials.map((m) => {
    const li = document.createElement("li");
    li.classList.toggle("got", ticks.has(m.block));
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = ticks.has(m.block);
    box.setAttribute("aria-label", `Gathered ${m.block}`);
    box.addEventListener("change", () => {
      const t = getTicks(bp.name);
      if (box.checked) t.add(m.block); else t.delete(m.block);
      setTicks(bp.name, t);
      li.classList.toggle("got", box.checked);
    });
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = "#" + colorOf(m.block).getHexString();
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = m.block.replace(/^minecraft:/, "");
    name.title = m.block;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(m.count);
    n.title = stackText(m.stacks, m.extra);
    li.append(box, sw, name, n);
    return li;
  }));
  $("issues").replaceChildren(...plan.issues.map((i) => {
    const li = document.createElement("li");
    li.className = i.level;
    li.textContent = `${i.level}: ${i.message}`;
    return li;
  }));
  $<HTMLButtonElement>("bExport").disabled = !plan.total;
  $<HTMLButtonElement>("bCopy").disabled = !plan.total;
  $<HTMLButtonElement>("bGadgets").disabled = !plan.total;
}

function frame(bp: Blueprint) {
  if (framed === bp.name || !bp.blocks.length) return;
  framed = bp.name;
  const xs = bp.blocks.map((b) => b[0]), ys = bp.blocks.map((b) => b[1]), zs = bp.blocks.map((b) => b[2]);
  const mid = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)) + 4;
  controls.target.copy(mid);
  camera.position.set(mid.x + span, mid.y + span * 0.8, mid.z + span * 1.3);
  grid.position.set(mid.x, Math.min(...ys) - 0.5, mid.z);
}

async function load(name: string, force = false) {
  const res = await fetch(`/api/blueprint/${encodeURIComponent(name)}`);
  if (!res.ok) return;
  const next = (await res.json()) as Payload;
  if (!force && current?.version === next.version && current.blueprint.name === next.blueprint.name) return;
  current = next;
  frame(next.blueprint);
  sidebar();
  render();
}

let selected = "";
let filesSig = "";

function describeFile(f: FileInfo): string {
  const size = f.size ? f.size.join("×") : "empty";
  return `${f.blocks} blocks · ${size}` + (f.description ? ` · ${f.description}` : "");
}

async function refreshList() {
  const data = (await (await fetch("/api/files")).json()) as { files: FileInfo[]; archived: string[] };
  const sig = JSON.stringify(data) + selected;
  if (sig === filesSig) return;
  filesSig = sig;
  const names = data.files.map((f) => f.name);
  if (!names.includes(selected)) {
    selected = names[0] ?? "";
    current = null;
    framed = "";
    if (selected) await load(selected, true);
    else { group.clear(); $("sliceLabel").textContent = "No blueprints yet. Press New, or ask Claude to run blueprint_new."; }
  }
  $("files").replaceChildren(...data.files.map((f) => {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(f.name === selected));
    li.tabIndex = 0;
    const t = document.createElement("div");
    t.className = "t";
    const nm = document.createElement("strong");
    nm.className = "name";
    nm.textContent = f.name;
    t.append(nm);
    if (f.tested) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "tested";
      t.append(tag);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = describeFile(f);
    li.append(t, meta);
    const choose = () => { selectFile(f.name); };
    li.addEventListener("click", choose);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(); } });
    return li;
  }));
  $("archivedN").textContent = String(data.archived.length);
  $("archivedBox").hidden = !data.archived.length;
  $("archived").replaceChildren(...data.archived.map((n) => {
    const li = document.createElement("li");
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = n;
    const b = document.createElement("button");
    b.textContent = "Restore";
    b.addEventListener("click", () => { void manageFile({ action: "restore", name: n }, n); });
    li.append(nm, b);
    return li;
  }));
  for (const id of ["bRename", "bDup", "bDesc", "bArchive"]) $<HTMLButtonElement>(id).disabled = !selected;
  if (!names.length) $("sliceLabel").textContent = "No blueprints yet. Click the ground and choose New, or ask Claude to run blueprint_new.";
}

function selectFile(name: string) {
  if (name === selected) return;
  selected = name;
  framed = "";
  filesSig = "";
  undo.length = 0;
  select(null, null);
  anchor = null;
  void load(name, true).then(refreshList);
}

/** POST a file action; on success optionally select a blueprint. Returns an error message or "". */
async function manageFile(a: Record<string, string>, then?: string): Promise<string> {
  const res = await fetch("/api/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a) });
  const out = (await res.json()) as { error?: string };
  if (!res.ok) return out.error ?? `failed (${res.status})`;
  filesSig = "";
  if (then !== undefined) { selected = then; framed = ""; current = null; if (then) await load(then, true); }
  await refreshList();
  return "";
}

// One inline form serves New, Rename, Duplicate and Describe.
type Mode = "create" | "rename" | "duplicate" | "describe";
let mode: Mode = "create";
const form = $<HTMLFormElement>("form");
function openForm(m: Mode) {
  mode = m;
  const desc = current?.blueprint.description ?? "";
  const cfg = {
    create: { title: "New blueprint", name: "", desc: "", showName: true, showDesc: true },
    rename: { title: `Rename ${selected}`, name: selected, desc: "", showName: true, showDesc: false },
    duplicate: { title: `Duplicate ${selected}`, name: `${selected}-copy`, desc: "", showName: true, showDesc: false },
    describe: { title: `Describe ${selected}`, name: "", desc, showName: false, showDesc: true },
  }[m];
  $("formTitle").textContent = cfg.title;
  $("nameLabel").hidden = !cfg.showName;
  $("descLabel").hidden = !cfg.showDesc;
  $<HTMLInputElement>("fName").value = cfg.name;
  $<HTMLInputElement>("fDesc").value = cfg.desc;
  $("formErr").textContent = "";
  form.classList.add("open");
  $<HTMLInputElement>(cfg.showName ? "fName" : "fDesc").select();
}
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("fName").value.trim();
  const description = $<HTMLInputElement>("fDesc").value.trim();
  const req: Record<Mode, [Record<string, string>, string]> = {
    create: [{ action: "create", name, description }, name],
    rename: [{ action: "rename", name: selected, to: name }, name],
    duplicate: [{ action: "duplicate", name: selected, to: name }, name],
    describe: [{ action: "describe", name: selected, description }, selected],
  };
  const [body, then] = req[mode];
  void manageFile(body, then).then((err) => {
    if (err) $("formErr").textContent = err;
    else form.classList.remove("open");
  });
});
$("fCancel").addEventListener("click", () => form.classList.remove("open"));
form.addEventListener("keydown", (e) => { if (e.key === "Escape") form.classList.remove("open"); });
$("bNew").addEventListener("click", () => openForm("create"));
$("bRename").addEventListener("click", () => openForm("rename"));
$("bDup").addEventListener("click", () => openForm("duplicate"));
$("bDesc").addEventListener("click", () => openForm("describe"));
$("bArchive").addEventListener("click", () => {
  if (!selected || !confirm(`Archive ${selected}? You can restore it from the Archived list.`)) return;
  void manageFile({ action: "archive", name: selected }, "").then((err) => { if (err) alert(err); });
});
$("bExport").addEventListener("click", () => { if (selected) location.href = `/api/export/${encodeURIComponent(selected)}`; });
$("bCopy").addEventListener("click", () => {
  if (!current) return;
  const plan = buildPlan(current.blueprint);
  const text = [`${current.blueprint.name}: ${plan.total} blocks, ${plan.slots}/${TURTLE_SLOTS} turtle slots`,
    ...plan.materials.map((m) => `[ ] ${m.block} ${m.count} (${stackText(m.stacks, m.extra)})`)].join("\n");
  copied("bCopy", text);
});
$("bGadgets").addEventListener("click", () => { if (current) copied("bGadgets", toGadgetsJson(current.blueprint)); });

function copied(id: string, text: string) {
  const b = $(id);
  const label = b.textContent;
  void navigator.clipboard.writeText(text).then(
    () => { b.textContent = "Copied"; },
    () => { b.textContent = "Copy failed"; },
  ).then(() => setTimeout(() => { b.textContent = label; }, 1200));
}
$("slice").addEventListener("input", () => { sidebar(); render(); });
$("ghosts").addEventListener("change", render);

// Files on disk are the source of truth; poll for edits from Claude or a test run.
setInterval(() => { void refreshList().then(async () => { if (selected) await load(selected); }); }, 1500);
void refreshList();

// --- Walk mode -----------------------------------------------------------
// First person, like Minecraft creative: WASD moves. Walking has gravity, Space jumps and
// Shift sneaks; double-tap Space to fly, where Space/Shift rise and sink and touching the
// ground lands you. Blocks are solid either way.
// Mouse captured (pointer lock): the mouse looks, the wand aims from the crosshair, and the
// mouse steers the wheel while it is open. Cursor free (Esc or E, or the browser refused
// capture): drag to look, and the wand aims at the cursor as in orbit view.

const look = new PointerLockControls(camera, renderer.domElement);
let walking = false;
let flying = true; // walk mode starts in the air, where the orbit camera was
let vy = 0;
let onGround = false;
let lastSpace = 0;
const held = new Set<string>();
const clock = new THREE.Clock();
const locked = () => look.isLocked;
// Not look.lock(): it leaves the promise unhandled when the browser refuses (pointerlockerror covers that).
const capture = () => { void Promise.resolve(renderer.domElement.requestPointerLock()).catch(() => {}); };

function setWalk(on: boolean) {
  walking = on;
  held.clear();
  controls.enabled = !on;
  $("walk").setAttribute("aria-pressed", String(on));
  if (on) { flying = true; vy = 0; }
  walkLabel();
  document.body.classList.toggle("walking", on);
  closeWheel();
  if (on) capture();
  else {
    if (locked()) look.unlock();
    // Hand the view back to orbit, pivoting a few blocks ahead of where we stood.
    controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(8));
  }
}
look.addEventListener("lock", () => { document.body.classList.add("locked"); });
look.addEventListener("unlock", () => { document.body.classList.remove("locked"); look.pointerSpeed = 1; });
document.addEventListener("pointerlockerror", () => {
  if (walking) status("The browser would not capture the mouse. Keep walking: drag to look, click to select.");
});

const euler = new THREE.Euler(0, 0, 0, "YXZ");
function dragLook(dx: number, dy: number) {
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= dx * 0.004;
  euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.x - dy * 0.004));
  camera.quaternion.setFromEuler(euler);
}

function walkLabel() {
  $("walk").firstChild!.textContent = !walking ? "Walk " : flying ? "Flying " : "Walking ";
}
function setFly(on: boolean) {
  flying = on;
  vy = 0;
  walkLabel();
  status(on ? "Flying: Space and Shift rise and sink. Double-tap Space to drop." : "Walking: Space jumps, Shift sneaks. Double-tap Space to fly.");
}

const solid = (x: number, y: number, z: number) => solidCells.has(`${x},${y},${z}`);
const fwd = new THREE.Vector3();
function walkStep(dt: number) {
  if (!walking) return;
  camera.getWorldDirection(fwd);
  const p = camera.position;
  const out = stepPlayer({ feet: [p.x, p.y - EYE, p.z], vy, flying, onGround }, {
    facing: fwd.x || fwd.z ? [fwd.x, fwd.z] : [0, -1],
    forward: Number(held.has("w")) - Number(held.has("s")),
    right: Number(held.has("d")) - Number(held.has("a")),
    up: held.has(" "),
    down: held.has("shift"),
  }, dt, solid, grid.position.y);
  p.set(out.feet[0], out.feet[1] + EYE, out.feet[2]);
  vy = out.vy;
  onGround = out.onGround;
  if (flying && !out.flying) setFly(false); // landing ends flight
  const pos = `feet at ${out.feet.map((n) => n.toFixed(1)).join(", ")}${flying ? " · flying" : onGround ? " · on ground" : " · falling"}`;
  if ($("walkPos").textContent !== pos) $("walkPos").textContent = pos;
}

// --- Selector wand -------------------------------------------------------
// Click to ping and select, shift-click (or right-click while walking) to grow a box,
// then act from the wheel.

let buildOn = false; // the Build tool, below
let wandOn = true;
let anchor: Vec3 | null = null;
let sel: Box | null = null;
/** Where a paste lands: the empty cell on the clicked face, or the clicked ground cell. */
let target: Vec3 | null = null;
let clip: Clip | null = null;
const undo: Blueprint[] = [];
const wandLayer = new THREE.Group();
scene.add(wandLayer);
const wheel = $("wheel");
const status = (t: string) => { $("wandStatus").textContent = t; };

function outline(box: Box, color: number, pad = 0.04) {
  const size = boxSize(box);
  const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(size[0] + pad, size[1] + pad, size[2] + pad));
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true }));
  line.position.set((box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2);
  return line;
}

let ping: { line: THREE.LineSegments; t0: number } | null = null;
function select(box: Box | null, at: Vec3 | null, pinged?: Vec3) {
  sel = box;
  target = at;
  wandLayer.clear();
  if (sel) wandLayer.add(outline(sel, 0x3a6fd8));
  if (target) {
    const t = outline(boxOf(target, target), 0x2f8f4e, -0.1);
    (t.material as THREE.LineBasicMaterial).opacity = 0.7;
    wandLayer.add(t);
  }
  ping = pinged ? { line: outline(boxOf(pinged, pinged), 0xffffff), t0: performance.now() } : null;
  if (ping) wandLayer.add(ping.line);
}

const ray = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
/** Ray from the pointer, or from the crosshair while the pointer is locked for walking. */
function pickAt(e: PointerEvent, extend: boolean) {
  const r = renderer.domElement.getBoundingClientRect();
  camera.updateMatrixWorld(); // mouse look may have turned the camera since the last frame was drawn
  ray.setFromCamera(locked()
    ? new THREE.Vector2(0, 0)
    : new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects(group.children.filter((o) => o.userData.cells), false)[0];
  if (hit && hit.instanceId !== undefined && hit.face) {
    const cell = (hit.object.userData.cells as Vec3[])[hit.instanceId]!;
    const n = hit.face.normal;
    const box = extend && anchor ? boxOf(anchor, cell) : boxOf(cell, cell);
    if (!extend || !anchor) anchor = cell;
    select(box, [cell[0] + Math.round(n.x), cell[1] + Math.round(n.y), cell[2] + Math.round(n.z)], cell);
    return true;
  }
  ground.constant = -(grid.position.y);
  const p = ray.ray.intersectPlane(ground, new THREE.Vector3());
  if (!p) return false;
  const cell: Vec3 = [Math.round(p.x), Math.round(grid.position.y + 0.5), Math.round(p.z)];
  anchor = null;
  select(null, cell, cell);
  return true;
}

function openWheel(x: number, y: number) {
  const bp = current?.blueprint;
  const n = bp && sel ? blocksIn(bp, sel).length : 0;
  const can: Record<string, boolean> = { copy: n > 0, delete: n > 0, paste: !!clip && !!target, generate: !!bp, new: true };
  wheel.querySelectorAll<HTMLButtonElement>("button").forEach((b) => { b.disabled = !can[b.dataset.act!]; });
  $("wheelInfo").textContent = sel ? `${boxSize(sel).join("×")} · ${n} block${n === 1 ? "" : "s"}` : target ? `empty cell ${target.join(", ")}` : "";
  wheel.style.left = `${Math.min(Math.max(x, 125), innerWidth - 125)}px`;
  wheel.style.top = `${Math.min(Math.max(y, 125), innerHeight - 150)}px`;
  wheel.classList.add("open");
  steer.set(0, 0);
  hot(null);
  if (locked()) look.pointerSpeed = 0; // the mouse steers the wheel instead of the view
  else wheel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}
function closeWheel() {
  wheel.classList.remove("open");
  look.pointerSpeed = 1;
}

// Under pointer lock there is no cursor, so mouse movement picks a wheel slice, like a game radial menu.
const steer = new THREE.Vector2();
function hot(what: string | null) {
  wheel.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.classList.toggle("hot", b.dataset.act === what));
}
const hotAct = () => wheel.querySelector<HTMLButtonElement>("button.hot")?.dataset.act ?? null;
document.addEventListener("mousemove", (e) => {
  if (!locked() || !wheel.classList.contains("open")) return;
  steer.x += e.movementX;
  steer.y += e.movementY;
  if (steer.length() > 60) steer.setLength(60);
  const what = wheelSlice(steer.x, steer.y);
  hot(what && !wheel.querySelector<HTMLButtonElement>(`[data-act=${what}]`)?.disabled ? what : null);
});

async function edit(ops: Op[], done: string) {
  if (!current) return;
  const name = current.blueprint.name;
  const before = structuredClone(current.blueprint);
  const res = await fetch(`/api/blueprint/${encodeURIComponent(name)}/ops`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops }),
  });
  const out = (await res.json()) as { error?: string; issues?: Array<{ level: string; message: string }> };
  if (!res.ok) return status(`Failed: ${out.error}`);
  undo.push(before);
  const errors = (out.issues ?? []).filter((i) => i.level === "error");
  status(done + (errors.length ? ` (${errors.length} validation error${errors.length > 1 ? "s" : ""}: ${errors[0]!.message})` : ""));
  await load(name, true);
}

async function act(what: string) {
  const btn = wheel.querySelector<HTMLButtonElement>(`[data-act=${what}]`);
  if (!wheel.classList.contains("open") || !btn || btn.disabled) return;
  closeWheel();
  if (what === "new") return openNew();
  if (!current) return;
  const bp = current.blueprint;
  if (what === "copy" && sel) {
    clip = copy(bp, sel);
    status(`Copied ${clip.blocks.length} blocks (${clip.size.join("×")}). Click where to paste.`);
  } else if (what === "paste" && clip && target) {
    await edit(pasteOps(clip, target), `Pasted ${clip.blocks.length} blocks at ${target.join(", ")}.`);
  } else if (what === "delete" && sel) {
    const n = blocksIn(bp, sel).length;
    await edit(deleteOps(sel), `Deleted ${n} block${n === 1 ? "" : "s"}.`);
    select(null, null);
  } else if (what === "generate") {
    if (locked()) look.unlock(); // typing the request needs a cursor; E captures the mouse again
    $("genWhere").textContent = sel
      ? `In ${bp.name}, the box ${sel.min.join(",")} to ${sel.max.join(",")} (${boxSize(sel).join("×")}).`
      : target ? `In ${bp.name}, starting at the empty cell ${target.join(", ")}.` : `In ${bp.name}.`;
    $<HTMLDialogElement>("gen").showModal();
    $<HTMLTextAreaElement>("genText").focus();
  }
}

async function generate(request: string) {
  if (!current) return;
  const name = current.blueprint.name;
  const before = structuredClone(current.blueprint);
  const res = await fetch("/api/generate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, request, box: sel, target }),
  });
  const out = (await res.json()) as { id?: string; error?: string };
  const box = $("genStatus");
  if (!out.id) { box.textContent = `Generate failed: ${out.error}`; return; }
  undo.push(before); // Ctrl/Cmd+Z puts back the design from before this generate
  const poll = async () => {
    const job = (await (await fetch(`/api/generate/${out.id}`)).json()) as { status: string; steps: string[]; result: string };
    const head = document.createElement("div");
    head.className = job.status === "done" ? "pass" : job.status === "failed" ? "fail" : "";
    head.textContent = job.status === "running" ? `Generating in ${name}…` : job.status === "done" ? "Generated" : "Generate failed";
    const steps = document.createElement("div");
    steps.className = "steps";
    steps.textContent = job.steps.join(" → ");
    const result = document.createElement("div");
    result.textContent = job.result;
    box.replaceChildren(head, steps, result);
    if (job.status === "running") setTimeout(() => void poll(), 1500);
  };
  void poll();
}

$<HTMLDialogElement>("gen").addEventListener("close", () => {
  const text = $<HTMLTextAreaElement>("genText");
  if ($<HTMLDialogElement>("gen").returnValue === "go" && text.value.trim()) {
    void generate(text.value);
    text.value = "";
  }
});
$("genText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $<HTMLDialogElement>("gen").close("go");
});

// Lay the buttons out around the ring in WHEEL order, matching wheelSlice.
WHEEL.forEach((act_, i) => {
  const b = wheel.querySelector<HTMLButtonElement>(`[data-act=${act_}]`)!;
  b.style.left = `${50 + 34 * Math.sin(wheelAngle(i))}%`;
  b.style.top = `${50 - 34 * Math.cos(wheelAngle(i))}%`;
});

// New blueprint: the selected blocks moved to the origin, or empty when nothing is selected.
function openNew() {
  const bp = current?.blueprint;
  const n = bp && sel ? blocksIn(bp, sel).length : 0;
  if (locked()) look.unlock(); // naming it needs a cursor
  $("newWhat").textContent = bp && sel && n
    ? `Saves the ${n} selected block${n === 1 ? "" : "s"} (${boxSize(sel).join("×")}) from ${bp.name} as a new blueprint, moved so the box starts at 0,0,0.`
    : "Starts an empty blueprint.";
  const taken = new Set(Array.from(document.querySelectorAll("#files .t .name"), (el) => el.textContent ?? ""));
  const stem = bp && sel && n ? `${bp.name}-part` : "blueprint";
  let name = stem;
  for (let i = 2; taken.has(name); i++) name = `${stem}-${i}`;
  const input = $<HTMLInputElement>("newName");
  input.value = name;
  $<HTMLDialogElement>("newbp").showModal();
  input.select();
}

async function createNew(name: string) {
  const bp = current?.blueprint;
  const from = bp && sel && blocksIn(bp, sel).length ? { name: bp.name, box: sel } : undefined;
  const res = await fetch("/api/new", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, from }),
  });
  const out = (await res.json()) as { name?: string; blocks?: number; error?: string };
  if (!res.ok || !out.name) return status(`New blueprint failed: ${out.error}`);
  selected = out.name;
  filesSig = "";
  framed = "";
  undo.length = 0;
  select(null, null);
  anchor = null;
  await refreshList();
  await load(out.name, true);
  status(out.blocks ? `Created ${out.name} with ${out.blocks} blocks.` : `Created ${out.name}. Click the ground and Paste or Generate to fill it.`);
}

$<HTMLDialogElement>("newbp").addEventListener("close", () => {
  const input = $<HTMLInputElement>("newName");
  if ($<HTMLDialogElement>("newbp").returnValue !== "go") return;
  if (!/^[A-Za-z0-9_-]+$/.test(input.value)) return status("Blueprint names use letters, digits, _ and - only.");
  void createNew(input.value);
});
$("newName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $<HTMLDialogElement>("newbp").close("go"); }
});

wheel.addEventListener("click", (e) => {
  const act_ = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.act;
  if (act_) void act(act_);
});

function setWand(on: boolean) {
  wandOn = on;
  $("wand").setAttribute("aria-pressed", String(on));
  $("wand").firstChild!.textContent = on ? "Wand on " : "Wand off ";
  if (!on) hot(null);
  $("view").classList.toggle("wand", on);
  if (!on) { closeWheel(); select(null, null); }
  if (on && buildOn) setBuild(false);
}
$("wand").addEventListener("click", () => setWand(!wandOn));
setWand(true);

$("walk").addEventListener("click", () => setWalk(!walking));

// --- Build tool ----------------------------------------------------------
// Hand building with the searched block: right click places, left click breaks, middle click
// picks. Turning it on turns the wand off (they both want the click), and back.
const builder = createBuilder({
  scene, camera,
  cells: () => cellBlocks,
  floorY: () => grid.position.y,
  blocked: (c) => {
    if (!walking) return false;
    const p = camera.position;
    return Math.abs(p.x - c[0]) < 0.5 + HALF_WIDTH && Math.abs(p.z - c[2]) < 0.5 + HALF_WIDTH && p.y - EYE < c[1] + 0.5 && p.y - EYE + HEIGHT > c[1] - 0.5;
  },
});
function setBuild(on: boolean) {
  buildOn = on;
  $("build").setAttribute("aria-pressed", String(on));
  $("build").firstChild!.textContent = on ? "Build on " : "Build off ";
  $("view").classList.toggle("build", on);
  if (on && wandOn) setWand(false);
  if (!on) builder.hover(null);
}
$("build").addEventListener("click", () => setBuild(!buildOn));
let pointerNdc: THREE.Vector2 | null = null;
const aimNdc = () => (locked() ? new THREE.Vector2(0, 0) : pointerNdc);
renderer.domElement.addEventListener("pointermove", (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  pointerNdc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
});
renderer.domElement.addEventListener("pointerleave", () => { pointerNdc = null; });
initPalette();

// A click (not an orbit drag) with the wand pings a block and opens the wheel.
// Walking: left click selects from the crosshair (or confirms the steered wheel slice),
// right click grows the box, like a WorldEdit wand.
let down: { x: number; y: number; button: number } | null = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, button: e.button }; });
renderer.domElement.addEventListener("contextmenu", (e) => { if (walking || buildOn) e.preventDefault(); });
renderer.domElement.addEventListener("pointermove", (e) => {
  if (walking && !locked() && down?.button === 0) dragLook(e.movementX, e.movementY);
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || down.button !== e.button) return;
  const moved = locked() ? 0 : Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 5) return;
  if (buildOn) {
    const ndc = locked() ? new THREE.Vector2(0, 0) : new THREE.Vector2(((e.clientX - renderer.domElement.getBoundingClientRect().left) / renderer.domElement.clientWidth) * 2 - 1, -((e.clientY - renderer.domElement.getBoundingClientRect().top) / renderer.domElement.clientHeight) * 2 + 1);
    const action = builder.click(e.button, ndc);
    if (action) void edit(action.ops, action.done);
    return;
  }
  if (locked() && e.button === 0 && wheel.classList.contains("open") && hotAct()) return void act(hotAct()!);
  const extend = walking ? e.button === 2 : e.button === 0 && e.shiftKey;
  if (!wandOn || (e.button !== 0 && !extend)) return;
  if (pickAt(e, extend)) openWheel(locked() ? innerWidth / 2 : e.clientX, locked() ? innerHeight / 2 : e.clientY);
  else { closeWheel(); select(null, null); }
});

async function undoLast() {
  const prev = undo.pop();
  if (!prev) return status("Nothing to undo.");
  const res = await fetch(`/api/blueprint/${encodeURIComponent(prev.name)}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ blueprint: prev }),
  });
  status(res.ok ? "Undone." : "Undo failed.");
  await load(prev.name, true);
}

const MOVE = new Set(["w", "a", "s", "d", " ", "shift"]);
addEventListener("keyup", (e) => { held.delete(e.key.toLowerCase()); });
addEventListener("blur", () => held.clear());
addEventListener("keydown", (e) => {
  if (e.target instanceof Element && e.target.closest("textarea, input, select, dialog")) return;
  if (walking && MOVE.has(e.key.toLowerCase())) {
    if (e.key === " " && !e.repeat) {
      // Double-tap Space toggles flight, as in Minecraft creative.
      const now = performance.now();
      if (now - lastSpace < 300) { setFly(!flying); lastSpace = 0; } else lastSpace = now;
    }
    held.add(e.key.toLowerCase());
    e.preventDefault();
    return;
  }
  if (e.key === "z" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void undoLast(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "escape") { closeWheel(); select(null, null); anchor = null; }
  else if (k === "q") setWand(!wandOn);
  else if (k === "b") setBuild(!buildOn);
  else if (/^[1-9]$/.test(k)) selectSlot(Number(k) - 1);
  else if (k === "f") setWalk(!walking);
  else if (k === "e" && walking) { closeWheel(); if (locked()) look.unlock(); else capture(); }
  else if (wheel.classList.contains("open")) {
    const map: Record<string, string> = { c: "copy", v: "paste", x: "delete", delete: "delete", backspace: "delete", n: "new", g: "generate" };
    if (map[k]) { e.preventDefault(); void act(map[k]); }
  }
});

renderer.setAnimationLoop(() => {
  walkStep(Math.min(clock.getDelta(), 0.1));
  if (ping) {
    const t = (performance.now() - ping.t0) / 450;
    if (t >= 1) { wandLayer.remove(ping.line); ping = null; }
    else { ping.line.scale.setScalar(1 + t * 0.8); (ping.line.material as THREE.LineBasicMaterial).opacity = 1 - t; }
  }
  builder.hover(buildOn ? aimNdc() : null);
  if (!walking) controls.update();
  renderer.render(scene, camera);
});
