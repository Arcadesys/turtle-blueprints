import { describe, expect, it } from "vitest";
import { askByKeyboard, canAskByKeyboard, isSubmitValue, normalizeAnswer } from "./xr-voice";

type Fn = () => void;
function fakeDoc() {
  const handlers: Record<string, Fn[]> = {};
  const field = {
    value: "", placeholder: "", style: { cssText: "" }, attrs: {} as Record<string, string>,
    parentNode: null as unknown, focused: false, focusCalls: 0,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    addEventListener(t: string, f: Fn) { (handlers[t] ??= []).push(f); },
    removeEventListener(t: string, f: Fn) { handlers[t] = (handlers[t] ?? []).filter((x) => x !== f); },
    focus() { this.focused = true; this.focusCalls++; },
    blur() { if (this.focused) { this.focused = false; fire("blur"); } },
  };
  const fire = (t: string) => [...(handlers[t] ?? [])].forEach((f) => f());
  const doc = {
    createElement: () => field,
    body: { appendChild: (n: typeof field) => { n.parentNode = doc.body; } },
  } as unknown as Document;
  return { doc, field, fire, handlers };
}

describe("pure helpers", () => {
  it("normalizes answers", () => {
    expect(normalizeAnswer("  build a   tower \n")).toBe("build a tower");
    expect(normalizeAnswer("  \n ")).toBeNull();
  });
  it("detects submit by newline", () => {
    expect(isSubmitValue("hi\n")).toBe(true);
    expect(isSubmitValue("hi")).toBe(false);
  });
  it("checks keyboard support", () => {
    expect(canAskByKeyboard(null)).toBe(false);
    expect(canAskByKeyboard({} as XRSession)).toBe(false);
    expect(canAskByKeyboard({ isSystemKeyboardSupported: true } as XRSession)).toBe(true);
  });
});

describe("askByKeyboard", () => {
  it("focuses a cleared field and resolves on blur with the text", async () => {
    const { doc, field, fire } = fakeDoc();
    field.value = "old";
    const seen: string[] = [];
    const p = askByKeyboard({ prompt: "What to build?", onText: (t) => seen.push(t), doc });
    expect(field.value).toBe("");
    expect(field.focused).toBe(true);
    expect(field.placeholder).toBe("What to build?");
    field.value = "a red barn ";
    fire("input");
    field.blur();
    expect(await p).toBe("a red barn");
    expect(seen).toEqual(["a red barn "]);
  });

  it("resolves null when dismissed empty", async () => {
    const { doc, field } = fakeDoc();
    const p = askByKeyboard({ prompt: "x", doc });
    field.blur();
    expect(await p).toBeNull();
  });

  it("submits on newline and removes listeners", async () => {
    const { doc, field, fire, handlers } = fakeDoc();
    const p = askByKeyboard({ prompt: "x", doc });
    field.value = "moat\n";
    fire("input");
    expect(await p).toBe("moat");
    expect(Object.values(handlers).flat()).toHaveLength(0);
  });

  it("a second call cancels the first with null", async () => {
    const { doc, field } = fakeDoc();
    const first = askByKeyboard({ prompt: "a", doc });
    const second = askByKeyboard({ prompt: "b", doc });
    expect(await first).toBeNull();
    field.value = "hello";
    field.blur();
    expect(await second).toBe("hello");
  });
});
