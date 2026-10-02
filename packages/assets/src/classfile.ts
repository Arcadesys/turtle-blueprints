/**
 * Just enough of the JVM class file format to read constants out of Minecraft's code:
 * the constant pool, methods with their bytecode, and bootstrap methods (for lambdas).
 */

export type Const =
  | { tag: "utf8"; value: string }
  | { tag: "int"; value: number }
  | { tag: "float"; value: number }
  | { tag: "long" | "double"; value: number }
  | { tag: "class"; name: number }
  | { tag: "string"; value: number }
  | { tag: "ref"; kind: "field" | "method" | "imethod"; cls: number; nat: number }
  | { tag: "nat"; name: number; desc: number }
  | { tag: "handle"; kind: number; ref: number }
  | { tag: "mtype"; desc: number }
  | { tag: "indy"; bsm: number; nat: number }
  | { tag: "other" };

export interface Method { name: string; desc: string; static: boolean; code: Uint8Array | null }

export interface ClassFile {
  name: string;
  pool: Array<Const | undefined>;
  methods: Method[];
  /** Bootstrap methods: handle index plus argument indices into the pool. */
  bootstraps: Array<{ handle: number; args: number[] }>;
}

export interface Ref { cls: string; name: string; desc: string }

export function parseClass(bytes: Uint8Array): ClassFile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const u1 = () => bytes[p++]!;
  const u2 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const u4 = () => { const v = dv.getUint32(p); p += 4; return v; };
  if (u4() !== 0xcafebabe) throw new Error("not a class file");
  p += 4;
  const count = u2();
  const pool: Array<Const | undefined> = [undefined];
  for (let i = 1; i < count; i++) {
    const tag = u1();
    switch (tag) {
      case 1: {
        const len = u2();
        pool[i] = { tag: "utf8", value: modifiedUtf8(bytes.subarray(p, p + len)) };
        p += len;
        break;
      }
      case 3: pool[i] = { tag: "int", value: dv.getInt32(p) }; p += 4; break;
      case 4: pool[i] = { tag: "float", value: dv.getFloat32(p) }; p += 4; break;
      case 5: pool[i] = { tag: "long", value: Number(dv.getBigInt64(p)) }; p += 8; i++; break;
      case 6: pool[i] = { tag: "double", value: dv.getFloat64(p) }; p += 8; i++; break;
      case 7: pool[i] = { tag: "class", name: u2() }; break;
      case 8: pool[i] = { tag: "string", value: u2() }; break;
      case 9: case 10: case 11: pool[i] = { tag: "ref", kind: tag === 9 ? "field" : tag === 10 ? "method" : "imethod", cls: u2(), nat: u2() }; break;
      case 12: pool[i] = { tag: "nat", name: u2(), desc: u2() }; break;
      case 15: pool[i] = { tag: "handle", kind: u1(), ref: u2() }; break;
      case 16: pool[i] = { tag: "mtype", desc: u2() }; break;
      case 17: case 18: pool[i] = { tag: "indy", bsm: u2(), nat: u2() }; break;
      case 19: case 20: pool[i] = { tag: "other" }; p += 2; break;
      default: throw new Error(`bad constant tag ${tag} at ${i}`);
    }
  }
  const utf = (i: number) => (pool[i] as { value: string }).value;
  p += 2; // access
  const thisClass = u2();
  p += 2; // super
  const interfaces = u2();
  p += interfaces * 2;
  const skipAttrs = () => { for (let n = u2(); n > 0; n--) { p += 2; const len = u4(); p += len; } };
  for (let n = u2(); n > 0; n--) { p += 6; skipAttrs(); } // fields
  const methods: Method[] = [];
  for (let n = u2(); n > 0; n--) {
    const access = u2();
    const name = utf(u2()), desc = utf(u2());
    let code: Uint8Array | null = null;
    for (let a = u2(); a > 0; a--) {
      const an = utf(u2()), len = u4();
      if (an === "Code") code = bytes.subarray(p + 8, p + 8 + dv.getUint32(p + 4));
      p += len;
    }
    methods.push({ name, desc, static: (access & 0x0008) !== 0, code });
  }
  const bootstraps: ClassFile["bootstraps"] = [];
  for (let a = u2(); a > 0; a--) {
    const an = utf(u2()), len = u4(), end = p + len;
    if (an === "BootstrapMethods") {
      for (let n = u2(); n > 0; n--) {
        const handle = u2();
        const args: number[] = [];
        for (let k = u2(); k > 0; k--) args.push(u2());
        bootstraps.push({ handle, args });
      }
    }
    p = end;
  }
  const cls = pool[thisClass] as { name: number };
  return { name: utf(cls.name), pool, methods, bootstraps };
}

function modifiedUtf8(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c < 0x80) s += String.fromCharCode(c);
    else if ((c & 0xe0) === 0xc0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[++i]! & 0x3f));
    else s += String.fromCharCode(((c & 0x0f) << 12) | ((b[++i]! & 0x3f) << 6) | (b[++i]! & 0x3f));
  }
  return s;
}

/** Resolve a field/method ref (or a method handle) to class, name and descriptor. */
export function refAt(cf: ClassFile, i: number): Ref | null {
  let c = cf.pool[i];
  if (c?.tag === "handle") c = cf.pool[c.ref];
  if (c?.tag !== "ref") return null;
  const cls = cf.pool[c.cls] as { name: number };
  const nat = cf.pool[c.nat] as { name: number; desc: number };
  const utf = (k: number) => (cf.pool[k] as { value: string }).value;
  return { cls: utf(cls.name), name: utf(nat.name), desc: utf(nat.desc) };
}

/** The value an ldc pushes: a string, a number, or null for anything else. */
export function ldcValue(cf: ClassFile, i: number): string | number | null {
  const c = cf.pool[i];
  if (c?.tag === "string") return (cf.pool[c.value] as { value: string }).value;
  if (c?.tag === "int" || c?.tag === "float" || c?.tag === "long" || c?.tag === "double") return c.value;
  return null;
}

export interface Insn {
  at: number;
  op: number;
  /** Constant pushed (iconst/bipush/sipush/fconst/ldc), when the instruction pushes one. */
  value?: string | number | null;
  /** Pool index for field, method, invokedynamic and ldc instructions. */
  index?: number;
  /** Local variable slot (loads, stores, iinc) and iinc's increment. */
  local?: number;
  inc?: number;
  /** Branch target (absolute offset), or a switch's default. */
  jump?: number;
  /** Switch cases: key -> absolute offset. */
  cases?: Map<number, number>;
}

// Operand bytes per opcode, for everything but tableswitch, lookupswitch and wide.
const LEN = new Uint8Array(256);
for (const op of [0x10, 0x12, 0x15, 0x16, 0x17, 0x18, 0x19, 0x36, 0x37, 0x38, 0x39, 0x3a, 0xa9, 0xbc]) LEN[op] = 1;
for (const op of [0x11, 0x13, 0x14, 0x84, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xbb, 0xbd, 0xc0, 0xc1, 0xc6, 0xc7]) LEN[op] = 2;
for (let op = 0x99; op <= 0xa8; op++) LEN[op] = 2;
LEN[0xc5] = 3;
for (const op of [0xb9, 0xba, 0xc8, 0xc9]) LEN[op] = 4;

export const OP = {
  ldc: 0x12, ldc_w: 0x13, ldc2_w: 0x14, bipush: 0x10, sipush: 0x11,
  ireturn: 0xac, freturn: 0xae, areturn: 0xb0,
  getstatic: 0xb2, putstatic: 0xb3, getfield: 0xb4,
  invokevirtual: 0xb6, invokespecial: 0xb7, invokestatic: 0xb8, invokeinterface: 0xb9, invokedynamic: 0xba,
} as const;

export function decode(cf: ClassFile, code: Uint8Array): Insn[] {
  const dv = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const out: Insn[] = [];
  let p = 0;
  while (p < code.length) {
    const at = p, op = code[p++]!;
    const insn: Insn = { at, op };
    if (op >= 0x02 && op <= 0x08) insn.value = op - 0x03; // iconst_m1..iconst_5
    else if (op >= 0x0b && op <= 0x0d) insn.value = op - 0x0b; // fconst_0..2
    else if (op === OP.bipush) insn.value = dv.getInt8(p);
    else if (op === OP.sipush) insn.value = dv.getInt16(p);
    else if (op === OP.ldc) { insn.index = code[p]!; insn.value = ldcValue(cf, insn.index); }
    else if (op === OP.ldc_w || op === OP.ldc2_w) { insn.index = dv.getUint16(p); insn.value = ldcValue(cf, insn.index); }
    else if ((op >= OP.getstatic && op <= OP.invokedynamic) || op === 0xbb || op === 0xc0 || op === 0xc1) insn.index = dv.getUint16(p);
    else if ((op >= 0x15 && op <= 0x19) || (op >= 0x36 && op <= 0x3a)) insn.local = code[p]!;
    else if (op === 0x84) { insn.local = code[p]!; insn.inc = dv.getInt8(p + 1); }
    else if ((op >= 0x99 && op <= 0xa8) || op === 0xc6 || op === 0xc7) insn.jump = at + dv.getInt16(p);
    else if (op === 0xc8) insn.jump = at + dv.getInt32(p);
    if (op === 0xaa) { // tableswitch
      p = (p + 3) & ~3;
      const lo = dv.getInt32(p + 4), hi = dv.getInt32(p + 8);
      insn.jump = at + dv.getInt32(p);
      insn.cases = new Map();
      for (let k = lo; k <= hi; k++) insn.cases.set(k, at + dv.getInt32(p + 12 + (k - lo) * 4));
      p += 12 + (hi - lo + 1) * 4;
    } else if (op === 0xab) { // lookupswitch
      p = (p + 3) & ~3;
      const n = dv.getInt32(p + 4);
      insn.jump = at + dv.getInt32(p);
      insn.cases = new Map();
      for (let k = 0; k < n; k++) insn.cases.set(dv.getInt32(p + 8 + k * 8), at + dv.getInt32(p + 12 + k * 8));
      p += 8 + n * 8;
    } else if (op === 0xc4) { // wide
      const wop = code[p]!;
      insn.op = wop;
      insn.local = dv.getUint16(p + 1);
      if (wop === 0x84) insn.inc = dv.getInt16(p + 3);
      p += wop === 0x84 ? 5 : 3;
    } else p += LEN[op]!;
    out.push(insn);
  }
  return out;
}

/** The method an invokedynamic's lambda points at (the implementation handle of LambdaMetafactory). */
export function lambdaTarget(cf: ClassFile, indyIndex: number): Ref | null {
  const c = cf.pool[indyIndex];
  if (c?.tag !== "indy") return null;
  const bsm = cf.bootstraps[c.bsm];
  const impl = bsm?.args[1];
  return impl === undefined ? null : refAt(cf, impl);
}

/** An invokedynamic's call-site descriptor, e.g. "(I)Ljava/util/function/ToIntFunction;". */
export function indyDesc(cf: ClassFile, indyIndex: number): string | null {
  const c = cf.pool[indyIndex];
  if (c?.tag !== "indy") return null;
  const nat = cf.pool[c.nat] as { desc: number };
  return (cf.pool[nat.desc] as { value: string }).value;
}

/** Number of arguments in a method descriptor. */
export function argCount(desc: string): number {
  let n = 0;
  for (let i = 1; desc[i] !== ")"; i++) {
    while (desc[i] === "[") i++;
    if (desc[i] === "L") i = desc.indexOf(";", i);
    n++;
  }
  return n;
}
