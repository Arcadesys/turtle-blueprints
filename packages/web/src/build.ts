import * as THREE from "three";
import { baseId, type Op, type Vec3 } from "@tb/blueprint";
import { placementState, raycast, slabMerge, type Hit, type RayHit } from "@tb/blueprint/editor";
import { entryOf } from "./textures";
import { selectedBlock, setSelectedBlock } from "./palette";

export interface BuilderContext {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Visible cells (below the layer slice) -> block id. */
  cells: () => ReadonlyMap<string, string>;
  /** World y of the grid; the floor you can build on. */
  floorY: () => number;
  /** True if a block in this cell would be inside the walking player. */
  blocked: (cell: Vec3) => boolean;
}

export interface BuildAction { ops: Op[]; done: string }

const key = (c: Vec3) => `${c[0]},${c[1]},${c[2]}`;
const AIR = "minecraft:air";

/**
 * Hand building: aim with the pointer (or the crosshair), preview where a block would go,
 * and turn a click into ops. Right click places, left click breaks, middle click picks.
 */
export function createBuilder(ctx: BuilderContext) {
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)), new THREE.LineBasicMaterial({ color: 0x000000 }));
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }));
  outline.visible = ghost.visible = false;
  ctx.scene.add(outline, ghost);
  const caster = new THREE.Raycaster();

  function aim(ndc: THREE.Vector2): RayHit | null {
    ctx.camera.updateMatrixWorld();
    caster.setFromCamera(ndc, ctx.camera);
    const o = ctx.camera.position, d = caster.ray.direction;
    // The shared raycast puts the ground plane at the bottom of layer 0; shift it to wherever the grid sits.
    return raycast(new Set(ctx.cells().keys()), [o.x, o.y, o.z], [d.x, d.y, d.z], { groundY: ctx.floorY() });
  }

  function hitInfo(h: RayHit): Hit {
    const look = new THREE.Vector3();
    ctx.camera.getWorldDirection(look);
    return { normal: h.normal, fracY: h.point[1] - (h.cell[1] - 0.5), look: [look.x, look.y, look.z] };
  }

  /** What a right click would do: the cell to fill and the block (with state) to put there. */
  function plan(h: RayHit): { at: Vec3; block: string } | null {
    const hit = hitInfo(h);
    const placing = placementState(selectedBlock(), entryOf(selectedBlock())?.p ?? {}, hit);
    if (!h.ground) {
      const merged = slabMerge(ctx.cells().get(key(h.cell)), placing, hit);
      if (merged) return { at: h.cell, block: merged };
    }
    const at: Vec3 = [h.cell[0] + h.normal[0], h.cell[1] + h.normal[1], h.cell[2] + h.normal[2]];
    if (ctx.cells().has(key(at)) || ctx.blocked(at)) return null;
    return { at, block: placing };
  }

  return {
    /** Update the preview for the given aim (NDC), or hide it with null. */
    hover(ndc: THREE.Vector2 | null) {
      outline.visible = ghost.visible = false;
      if (!ndc) return;
      const h = aim(ndc);
      if (!h) return;
      if (!h.ground) {
        outline.position.set(...h.cell);
        outline.visible = true;
      }
      const p = plan(h);
      if (p) {
        ghost.position.set(...p.at);
        ghost.visible = true;
      }
    },
    /** Turn a click into ops (or null). Middle click picks the block into the selected slot. */
    click(button: number, ndc: THREE.Vector2): BuildAction | null {
      const h = aim(ndc);
      if (!h) return null;
      if (button === 2) {
        const p = plan(h);
        return p ? { ops: [{ op: "set", at: p.at, block: p.block }], done: `Placed ${baseId(p.block)}.` } : null;
      }
      if (h.ground) return null;
      const id = ctx.cells().get(key(h.cell));
      if (!id) return null;
      if (button === 0) return { ops: [{ op: "set", at: h.cell, block: AIR }], done: `Broke ${baseId(id)}.` };
      if (button === 1) setSelectedBlock(baseId(id));
      return null;
    },
  };
}
