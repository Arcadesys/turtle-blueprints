/**
 * Block light from game code. Light emission and noOcclusion live in Java, not in resource
 * packs, so this reads them from bytecode: the Properties chain each block is registered with
 * (`.lightLevel(...)`, `.noOcclusion()`, `ofFullCopy(Blocks.X)`), in vanilla's Blocks.<clinit>
 * and in mod registration classes. The lightLevel function is run per blockstate by a small
 * interpreter, so lit furnaces, candle counts and sea pickles get their real levels.
 */
import { argCount, decode, indyDesc, lambdaTarget, OP, parseClass, refAt, type ClassFile, type Insn, type Method, type Ref } from "./classfile";

export type State = Record<string, string>;

export interface CodeLight {
  /** Light given off in a blockstate (0-15), or null when the code could not be followed for it. */
  emit?: (state: State) => number | null;
  /** Properties.noOcclusion(): light passes through. */
  noOcclusion?: boolean;
}

export type ClassLoader = (name: string) => ClassFile | null;

/** Parse classes on demand from one or more maps of "pkg/Name.class" -> bytes; earlier maps win. */
export function classLoader(...maps: Array<Map<string, Uint8Array>>): ClassLoader {
  const cache = new Map<string, ClassFile | null>();
  return (name) => {
    let cf = cache.get(name);
    if (cf !== undefined) return cf;
    const bytes = maps.map((m) => m.get(`${name}.class`)).find((b) => b);
    try { cf = bytes ? parseClass(bytes) : null; } catch { cf = null; }
    cache.set(name, cf);
    return cf;
  };
}

// --- Interpreter ------------------------------------------------------------

interface Closure { ref: Ref; captured: Value[] }
type Value = number | string | null | { state: State } | { prop: string } | { closure: Closure };

class Abort extends Error {}

const decoded = new WeakMap<Uint8Array, { insns: Insn[]; at: Map<number, number> }>();
function insnsOf(cf: ClassFile, m: Method) {
  let d = decoded.get(m.code!);
  if (!d) {
    const insns = decode(cf, m.code!);
    d = { insns, at: new Map(insns.map((ins, i) => [ins.at, i])) };
    decoded.set(m.code!, d);
  }
  return d;
}

function findMethod(cf: ClassFile, name: string, desc?: string): Method | undefined {
  return cf.methods.find((m) => m.name === name && (desc === undefined || m.desc === desc) && m.code);
}

/** Slots each parameter takes (long and double take two). */
function slots(desc: string): number[] {
  const out: number[] = [];
  for (let i = 1; desc[i] !== ")"; i++) {
    const c = desc[i]!;
    let arr = false;
    while (desc[i] === "[") { i++; arr = true; }
    if (desc[i] === "L") i = desc.indexOf(";", i);
    out.push(!arr && (c === "J" || c === "D") ? 2 : 1);
  }
  return out;
}

const num = (v: Value): number => {
  if (typeof v !== "number") throw new Abort("expected a number");
  return v;
};

const MATH: Record<string, (a: number[]) => number> = {
  floor: (a) => Math.floor(a[0]!), ceil: (a) => Math.ceil(a[0]!), round: (a) => Math.round(a[0]!), abs: (a) => Math.abs(a[0]!),
  min: (a) => Math.min(a[0]!, a[1]!), max: (a) => Math.max(a[0]!, a[1]!),
  clamp: (a) => Math.min(Math.max(a[0]!, a[1]!), a[2]!),
  lerp: (a) => a[1]! + a[0]! * (a[2]! - a[1]!),
  lerpInt: (a) => a[1]! + Math.floor(a[0]! * (a[2]! - a[1]!)),
};

export class Interpreter {
  private props = new Map<string, Value>();
  constructor(private load: ClassLoader) {}

  apply(c: Closure, args: Value[], depth = 0): Value {
    return this.invoke(c.ref, [...c.captured, ...args], depth);
  }

  /** The value a static field holds: a blockstate property, a ToIntFunction, Boolean.TRUE, or an enum name. */
  getStatic(ref: Ref): Value {
    const key = `${ref.cls}.${ref.name}`;
    if (this.props.has(key)) return this.props.get(key)!;
    let v: Value = ref.name.toLowerCase();
    if (ref.cls === "java/lang/Boolean") v = ref.name === "TRUE" ? 1 : 0;
    else {
      const cf = this.load(ref.cls);
      const clinit = cf && findMethod(cf, "<clinit>");
      if (cf && clinit) {
        const { insns } = insnsOf(cf, clinit);
        const k = insns.findIndex((i) => i.op === OP.putstatic && refAt(cf, i.index!)?.name === ref.name);
        if (k >= 0 && /Property;$/.test(ref.desc) && insns[k - 1]?.op === OP.getstatic) {
          // An alias such as SeaPickleBlock.PICKLES = BlockStateProperties.PICKLES.
          v = this.getStatic(refAt(cf, insns[k - 1]!.index!)!);
        } else if (k >= 0 && /Property;$/.test(ref.desc)) {
          // BooleanProperty.create("lit") and friends: the name is the nearest string before.
          for (let j = k - 1; j >= Math.max(0, k - 12); j--) if (typeof insns[j]!.value === "string") { v = { prop: insns[j]!.value as string }; break; }
        } else if (k >= 0 && ref.desc === "Ljava/util/function/ToIntFunction;") {
          v = this.valueBefore(cf, insns, k);
        }
      }
    }
    this.props.set(key, v);
    return v;
  }

  /** The value left on the stack by the instructions just before insns[k] (a constant, a lambda, a factory call, a field). */
  valueBefore(cf: ClassFile, insns: Insn[], k: number): Value {
    const p = insns[k - 1];
    if (!p) return null;
    const consts = (n: number): Value[] | null => {
      const out = insns.slice(k - 1 - n, k - 1).map((i) => (i.value === undefined ? undefined : i.value));
      return out.length === n && out.every((v) => v !== undefined) ? (out as Value[]) : null;
    };
    try {
      if (p.op === OP.invokedynamic) {
        const ref = lambdaTarget(cf, p.index!);
        const captured = consts(argCount(indyDesc(cf, p.index!) ?? "()"));
        return ref && captured ? { closure: { ref, captured } } : null;
      }
      if (p.op === OP.invokestatic) {
        const ref = refAt(cf, p.index!)!;
        const args = consts(argCount(ref.desc));
        return args ? this.invoke(ref, args, 0) : null;
      }
      if (p.op === OP.getstatic) return this.getStatic(refAt(cf, p.index!)!);
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
    }
    return null;
  }

  invoke(ref: Ref, args: Value[], depth: number): Value {
    if (depth > 10) throw new Abort("too deep");
    const name = ref.name;
    const self = args[0];
    if (name === "getValue" && self && typeof self === "object" && "state" in self) {
      const prop = args[1];
      if (!prop || typeof prop !== "object" || !("prop" in prop)) throw new Abort("getValue of unknown property");
      const v = self.state[prop.prop];
      if (v === undefined) throw new Abort(`state has no ${prop.prop}`);
      return v === "true" ? 1 : v === "false" ? 0 : /^-?\d+$/.test(v) ? Number(v) : v;
    }
    if (name === "hasProperty" && self && typeof self === "object" && "state" in self) {
      const prop = args[1];
      return prop && typeof prop === "object" && "prop" in prop && prop.prop in self.state ? 1 : 0;
    }
    if (/^(booleanValue|intValue|floatValue|doubleValue|valueOf)$/.test(name) && /^java\/lang\/(Boolean|Integer|Float|Double)$/.test(ref.cls)) return args[args.length - 1]!;
    if (name === "applyAsInt" && self && typeof self === "object" && "closure" in self) return this.apply(self.closure, args.slice(1), depth + 1);
    if ((ref.cls === "java/lang/Math" || ref.cls === "net/minecraft/util/Mth") && MATH[name]) return MATH[name]!(args.map(num));
    if (ref.cls.startsWith("java/")) throw new Abort(`no model of ${ref.cls}.${name}`);
    const cf = this.load(ref.cls);
    const m = cf && findMethod(cf, name, ref.desc);
    if (!cf || !m) throw new Abort(`cannot load ${ref.cls}.${name}`);
    return this.run(cf, m, args, depth + 1);
  }

  private run(cf: ClassFile, m: Method, args: Value[], depth: number): Value {
    const { insns, at } = insnsOf(cf, m);
    const locals: Value[] = [];
    const widths = [...(m.static ? [] : [1]), ...slots(m.desc)];
    let slot = 0;
    args.forEach((a, i) => { locals[slot] = a; slot += widths[i] ?? 1; });
    const stack: Value[] = [];
    const pop = () => { if (!stack.length) throw new Abort("stack underflow"); return stack.pop()!; };
    let i = 0;
    for (let steps = 0; steps < 10000; steps++) {
      const ins = insns[i];
      if (!ins) throw new Abort("ran off the end");
      const op = ins.op;
      let next = i + 1;
      const go = (to: number | undefined) => { const n = to === undefined ? undefined : at.get(to); if (n === undefined) throw new Abort("bad jump"); next = n; };
      if (ins.value !== undefined) {
        if (ins.value === null) throw new Abort("unsupported constant");
        stack.push(ins.value);
      } else if (op >= 0x15 && op <= 0x19) stack.push(locals[ins.local!] ?? null);
      else if (op >= 0x1a && op <= 0x2d) stack.push(locals[(op - 0x1a) % 4] ?? null);
      else if (op >= 0x36 && op <= 0x3a) locals[ins.local!] = pop();
      else if (op >= 0x3b && op <= 0x4e) locals[(op - 0x3b) % 4] = pop();
      else if (op >= 0x60 && op <= 0x83) {
        // Arithmetic: int, long, float and double share one number type here.
        // add sub mul div rem neg come in fours (int long float double); shl shr ushr and or xor in pairs (int long)
        const kind = op < 0x78 ? Math.floor((op - 0x60) / 4) : 6 + Math.floor((op - 0x78) / 2);
        if (kind === 5) { stack.push(-num(pop())); }
        else {
          const b = num(pop()), a = num(pop());
          const isInt = (op - 0x60) % 4 === 0 || (op - 0x60) % 4 === 1 || op >= 0x78;
          const r = [a + b, a - b, a * b, a / b, a % b, 0, a << b, a >> b, a >>> b, a & b, a | b, a ^ b][kind]!;
          stack.push(isInt && kind === 3 ? Math.trunc(r) : r);
        }
      } else if (op === 0x84) locals[ins.local!] = num(locals[ins.local!] ?? null) + ins.inc!;
      else if (op >= 0x85 && op <= 0x90) {
        const v = num(pop());
        // to int or long from float/double truncates; everything else keeps the value
        stack.push([0x88, 0x8b, 0x8c, 0x8e, 0x8f].includes(op) ? Math.trunc(v) : v);
      } else if (op >= 0x94 && op <= 0x98) { const b = num(pop()), a = num(pop()); stack.push(Math.sign(a - b)); }
      else if (op >= 0x99 && op <= 0x9e) {
        const v = num(pop());
        if ([v === 0, v !== 0, v < 0, v >= 0, v > 0, v <= 0][op - 0x99]) go(ins.jump);
      } else if (op >= 0x9f && op <= 0xa4) {
        const b = num(pop()), a = num(pop());
        if ([a === b, a !== b, a < b, a >= b, a > b, a <= b][op - 0x9f]) go(ins.jump);
      } else if (op === 0xa5 || op === 0xa6) {
        const b = pop(), a = pop();
        if ((a === b) === (op === 0xa5)) go(ins.jump);
      } else if (op === 0xa7 || op === 0xc8) go(ins.jump);
      else if (op === 0xaa || op === 0xab) { const key = num(pop()); go(ins.cases!.get(key) ?? ins.jump); }
      else if (op >= 0xac && op <= 0xb0) return pop();
      else if (op === 0xb1) return null;
      else if (op === OP.getstatic) stack.push(this.getStatic(refAt(cf, ins.index!)!));
      else if (op >= OP.invokevirtual && op <= OP.invokeinterface) {
        const ref = refAt(cf, ins.index!)!;
        const n = argCount(ref.desc) + (op === OP.invokestatic ? 0 : 1);
        const callArgs = stack.splice(stack.length - n, n);
        if (callArgs.length !== n) throw new Abort("stack underflow");
        const r = this.invoke(ref, callArgs, depth);
        if (!ref.desc.endsWith(")V")) stack.push(r);
      } else if (op === OP.invokedynamic) {
        const ref = lambdaTarget(cf, ins.index!);
        if (!ref) throw new Abort("not a lambda");
        const n = argCount(indyDesc(cf, ins.index!) ?? "()");
        stack.push({ closure: { ref, captured: stack.splice(stack.length - n, n) } });
      } else if (op === 0xc6 || op === 0xc7) { if ((pop() === null) === (op === 0xc6)) go(ins.jump); }
      else if (op === 0x00 || op === 0xc0) { /* nop, checkcast */ }
      else if (op === 0x01) stack.push(null);
      else if (op === 0x57) pop();
      else if (op === 0x59) { const v = pop(); stack.push(v, v); }
      else if (op === 0x5f) { const a = pop(), b = pop(); stack.push(a, b); }
      else throw new Abort(`opcode 0x${op.toString(16)}`);
      i = next;
    }
    throw new Abort("too many steps");
  }

  /** A blockstate -> light function from a ToIntFunction value. */
  emission(fn: Value): CodeLight["emit"] {
    if (!fn || typeof fn !== "object" || !("closure" in fn)) return undefined;
    const c = fn.closure;
    return (state) => {
      try {
        const v = this.apply(c, [{ state }]);
        return typeof v === "number" ? Math.max(0, Math.min(15, Math.round(v))) : null;
      } catch (e) {
        if (e instanceof Abort) return null;
        throw e;
      }
    };
  }
}

// --- Registration scan ------------------------------------------------------

interface Found { light?: Value; hasLight?: boolean; noOcclusion?: boolean; copyOf?: string }

const merge = (into: Found, more: Found) => {
  if (more.hasLight) { into.hasLight = true; into.light = more.light; }
  if (more.noOcclusion) into.noOcclusion = true;
  if (more.copyOf) into.copyOf = more.copyOf;
};
const found = (f: Found) => !!(f.hasLight || f.noOcclusion || f.copyOf);

const BLOCKS = "net/minecraft/world/level/block/Blocks";
const PROPS = "net/minecraft/world/level/block/state/BlockBehaviour$Properties";

/** What one instruction tells us about the Properties being built, following lambdas, same-class helpers and constructors. */
function visit(it: Interpreter, load: ClassLoader, cf: ClassFile, insns: Insn[], k: number, into: Found, depth: number, seen: Set<string>) {
  const ins = insns[k]!;
  if (ins.index === undefined) return;
  if (ins.op === OP.invokedynamic) {
    const t = lambdaTarget(cf, ins.index);
    // Same-class lambdas (() -> new Block(props)) and constructor references (MyLampBlock::new).
    const owner = t && depth < 3 ? (t.cls === cf.name ? cf : t.name === "<init>" && !t.cls.startsWith("java/") ? load(t.cls) : null) : null;
    if (t && owner) merge(into, scanMethod(it, load, owner, t.name, t.desc, depth + 1, seen));
    return;
  }
  if (ins.op < OP.invokevirtual || ins.op > OP.invokeinterface) return;
  const ref = refAt(cf, ins.index);
  if (!ref) return;
  if (ref.name === "lightLevel" && ref.desc.startsWith("(Ljava/util/function/ToIntFunction;)")) {
    into.hasLight = true;
    into.light = it.valueBefore(cf, insns, k);
  } else if (ref.name === "noOcclusion" && ref.desc === "()L" + PROPS + ";") into.noOcclusion = true;
  else if (/^(ofFullCopy|ofLegacyCopy|copy)$/.test(ref.name) && ref.cls === PROPS) {
    const p = insns[k - 1];
    const src = p?.op === OP.getstatic ? refAt(cf, p.index!) : null;
    if (src?.cls === BLOCKS) into.copyOf = src.name;
  } else if (depth < 3 && ref.cls !== PROPS && !ref.cls.startsWith("java/")) {
    // Helpers in the same class (Blocks.candle, a mod's registerLamp) and block constructors that build their own Properties.
    if ((ins.op === OP.invokestatic && ref.cls === cf.name) || (ins.op === OP.invokespecial && ref.name === "<init>" && ref.cls !== cf.name)) {
      const owner = ref.cls === cf.name ? cf : load(ref.cls);
      if (owner) merge(into, scanMethod(it, load, owner, ref.name, ref.desc, depth + 1, seen));
    }
  }
}

function scanMethod(it: Interpreter, load: ClassLoader, cf: ClassFile, name: string, desc: string, depth: number, seen: Set<string>): Found {
  const key = `${cf.name}.${name}${desc}`;
  const out: Found = {};
  if (seen.has(key)) return out;
  seen.add(key);
  const m = findMethod(cf, name, desc);
  if (!m) return out;
  const { insns } = insnsOf(cf, m);
  for (let k = 0; k < insns.length; k++) visit(it, load, cf, insns, k, out, depth, seen);
  seen.delete(key);
  return out;
}

const ID = /^[a-z0-9_.\-/]+(:[a-z0-9_.\-/]+)?$/;

/**
 * Walk a method that registers blocks: each id string starts a block, and what the following
 * instructions build (until the next id or a putstatic) belongs to it.
 */
export function scanRegistrations(it: Interpreter, load: ClassLoader, cf: ClassFile, m: Method,
  onBlock: (id: string, f: Found) => void, onField?: (id: string, field: string) => void) {
  const { insns } = insnsOf(cf, m);
  let id: string | null = null;
  let cur: Found = {};
  const commit = () => { if (id && found(cur)) onBlock(id, cur); cur = {}; };
  for (let k = 0; k < insns.length; k++) {
    const ins = insns[k]!;
    if (typeof ins.value === "string") {
      if (!ID.test(ins.value)) continue;
      if (id && found(cur)) { commit(); }
      id = ins.value;
      continue;
    }
    if (ins.op === OP.putstatic) {
      if (id && onField) onField(id, refAt(cf, ins.index!)!.name);
      commit();
      id = null;
      continue;
    }
    visit(it, load, cf, insns, k, cur, 0, new Set([`${cf.name}.${m.name}${m.desc}`]));
  }
  commit();
}

export interface Scan {
  /** "ns:path" -> what the code says about its light. */
  blocks: Map<string, CodeLight>;
  /** Ids whose lightLevel could not be followed. */
  unresolved: string[];
}

function toLight(it: Interpreter, f: Found): CodeLight {
  const out: CodeLight = {};
  if (f.hasLight) out.emit = it.emission(f.light ?? null) ?? (() => null);
  if (f.noOcclusion) out.noOcclusion = true;
  return out;
}

/** Vanilla blocks from Blocks.<clinit>, including copies (ofFullCopy(Blocks.GLOWSTONE)). */
export function scanVanilla(load: ClassLoader): Scan & { byField: Map<string, CodeLight> } {
  const it = new Interpreter(load);
  const cf = load(BLOCKS);
  const clinit = cf && findMethod(cf, "<clinit>");
  const blocks = new Map<string, CodeLight>();
  const byField = new Map<string, CodeLight>();
  const unresolved: string[] = [];
  if (!cf || !clinit) return { blocks, byField, unresolved };
  const raw = new Map<string, Found>();
  const fieldOf = new Map<string, string>();
  scanRegistrations(it, load, cf, clinit, (id, f) => raw.set(id, f), (id, field) => fieldOf.set(field, id));
  const resolve = (id: string, depth = 0): Found => {
    const f = raw.get(id) ?? {};
    if (!f.copyOf || depth > 4) return f;
    const base = resolve(fieldOf.get(f.copyOf) ?? "", depth + 1);
    const out: Found = { ...base, copyOf: undefined };
    merge(out, { ...f, copyOf: undefined });
    return out;
  };
  for (const id of raw.keys()) {
    const f = resolve(id);
    if (!found(f)) continue;
    const light = toLight(it, f);
    blocks.set(`minecraft:${id}`, light);
    if (f.hasLight && !(f.light && typeof f.light === "object" && "closure" in f.light)) unresolved.push(`minecraft:${id}`);
  }
  for (const [field, id] of fieldOf) { const l = blocks.get(`minecraft:${id}`); if (l) byField.set(field, l); }
  return { blocks, byField, unresolved };
}

/**
 * Mod blocks: scan the classes in one jar that build Properties with lightLevel or noOcclusion,
 * plus the classes that construct those blocks. `known` says which "ns:path" ids exist.
 */
export function scanMod(classes: Map<string, Uint8Array>, vanilla: ClassLoader, vanillaByField: Map<string, CodeLight>,
  namespaces: string[], known: (id: string) => boolean): Scan {
  const own = classLoader(classes);
  const load: ClassLoader = (n) => own(n) ?? vanilla(n);
  const it = new Interpreter(load);
  const blocks = new Map<string, CodeLight>();
  const unresolved: string[] = [];
  const has = (b: Uint8Array, s: string) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(s);
  const direct = [...classes].filter(([, b]) => has(b, "lightLevel") || has(b, "noOcclusion")).map(([n]) => n.slice(0, -6));
  if (!direct.length) return { blocks, unresolved };
  // Classes that mention one of those (registries that `new` a block whose constructor sets light).
  const users = [...classes].filter(([n, b]) => !direct.includes(n.slice(0, -6)) && direct.some((d) => has(b, d))).map(([n]) => n.slice(0, -6));
  const fullId = (s: string): string | null => {
    if (s.includes(":")) return known(s) ? s : null;
    for (const ns of namespaces) if (known(`${ns}:${s}`)) return `${ns}:${s}`;
    return null;
  };
  for (const name of [...direct, ...users]) {
    const cf = load(name);
    if (!cf) continue;
    for (const m of cf.methods) {
      if (!m.code) continue;
      try {
        scanRegistrations(it, load, cf, m, (s, f) => {
          const id = fullId(s);
          if (!id || blocks.has(id)) return;
          const merged: Found = {};
          if (f.copyOf) {
            const base = vanillaByField.get(f.copyOf);
            if (base) { blocks.set(id, { ...base, ...toLight(it, { ...f, copyOf: undefined }) }); return; }
          }
          merge(merged, f);
          if (!found(merged)) return;
          blocks.set(id, toLight(it, merged));
          if (f.hasLight && !(f.light && typeof f.light === "object" && "closure" in f.light)) unresolved.push(id);
        });
      } catch { /* a class we cannot follow; skip it */ }
    }
  }
  return { blocks, unresolved };
}
