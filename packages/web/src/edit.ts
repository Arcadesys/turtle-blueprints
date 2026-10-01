import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { baseId, placementState, raycast, slabMerge, type Hit, type Op, type RayHit, type Vec3 } from "@tb/blueprint";
import { entryOf } from "./textures";
import { selectedBlock, selectSlot, setSelectedBlock } from "./palette";

export interface EditorContext {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  scene: THREE.Scene;
  /** Visible cells (after the layer slice) -> block id. */
  cells: () => ReadonlyMap<string, string>;
  /** Apply ops locally and to the file; resolves when the server has them. */
  commit: (ops: Op[]) => void;
  ready: () => boolean;
}

interface Edit { ops: Op[]; inverse: Op[] }

const key = (c: Vec3) => `${c[0]},${c[1]},${c[2]}`;
const AIR = "minecraft:air";

export function initEditor(ctx: EditorContext) {
  const { renderer, camera, controls, scene } = ctx;
  const canvas = renderer.domElement;
  const enabled = document.getElementById("editing") as HTMLInputElement;
  const crosshair = document.getElementById("crosshair")!;
  const status = document.getElementById("status")!;
  const fly = new PointerLockControls(camera, canvas);
  scene.add(camera);

  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)), new THREE.LineBasicMaterial({ color: 0x000000 }));
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }));
  outline.visible = ghost.visible = false;
  scene.add(outline, ghost);

  const undo: Edit[] = [];
  const redo: Edit[] = [];
  let target: RayHit | null = null;
  const pointer = new THREE.Vector2();
  let mouseIn = false;

  const on = () => enabled.checked && ctx.ready();
  const flying = () => fly.isLocked;

  function aim(): RayHit | null {
    const origin = camera.position.toArray() as Vec3;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(flying() ? new THREE.Vector2(0, 0) : pointer, camera);
    const d = ray.ray.direction;
    return raycast(new Set(ctx.cells().keys()), origin, [d.x, d.y, d.z]);
  }

  function hitInfo(h: RayHit): Hit {
    const look = new THREE.Vector3();
    camera.getWorldDirection(look);
    return { normal: h.normal, fracY: h.point[1] - (h.cell[1] - 0.5), look: [look.x, look.y, look.z] };
  }

  /** What a right-click would do: the cell to fill and the block (with state) to put there. */
  function plan(h: RayHit): { at: Vec3; block: string } | null {
    const entry = entryOf(selectedBlock());
    const hit = hitInfo(h);
    const props = entry?.p ?? {};
    const placing = placementState(selectedBlock(), props, hit);
    if (!h.ground) {
      const merged = slabMerge(ctx.cells().get(key(h.cell)), placing, hit);
      if (merged) return { at: h.cell, block: merged };
    }
    const at: Vec3 = [h.cell[0] + h.normal[0], h.cell[1] + h.normal[1], h.cell[2] + h.normal[2]];
    if (ctx.cells().has(key(at))) return null;
    return { at, block: placing };
  }

  function refreshHover() {
    target = on() && (flying() || mouseIn) ? aim() : null;
    outline.visible = ghost.visible = false;
    if (!target) return;
    if (!target.ground) {
      outline.position.set(...target.cell);
      outline.visible = true;
    }
    const p = plan(target);
    if (p) {
      ghost.position.set(...p.at);
      ghost.visible = true;
    }
  }

  function edit(ops: Op[], inverse: Op[], record = true) {
    ctx.commit(ops);
    if (record) { undo.push({ ops, inverse }); redo.length = 0; }
  }

  function place() {
    if (!target) return;
    const p = plan(target);
    if (!p) return;
    const prev = ctx.cells().get(key(p.at));
    edit([{ op: "set", at: p.at, block: p.block }], [{ op: "set", at: p.at, block: prev ?? AIR }]);
  }

  function breakBlock() {
    if (!target || target.ground) return;
    const prev = ctx.cells().get(key(target.cell));
    if (!prev) return;
    edit([{ op: "set", at: target.cell, block: AIR }], [{ op: "set", at: target.cell, block: prev }]);
  }

  function pick() {
    if (!target || target.ground) return;
    const id = ctx.cells().get(key(target.cell));
    if (id) setSelectedBlock(baseId(id));
  }

  // Orbit mode: a click is a press and release that barely moved, so dragging still orbits and pans.
  let down: { x: number; y: number; button: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, button: e.button }; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || !on() || flying()) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const button = down.button;
    down = null;
    if (moved > 4) return;
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    target = aim();
    if (button === 0) breakBlock();
    else if (button === 2) place();
    else if (button === 1) pick();
    refreshHover();
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointermove", (e) => {
    mouseIn = true;
    pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    if (!flying()) refreshHover();
  });
  canvas.addEventListener("pointerleave", () => { mouseIn = false; refreshHover(); });

  // Fly mode: pointer lock, WASD, and a crosshair in the centre of the screen.
  canvas.addEventListener("mousedown", (e) => {
    if (!flying() || !on()) return;
    e.preventDefault();
    refreshHover();
    if (e.button === 0) breakBlock();
    else if (e.button === 2) place();
    else if (e.button === 1) pick();
    refreshHover();
  });
  fly.addEventListener("lock", () => { controls.enabled = false; crosshair.hidden = false; status.textContent = "Flying - Esc to leave"; });
  fly.addEventListener("unlock", () => {
    // Point the orbit camera at what we were looking at so it does not jump.
    const d = new THREE.Vector3();
    camera.getWorldDirection(d);
    controls.target.copy(camera.position).addScaledVector(d, 10);
    controls.enabled = true;
    crosshair.hidden = true;
    keys.clear();
    status.textContent = "";
    refreshHover();
  });
  const keys = new Set<string>();
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());

  addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.type !== "checkbox" || t instanceof HTMLTextAreaElement) return;
    if (e.code === "KeyF" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (flying()) fly.unlock();
      else if (on()) fly.lock();
      return;
    }
    if (flying()) keys.add(e.code);
    if (/^Digit[1-9]$/.test(e.code)) selectSlot(Number(e.code.slice(5)) - 1);
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
      e.preventDefault();
      const from = e.shiftKey ? redo : undo;
      const to = e.shiftKey ? undo : redo;
      const item = from.pop();
      if (!item) return;
      to.push(item);
      edit(e.shiftKey ? item.ops : item.inverse, e.shiftKey ? item.inverse : item.ops, false);
      refreshHover();
    }
  });

  const move = new THREE.Vector3();
  return {
    refreshHover,
    /** Call every frame: moves the camera while flying and keeps the hover target current. */
    tick(dt: number) {
      if (!flying()) return;
      const speed = (keys.has("ControlLeft") ? 24 : 9) * dt;
      move.set(0, 0, 0);
      if (keys.has("KeyW")) move.z -= 1;
      if (keys.has("KeyS")) move.z += 1;
      if (keys.has("KeyA")) move.x -= 1;
      if (keys.has("KeyD")) move.x += 1;
      if (move.lengthSq()) fly.moveForward(-move.z * speed), fly.moveRight(move.x * speed);
      if (keys.has("Space")) camera.position.y += speed;
      if (keys.has("ShiftLeft") || keys.has("ShiftRight")) camera.position.y -= speed;
      refreshHover();
    },
  };
}
