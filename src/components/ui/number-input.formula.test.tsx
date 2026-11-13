// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NumberInput } from "@/components/ui/number-input";

/**
 * 29 Oct: "when someone writes 34*56, on leaving the box work it out with the
 * operators; if someone writes it wrong, show a message below the field so
 * they know the value is not okay."
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let commits: (number | null)[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  commits = [];
  act(() =>
    root.render(
      createElement(NumberInput, {
        allowMath: true,
        decimals: 2,
        defaultValue: 10,
        "aria-label": "Amount",
        onCommit: (n: number | null) => commits.push(n),
      }),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const box = () => host.querySelector("input")!;
function type(v: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box(), v);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const leave = () => act(() => box().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const alert = () => host.querySelector('[role="alert"]')?.textContent ?? null;

describe("a box that takes a formula", () => {
  it("works 34*56 out when you leave it", () => {
    type("34*56");
    leave();
    expect(box().value).toBe("1,904");
    expect(commits).toEqual([1904]);
    expect(alert()).toBeNull();
  });

  it("keeps a wrong formula, says why under the box, and saves nothing", () => {
    type("34**");
    leave();
    expect(box().value).toBe("34**");
    expect(box().getAttribute("aria-invalid")).toBe("true");
    expect(alert()).toBe("Not a valid sum — e.g. 34*56");
    expect(commits).toEqual([]);
  });

  it("clears the message as soon as it is being fixed, and saves the fix", () => {
    type("34**");
    leave();
    type("34*2");
    expect(alert()).toBeNull();
    leave();
    expect(commits).toEqual([68]);
  });

  it("Escape puts the saved number back", () => {
    type("5/0");
    leave();
    expect(alert()).toBe("Can’t divide by zero.");
    act(() => box().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(box().value).toBe("10");
    expect(alert()).toBeNull();
  });
});
