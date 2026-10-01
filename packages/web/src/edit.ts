import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EYE_HEIGHT, PLAYER_HEIGHT, PLAYER_WIDTH, baseId, collides, placementState, raycast, slabMerge, stepBody, type Body, type Hit, type Op, type RayHit, type SolidAt, type Vec3 } from "@tb/blueprint";
import { entryOf, hashColor, variantOf } from "./textures";
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

  // A magic wand held in view: it shows editing is on, glows in the selected block's colour and swings on each edit.
  const wand = new THREE.Group();
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.5, 8), new THREE.MeshLambertMaterial({ color: 0x5a3a1c }));
  stick.position.y = 0.25;
  const tipMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.045), tipMat);
  tip.position.y = 0.55;
  const halo = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18, depthWrite: false }));
  halo.position.y = 0.55;
  wand.add(stick, tip, halo);
  wand.position.set(0.36, -0.36, -0.7);
  wand.scale.setScalar(0.55);
  const rest = new THREE.Euler(-0.5, 0.15, -0.35);
  wand.rotation.copy(rest);
  camera.add(wand);
  let swing = 0;
  let clock = 0;
  let lastBlock = "";

  const undo: Edit[] = [];
  const redo: Edit[] = [];
  let target: RayHit | null = null;
  const pointer = new THREE.Vector2();
  let mouseIn = false;

  const on = () => enabled.checked && ctx.ready();
  const flying = () => fly.isLocked;

  // First person: walking (gravity, collision) or flying (free). Double-tap Space switches, like creative mode.
  let walking = true;
  let lastSpace = 0;
  const body: Body = { x: 0, y: 0, z: 0, vy: 0, onGround: false };

  /** Vertical extent of the block in a cell; slabs and stairs (drawn as half blocks) are half height. */
  const solid: SolidAt = (x, y, z) => {
    const id = ctx.cells().get(`${x},${y},${z}`);
    if (!id) return null;
    const v = variantOf(id);
    let half = v?.s;
    if (half && v?.x === 180) half = half === "bottom" ? "top" : "bottom";
    if (half === "bottom") return [y - 0.5, y];
    if (half === "top") return [y, y + 0.5];
    return [y - 0.5, y + 0.5];
  };

  const overlapsPlayer = (c: Vec3) =>
    walking && flying() &&
    Math.abs(body.x - c[0]) < 0.5 + PLAYER_WIDTH / 2 && Math.abs(body.z - c[2]) < 0.5 + PLAYER_WIDTH / 2 &&
    body.y < c[1] + 0.5 && body.y + PLAYER_HEIGHT > c[1] - 0.5;

  function setMode(next: boolean) {
    walking = next;
    body.vy = 0;
    if (next) { body.x = camera.position.x; body.y = camera.position.y - EYE_HEIGHT; body.z = camera.position.z; }
    status.textContent = walking
      ? "Walking: WASD move, Space jump, double-tap Space to fly, Esc to leave"
      : "Flying: WASD move, Space up, Shift down, double-tap Space to walk, Esc to leave";
  }

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
    if (ctx.cells().has(key(at)) || overlapsPlayer(at)) return null;
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
    swing = 1;
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
  fly.addEventListener("lock", () => {
    controls.enabled = false;
    crosshair.hidden = false;
    // Start from the orbit camera's spot; step up out of any block we would start inside.
    body.x = camera.position.x; body.y = camera.position.y - EYE_HEIGHT; body.z = camera.position.z;
    for (let i = 0; i < 300 && collides(body.x, body.y, body.z, solid); i++) body.y += 1;
    walking = true;
    setMode(true);
  });
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
      toggleFly();
      return;
    }
    if (flying()) keys.add(e.code);
    if (flying() && e.code === "Space" && !e.repeat) {
      const now = performance.now();
      if (now - lastSpace < 300) setMode(!walking);
      lastSpace = now;
    }
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

  function updateWand(dt: number) {
    wand.visible = enabled.checked && ctx.ready();
    if (!wand.visible) return;
    clock += dt;
    swing = Math.max(0, swing - dt * 4);
    const block = selectedBlock();
    if (block !== lastBlock) {
      lastBlock = block;
      const c = hashColor(block);
      tipMat.color.copy(c).offsetHSL(0, 0.2, 0.15);
      (halo.material as THREE.MeshBasicMaterial).color.copy(c);
    }
    const s = Math.sin(swing * Math.PI);
    wand.rotation.set(rest.x - s * 0.9, rest.y, rest.z + s * 0.3);
    wand.position.y = -0.36 + Math.sin(clock * 2) * 0.008;
    tip.rotation.y = clock * 2;
    halo.scale.setScalar(1 + Math.sin(clock * 4) * 0.12 + s * 0.6);
  }

  const toggleFly = () => {
    if (flying()) fly.unlock();
    else if (on()) fly.lock();
  };
  document.getElementById("flybtn")!.addEventListener("click", toggleFly);
  const hint = document.getElementById("hint")!;
  const move = new THREE.Vector3();
  return {
    refreshHover,
    /** Call every frame: moves the camera while flying and keeps the hover target current. */
    tick(dt: number) {
      updateWand(dt);
      hint.hidden = !on() || flying();
      if (!flying()) return;
      const sprint = keys.has("ControlLeft");
      move.set(0, 0, 0);
      if (keys.has("KeyW")) move.z -= 1;
      if (keys.has("KeyS")) move.z += 1;
      if (keys.has("KeyA")) move.x -= 1;
      if (keys.has("KeyD")) move.x += 1;
      if (walking) {
        const f = new THREE.Vector3();
        camera.getWorldDirection(f);
        f.y = 0;
        f.normalize();
        const speed = sprint ? 7 : 4.3;
        if (move.lengthSq()) move.normalize();
        // forward is -z in `move`; right of forward (fx, fz) is (-fz, fx).
        stepBody(body, { vx: (f.x * -move.z - f.z * move.x) * speed, vz: (f.z * -move.z + f.x * move.x) * speed, jump: keys.has("Space") }, dt, solid);
        camera.position.set(body.x, body.y + EYE_HEIGHT, body.z);
      } else {
        const speed = (sprint ? 24 : 9) * dt;
        if (move.lengthSq()) fly.moveForward(-move.z * speed), fly.moveRight(move.x * speed);
        if (keys.has("Space")) camera.position.y += speed;
        if (keys.has("ShiftLeft") || keys.has("ShiftRight")) camera.position.y -= speed;
      }
      refreshHover();
    },
  };
}
