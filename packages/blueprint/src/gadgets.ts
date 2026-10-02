import { AIR, baseId, bounds, materials, type Blueprint } from "@tb/blueprint";

/**
 * Building Gadgets 2 template (the JSON its Template Manager copies to and
 * pastes from the clipboard). Matches BuildingGadgets2 1.21.1:
 * util/datatypes/Template.java and BG2Data.statePosListToNBTMapArray.
 *
 * `statePosArrayList` is SNBT for a compound holding a block-state palette and
 * one palette index per cell of the bounding box, air included, walked x
 * fastest, then y, then z (BlockPos.betweenClosedStream order).
 */
export interface GadgetsTemplate {
  name: string;
  statePosArrayList: string;
  requiredItems: Record<string, number>;
}

/** Cells in the bounding box; every one is encoded, so large hollow builds get big. */
export function gadgetsCells(bp: Blueprint): number {
  const bb = bounds(bp);
  return bb ? bb.size[0] * bb.size[1] * bb.size[2] : 0;
}

const snbtString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** NbtUtils.writeBlockState as SNBT: {Name:"ns:id",Properties:{k:"v"}} */
function stateSnbt(block: string): string {
  const m = /\[(.*)\]$/.exec(block);
  const name = `Name:${snbtString(baseId(block))}`;
  if (!m?.[1]) return `{${name}}`;
  const props = m[1].split(",").map((p) => {
    const [k, v] = p.split("=");
    return `${k}:${snbtString(v ?? "")}`;
  });
  return `{${name},Properties:{${props.join(",")}}}`;
}

export function toGadgetsTemplate(bp: Blueprint): GadgetsTemplate {
  const bb = bounds(bp);
  if (!bb) throw new Error(`${bp.name} is empty; nothing to export`);
  const [sx, sy, sz] = bb.size;
  // Palette: air first, then each distinct full state (blockstate kept; the gadget places it).
  const palette = [AIR];
  const index = new Map<string, number>([[AIR, 0]]);
  const cells = new Int32Array(sx * sy * sz);
  for (const [x, y, z, block] of bp.blocks) {
    let i = index.get(block);
    if (i === undefined) {
      i = palette.length;
      palette.push(block);
      index.set(block, i);
    }
    cells[(x - bb.min[0]) + sx * ((y - bb.min[1]) + sy * (z - bb.min[2]))] = i;
  }
  const pos = (x: number, y: number, z: number) => `{X:${x},Y:${y},Z:${z}}`;
  const snbt =
    `{blockstatemap:[${palette.map(stateSnbt).join(",")}],` +
    `endpos:${pos(sx - 1, sy - 1, sz - 1)},startpos:${pos(0, 0, 0)},` +
    `statelist:[I;${cells.join(",")}]}`;
  return {
    name: bp.name,
    statePosArrayList: snbt,
    requiredItems: Object.fromEntries(materials(bp).map((m) => [m.block, m.count])),
  };
}

/** Pretty JSON as the Template Manager's Copy button produces; paste it with its Paste button. */
export function toGadgetsJson(bp: Blueprint): string {
  return JSON.stringify(toGadgetsTemplate(bp), null, 2);
}
