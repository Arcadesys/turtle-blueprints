/**
 * Quest system keyboard (with its dictation mic) as a text prompt in immersive WebXR.
 * The keyboard opens when a DOM text field is focused; only the field's value is observable.
 */

/** True when this XR session can show Quest's system keyboard. */
export function canAskByKeyboard(session: XRSession | null): boolean {
  return !!session && (session as { isSystemKeyboardSupported?: boolean }).isSystemKeyboardSupported === true;
}

/** Trimmed final text, or null when empty. */
export function normalizeAnswer(value: string): string | null {
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/** An Enter arrives as a newline in the value. */
export const isSubmitValue = (value: string): boolean => /[\r\n]/.test(value);

interface Field {
  value: string;
  placeholder: string;
  style: { cssText: string };
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  focus(opts?: { preventScroll?: boolean }): void;
  blur(): void;
}

const fields = new WeakMap<object, Field>();
let cancelActive: (() => void) | null = null;

function fieldFor(doc: Document): Field {
  let el = fields.get(doc);
  if (!el) {
    const ta = doc.createElement("textarea");
    // In-viewport and focusable (not display:none) so the page never scrolls to it.
    ta.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;pointer-events:none";
    el = ta as unknown as Field;
    fields.set(doc, el);
  }
  const node = el as unknown as Node;
  if (!node.parentNode) doc.body.appendChild(node);
  return el;
}

/**
 * Show the system keyboard and resolve with the text the player typed or dictated,
 * or null if they dismissed it empty. `onText` gets live updates for an in-world preview.
 */
export function askByKeyboard(opts: { prompt: string; onText?: (text: string) => void; doc?: Document }): Promise<string | null> {
  cancelActive?.();
  const doc = opts.doc ?? document;
  const field = fieldFor(doc);
  field.setAttribute("aria-label", opts.prompt);
  field.placeholder = opts.prompt;
  field.value = "";

  return new Promise((resolve) => {
    let done = false;
    const finish = (text: string | null) => {
      if (done) return;
      done = true;
      field.removeEventListener("input", onInput);
      field.removeEventListener("change", onDone);
      field.removeEventListener("blur", onDone);
      if (cancelActive === cancel) cancelActive = null;
      resolve(text);
    };
    const cancel = () => { finish(null); field.blur(); };
    const onInput = () => {
      opts.onText?.(field.value);
      if (isSubmitValue(field.value)) { const t = normalizeAnswer(field.value); finish(t); field.blur(); }
    };
    const onDone = () => finish(normalizeAnswer(field.value));
    cancelActive = cancel;
    field.addEventListener("input", onInput);
    field.addEventListener("change", onDone);
    field.addEventListener("blur", onDone);
    field.focus({ preventScroll: true });
  });
}
