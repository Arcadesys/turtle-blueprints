import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { baseId, buildPlan, TURTLE_SLOTS, type Blueprint } from "@tb/blueprint";
import { toGadgetsJson } from "@tb/blueprint/gadgets";

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

const colorOf = (block: string): THREE.Color => {
  let h = 0;
  for (const c of baseId(block)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return new THREE.Color().setHSL((h % 360) / 360, 0.45, 0.55);
};

const unit = new THREE.BoxGeometry(1, 1, 1);
const group = new THREE.Group();
scene.add(group);
let current: Payload | null = null;
let framed = "";

function render() {
  group.clear();
  if (!current) return;
  const { blueprint: bp, report } = current;
  const maxY = Number($<HTMLInputElement>("slice").value);
  const shown = bp.blocks.filter((b) => b[1] <= maxY);
  const byBlock = new Map<string, Array<[number, number, number]>>();
  for (const [x, y, z, b] of shown) {
    const id = baseId(b);
    (byBlock.get(id) ?? byBlock.set(id, []).get(id)!).push([x, y, z]);
  }
  const m = new THREE.Matrix4();
  for (const [id, cells] of byBlock) {
    const mesh = new THREE.InstancedMesh(unit, new THREE.MeshLambertMaterial({ color: colorOf(id) }), cells.length);
    cells.forEach(([x, y, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, y, z)));
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
    const choose = () => { select(f.name); };
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
    b.addEventListener("click", () => { void act({ action: "restore", name: n }, n); });
    li.append(nm, b);
    return li;
  }));
  for (const id of ["bRename", "bDup", "bDesc", "bArchive"]) $<HTMLButtonElement>(id).disabled = !selected;
}

function select(name: string) {
  if (name === selected) return;
  selected = name;
  framed = "";
  filesSig = "";
  void load(name, true).then(refreshList);
}

/** POST a file action; on success optionally select a blueprint. Returns an error message or "". */
async function act(a: Record<string, string>, then?: string): Promise<string> {
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
  void act(body, then).then((err) => {
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
  void act({ action: "archive", name: selected }, "").then((err) => { if (err) alert(err); });
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

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
