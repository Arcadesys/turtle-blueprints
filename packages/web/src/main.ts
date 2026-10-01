import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { applyOps, baseId, materials, type Blueprint, type Op } from "@tb/blueprint";
import { dropFallbackMaterials, ensureBlocks, geometryFor, hashColor, iconOf, materialsFor, rotationFor, textureUrl, variantOf, type Shape } from "./textures";
import { initPalette } from "./palette";
import { initEditor } from "./edit";

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
scene.add(grid);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setClearColor(matchMedia("(prefers-color-scheme: dark)").matches ? 0x161715 : 0xf4f4f2);
}
addEventListener("resize", resize);
resize();

const group = new THREE.Group();
scene.add(group);
const unit = new THREE.BoxGeometry(1, 1, 1);
let current: Payload | null = null;
let editor: ReturnType<typeof initEditor> | undefined;
let framed = "";

/** Visible cells (below the layer slice) for the editor's raycasts. */
let cells = new Map<string, string>();
let renderToken = 0;

function render() {
  group.clear();
  cells = new Map();
  if (!current) return;
  const { blueprint: bp, report } = current;
  const maxY = Number($<HTMLInputElement>("slice").value);
  const shown = bp.blocks.filter((b) => b[1] <= maxY);
  const byBlock = new Map<string, Array<[number, number, number]>>();
  for (const [x, y, z, b] of shown) {
    cells.set(`${x},${y},${z}`, b);
    (byBlock.get(b) ?? byBlock.set(b, []).get(b)!).push([x, y, z]);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  for (const [id, list] of byBlock) {
    const v = variantOf(id);
    const mesh = new THREE.InstancedMesh(geometryFor((v?.s ?? "cube") as Shape), materialsFor(id), list.length);
    q.setFromEuler(rotationFor(v));
    list.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.compose(new THREE.Vector3(x, y, z), q, one)));
    group.add(mesh);
  }
  // Fetch catalog entries for blocks we have no texture for yet, then draw again with textures.
  const token = ++renderToken;
  void ensureBlocks(byBlock.keys()).then((fresh) => {
    if (fresh && token === renderToken) { dropFallbackMaterials(); render(); }
  });
  if (report && $<HTMLInputElement>("ghosts").checked) {
    const ghost = (list: Array<[number, number, number]>, color: number) => {
      const cells2 = list.filter((c) => c[1] <= maxY);
      if (!cells2.length) return;
      const mesh = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color, wireframe: true }), cells2.length);
      cells2.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
      group.add(mesh);
    };
    ghost(report.missing.map((r) => r.at), 0xd23b2a);
    ghost(report.wrong.map((r) => r.at), 0xe08a00);
  }
  editor?.refreshHover();
}

function sidebar() {
  if (!current) return;
  const { blueprint: bp, report } = current;
  const ys = bp.blocks.map((b) => b[1]);
  const lo = ys.length ? Math.min(...ys) : 0, hi = ys.length ? Math.max(...ys) : 0;
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
    const tex = iconOf(m.block);
    sw.style.background = tex ? `url(${textureUrl(tex)}) top / 100% auto` : "#" + hashColor(m.block).getHexString();
    sw.style.imageRendering = "pixelated";
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
  if (framed === bp.name) return;
  framed = bp.name;
  grid.position.y = -0.5;
  if (!bp.blocks.length) {
    controls.target.set(0, 0, 0);
    camera.position.set(7, 6, 10);
    grid.position.set(0, -0.5, 0);
    return;
  }
  const xs = bp.blocks.map((b) => b[0]), ys = bp.blocks.map((b) => b[1]), zs = bp.blocks.map((b) => b[2]);
  const mid = new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)) + 4;
  controls.target.copy(mid);
  camera.position.set(mid.x + span, mid.y + span * 0.8, mid.z + span * 1.3);
  grid.position.set(mid.x, -0.5, mid.z);
}

async function load(name: string, force = false) {
  const res = await fetch(`/api/blueprint/${encodeURIComponent(name)}`);
  if (!res.ok) return;
  const next = (await res.json()) as Payload;
  if (pending > 0) return; // our own edits are on their way; the file is about to change
  if (!force && current?.version === next.version && current.blueprint.name === next.blueprint.name) return;
  current = next;
  frame(next.blueprint);
  sidebar();
  render();
}

// Edits apply here at once and are sent to the server in order; the file stays the source of truth.
let pending = 0;
let sending: Promise<unknown> = Promise.resolve();
function commit(ops: Op[]) {
  if (!current) return;
  const name = current.blueprint.name;
  current = { ...current, blueprint: applyOps(current.blueprint, ops) };
  sidebar();
  render();
  pending++;
  sending = sending.then(async () => {
    try {
      const res = await fetch(`/api/blueprint/${encodeURIComponent(name)}/ops`, { method: "POST", body: JSON.stringify(ops) });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error);
      const next = (await res.json()) as Payload;
      if (pending === 1 && current?.blueprint.name === name) current = { ...current, version: next.version, report: next.report };
    } catch (e) {
      $("status").textContent = `edit failed: ${(e as Error).message}`;
      pending = 1; // allow the reload below to replace our optimistic state
      await load(name, true);
    } finally {
      pending--;
    }
  });
}

let starting = false;
const pick = $<HTMLSelectElement>("pick");
async function refreshList() {
  const names = (await (await fetch("/api/list")).json()) as string[];
  if (names.join() !== Array.from(pick.options, (o) => o.value).join()) {
    const keep = pick.value;
    pick.replaceChildren(...names.map((n) => new Option(n, n)));
    if (names.includes(keep)) pick.value = keep;
    if (names.length) await load(pick.value, true);
  }
  if (!names.length && !starting) {
    // Nothing to edit yet: start an empty blueprint so the wand has something to build on.
    starting = true;
    await fetch("/api/new", { method: "POST", body: JSON.stringify({ name: "my-build" }) });
    starting = false;
    await refreshList();
  }
}
pick.addEventListener("change", () => { framed = ""; void load(pick.value, true); });
$("slice").addEventListener("input", () => { sidebar(); render(); });
$("ghosts").addEventListener("change", render);
$("newbp").addEventListener("click", async () => {
  const name = prompt("Blueprint name (letters, digits, _ and -)")?.trim();
  if (!name) return;
  const res = await fetch("/api/new", { method: "POST", body: JSON.stringify({ name }) });
  if (!res.ok) { $("status").textContent = ((await res.json()) as { error?: string }).error ?? "could not create"; return; }
  await refreshList();
  pick.value = name;
  framed = "";
  await load(name, true);
});
initPalette();
editor = initEditor({ renderer, camera, controls, scene, cells: () => cells, commit, ready: () => current !== null });

// Files on disk are the source of truth; poll for edits from Claude or a test run.
setInterval(() => { void refreshList().then(async () => { if (pick.value) await load(pick.value); }); }, 1500);
void refreshList();

let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  editor?.tick(dt);
  // OrbitControls.update() re-aims the camera at its target even when disabled, which would undo mouselook in first person.
  if (controls.enabled) controls.update();
  renderer.render(scene, camera);
});
