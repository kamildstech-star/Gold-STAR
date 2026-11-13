// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NumberInput } from "./number-input";

/**
 * The caret maths is unit-tested in src/lib/number-input.test.ts. This drives
 * the real component through React with the events a browser sends, because
 * the other way these boxes fail is timing: React restores the controlled
 * value after the handler runs and the browser drops the caret at the end.
 * The component writes the text and caret into the DOM inside the handler
 * for that reason, and this is the test that would catch it regressing.
 *
 * No DOM testing library, per the brief: jsdom is already here for the
 * calculator render test, and `react-dom/client` plus `act` is enough.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

/** Type one character at the caret the way a browser does, then fire `input`. */
function typeAt(input: HTMLInputElement, caret: number, ch: string, inputType = "insertText") {
  const raw = input.value.slice(0, caret) + ch + input.value.slice(caret);
  // Bypass React's value tracker so it sees this as a user edit, not an echo.
  setNativeValue.call(input, raw);
  input.setSelectionRange(caret + ch.length, caret + ch.length);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: ch }));
}

/** Backspace at the caret: remove the character before it, then fire `input`. */
function backspaceAt(input: HTMLInputElement, caret: number) {
  const raw = input.value.slice(0, caret - 1) + input.value.slice(caret);
  setNativeValue.call(input, raw);
  input.setSelectionRange(caret - 1, caret - 1);
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
  );
}

function pasteAt(input: HTMLInputElement, caret: number, text: string) {
  typeAt(input, caret, text, "insertFromPaste");
}

/** React's onBlur listens to the bubbling `focusout`, not `blur`. */
function blur(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(props: Partial<React.ComponentProps<typeof NumberInput>> = {}) {
  const onValueChange = vi.fn();
  act(() => {
    root.render(<NumberInput decimals={2} onValueChange={onValueChange} {...props} />);
  });
  const input = container.querySelector("input")!;
  return { input, onValueChange };
}

describe("NumberInput in the DOM", () => {
  it("is a text box with the numeric keypad, never type=number", () => {
    const { input } = mount();
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("decimal");
    expect(mount({ decimals: 0 }).input.inputMode).toBe("numeric");
  });

  it("groups 1250000 as it is typed and keeps the caret at the end", () => {
    const { input, onValueChange } = mount();
    const trace: string[] = [];
    for (const ch of "1250000") {
      act(() => typeAt(input, input.selectionStart!, ch));
      trace.push(`${input.value}|${input.selectionStart}`);
    }
    expect(trace).toEqual([
      "1|1",
      "12|2",
      "125|3",
      "1,250|5",
      "12,500|6",
      "125,000|7",
      "1,250,000|9",
    ]);
    expect(onValueChange).toHaveBeenLastCalledWith(1250000, "1250000");
  });

  it("inserting 5 after the first comma of 1,250,000 leaves the caret after the 5", () => {
    const { input, onValueChange } = mount({ value: 1250000 });
    expect(input.value).toBe("1,250,000");
    act(() => typeAt(input, 2, "5"));
    expect(input.value).toBe("15,250,000");
    expect(input.selectionStart).toBe(2);
    expect(onValueChange).toHaveBeenLastCalledWith(15250000, "15250000");
  });

  it("backspacing the comma in 1,250 deletes the 1", () => {
    const { input, onValueChange } = mount({ value: 1250 });
    act(() => backspaceAt(input, 2));
    expect(input.value).toBe("250");
    expect(input.selectionStart).toBe(0);
    expect(onValueChange).toHaveBeenLastCalledWith(250, "250");
  });

  it("deleting a digit that takes a comma with it keeps the caret on its digit", () => {
    const { input } = mount({ value: 1250 });
    // "1,2|50" → delete the 2 → "150", caret after the 1.
    act(() => backspaceAt(input, 3));
    expect(input.value).toBe("150");
    expect(input.selectionStart).toBe(1);
  });

  it("pasting $1,250,000.00 into an empty box yields 1,250,000.00 and the number", () => {
    const { input, onValueChange } = mount();
    act(() => pasteAt(input, 0, "$1,250,000.00"));
    expect(input.value).toBe("1,250,000.00");
    expect(input.selectionStart).toBe(input.value.length);
    expect(onValueChange).toHaveBeenLastCalledWith(1250000, "1250000.00");
  });

  it("emits null when the box is emptied, and tidies a trailing point on blur", () => {
    const { input, onValueChange } = mount({ value: 5 });
    act(() => backspaceAt(input, 1));
    expect(input.value).toBe("");
    expect(onValueChange).toHaveBeenLastCalledWith(null, "");

    act(() => typeAt(input, 0, "1250."));
    expect(input.value).toBe("1,250.");
    act(() => blur(input));
    expect(input.value).toBe("1,250");
  });

  it("shows a string-state draft formatted and keeps a half-typed fraction when the parent echoes it back", () => {
    // The forms that hold their draft as a string hand the clean string back
    // as `value`; the box must not stamp "1,250." back to "1,250" mid-typing.
    let clean = "1250";
    const onValueChange = vi.fn((_n: number | null, c: string) => {
      clean = c;
    });
    const render = () =>
      act(() => {
        root.render(<NumberInput decimals={2} value={clean} onValueChange={onValueChange} />);
      });
    render();
    const input = container.querySelector("input")!;
    expect(input.value).toBe("1,250");
    act(() => typeAt(input, 5, "."));
    render();
    expect(input.value).toBe("1,250.");
    act(() => typeAt(input, 6, "5"));
    render();
    expect(input.value).toBe("1,250.5");
    expect(clean).toBe("1250.5");
  });

  it("lets a parent that coerces empty to 0 leave the box empty", () => {
    // `onValueChange={(n) => set(n ?? 0)}` is what the number-state forms do.
    // Without this rule the first Backspace on "5" would leave "0" behind.
    let n = 5;
    const render = () =>
      act(() => {
        root.render(<NumberInput decimals={0} value={n} onValueChange={(v) => (n = v ?? 0)} />);
      });
    render();
    const input = container.querySelector("input")!;
    act(() => backspaceAt(input, 1));
    expect(n).toBe(0);
    render();
    expect(input.value).toBe("");
    // But a real external change to 0 is still shown.
    act(() => typeAt(input, 0, "7"));
    render();
    expect(input.value).toBe("7");
    n = 0;
    render();
    expect(input.value).toBe("0");
  });

  it("resyncs when the parent changes the value from outside", () => {
    act(() => {
      root.render(<NumberInput decimals={0} value={100} />);
    });
    const input = container.querySelector("input")!;
    expect(input.value).toBe("100");
    act(() => {
      root.render(<NumberInput decimals={0} value={180000} />);
    });
    expect(input.value).toBe("180,000");
    act(() => {
      root.render(<NumberInput decimals={0} value={null} />);
    });
    expect(input.value).toBe("");
  });

  it("onCommit hands an uncontrolled cell the parsed number on blur", () => {
    const onCommit = vi.fn();
    act(() => {
      root.render(<NumberInput decimals={2} defaultValue={12.5} onCommit={onCommit} />);
    });
    const input = container.querySelector("input")!;
    expect(input.value).toBe("12.5");
    act(() => pasteAt(input, 0, "$1,000,"));
    // "$1,000," dropped in front of "12.5" is the digits 100012.5, regrouped.
    expect(input.value).toBe("100,012.5");
    act(() => blur(input));
    expect(onCommit).toHaveBeenCalledWith(100012.5);
  });
});
