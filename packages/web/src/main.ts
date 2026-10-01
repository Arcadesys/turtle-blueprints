import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { baseId, materials, type Blueprint, type Op, type Vec3 } from "@tb/blueprint";
import { EYE, stepPlayer } from "./walk";
import { WHEEL, blocksIn, boxOf, boxSize, copy, deleteOps, pasteOps, wheelAngle, wheelSlice, type Box, type Clip } from "./wand";

// Shape of the /api/blueprint response; the report is computed server-side by @tb/tester.
interface Report {
  planned: number; built: number; fuelUsed: number; moves: number; extra: number; complete: boolean;
  missing: Array<{ at: [number, number, number]; block: string }>;
  wrong: Array<{ at: [number, number, number]; expected: string; actual: string }>;
  failures: Record<string, number>;
}
interface Payload { blueprint: Blueprint; report: Report | null; version: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
$("view").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(30, 60, 20);
scene.add(sun);
const grid = new THREE.GridHelper(64, 64, 0x888888, 0xbbbbbb);
(grid.material as THREE.Material).opacity = 0.35;
(grid.material as THREE.Material).transparent = true;
grid.position.y = -0.5;
scene.add(grid);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setClearColor(matchMedia("(prefers-color-scheme: dark)").matches ? 0x161715 : 0xf4f4f2);
}
addEventListener("resize", resize);
resize();

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
let framed = "";

function render() {
  group.clear();
  if (!current) return;
  const { blueprint: bp, report } = current;
  const maxY = Number($<HTMLInputElement>("slice").value);
  const shown = bp.blocks.filter((b) => b[1] <= maxY);
  solidCells = new Set(shown.map((b) => `${b[0]},${b[1]},${b[2]}`));
  const byBlock = new Map<string, Array<[number, number, number]>>();
  for (const [x, y, z, b] of shown) {
    const id = baseId(b);
    (byBlock.get(id) ?? byBlock.set(id, []).get(id)!).push([x, y, z]);
  }
  const m = new THREE.Matrix4();
  for (const [id, cells] of byBlock) {
    const mesh = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial({ color: colorOf(id) }), cells.length);
    cells.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
    mesh.userData.cells = cells; // lets the wand map a hit instance back to its block
    group.add(mesh);
  }
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
  const ul = $("mats");
  ul.replaceChildren(...materials(bp).map((m) => {
    const li = document.createElement("li");
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = "#" + colorOf(m.block).getHexString();
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = m.block;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(m.count);
    li.append(sw, name, n);
    return li;
  }));
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

const pick = $<HTMLSelectElement>("pick");
async function refreshList() {
  const names = (await (await fetch("/api/list")).json()) as string[];
  if (names.join() !== Array.from(pick.options, (o) => o.value).join()) {
    const keep = pick.value;
    pick.replaceChildren(...names.map((n) => new Option(n, n)));
    if (names.includes(keep)) pick.value = keep;
    if (names.length) await load(pick.value, true);
  }
  if (!names.length) $("sliceLabel").textContent = "No blueprints yet. Click the ground and choose New, or ask Claude to run blueprint_new.";
}
pick.addEventListener("change", () => { framed = ""; undo.length = 0; select(null, null); void load(pick.value, true); });
$("slice").addEventListener("input", () => { sidebar(); render(); });
$("ghosts").addEventListener("change", render);

// Files on disk are the source of truth; poll for edits from Claude or a test run.
setInterval(() => { void refreshList().then(async () => { if (pick.value) await load(pick.value); }); }, 1500);
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
  const taken = new Set(Array.from(pick.options, (o) => o.value));
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
  await refreshList();
  pick.value = out.name;
  framed = "";
  undo.length = 0;
  select(null, null);
  anchor = null;
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
}
$("wand").addEventListener("click", () => setWand(!wandOn));
setWand(true);

$("walk").addEventListener("click", () => setWalk(!walking));

// A click (not an orbit drag) with the wand pings a block and opens the wheel.
// Walking: left click selects from the crosshair (or confirms the steered wheel slice),
// right click grows the box, like a WorldEdit wand.
let down: { x: number; y: number; button: number } | null = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, button: e.button }; });
renderer.domElement.addEventListener("contextmenu", (e) => { if (walking) e.preventDefault(); });
renderer.domElement.addEventListener("pointermove", (e) => {
  if (walking && !locked() && down?.button === 0) dragLook(e.movementX, e.movementY);
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || down.button !== e.button) return;
  const moved = locked() ? 0 : Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 5) return;
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
  if (!walking) controls.update();
  renderer.render(scene, camera);
});
