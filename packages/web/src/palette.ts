import { baseId } from "@tb/blueprint";
import type { WireBlocks } from "@tb/blueprint/editor";
import { ensureBlocks, entryOf, iconOf, rememberSearch, textureUrl } from "./textures";

const DEFAULT_HOTBAR = ["minecraft:stone", "minecraft:stone_bricks", "minecraft:oak_planks", "minecraft:glass", "minecraft:oak_log", "minecraft:oak_stairs", "minecraft:stone_slab", "minecraft:torch", "minecraft:dirt"];
const KEY = "tb.hotbar";

let slots: string[] = load();
let selected = 0;
const listeners: Array<() => void> = [];

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(v) && v.length === 9 && v.every((s) => typeof s === "string")) return v;
  } catch { /* storage unavailable */ }
  return [...DEFAULT_HOTBAR];
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(slots)); } catch { /* ignore */ }
}

export const onPaletteChange = (fn: () => void) => listeners.push(fn);
const changed = () => { renderHotbar(); listeners.forEach((f) => f()); };

/** The block id in the selected hotbar slot. */
export const selectedBlock = (): string => slots[selected] ?? DEFAULT_HOTBAR[0]!;

export function selectSlot(i: number) {
  selected = Math.max(0, Math.min(8, i));
  changed();
}

export function setSelectedBlock(id: string) {
  slots[selected] = baseId(id);
  save();
  void ensureBlocks([id]).then(changed);
  changed();
}

function icon(block: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "icon";
  const tex = iconOf(block);
  if (tex) el.style.backgroundImage = `url(${textureUrl(tex)})`;
  else el.style.background = "var(--line)";
  return el;
}

const bar = () => document.getElementById("hotbar")!;

export function renderHotbar() {
  bar().replaceChildren(...slots.map((id, i) => {
    const b = document.createElement("button");
    b.className = "slot" + (i === selected ? " on" : "");
    b.title = `${i + 1}: ${entryOf(id)?.n ?? id}`;
    const num = document.createElement("small");
    num.textContent = String(i + 1);
    b.append(icon(id), num);
    b.addEventListener("click", () => selectSlot(i));
    return b;
  }));
}

export function initPalette() {
  const input = document.getElementById("search") as HTMLInputElement;
  const list = document.getElementById("results")!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  const run = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) { list.replaceChildren(); return; }
    const res = (await (await fetch(`/api/blocks?q=${encodeURIComponent(q)}`)).json()) as WireBlocks & { error?: string; order: string[] };
    if (mine !== seq) return;
    if (res.error) { list.textContent = res.error; return; }
    rememberSearch(res);
    if (!res.order.length) { list.textContent = "No blocks match."; return; }
    list.replaceChildren(...res.order.map((id) => {
      const li = document.createElement("li");
      li.className = "hit";
      const text = document.createElement("span");
      text.className = "name";
      text.textContent = res.blocks[id]!.n;
      const sub = document.createElement("small");
      sub.textContent = id;
      text.append(document.createElement("br"), sub);
      li.append(icon(id), text);
      li.addEventListener("click", () => setSelectedBlock(id));
      return li;
    }));
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => void run(), 150); });
  input.addEventListener("keydown", (e) => e.stopPropagation());
  void ensureBlocks(slots).then(changed);
  renderHotbar();
}
