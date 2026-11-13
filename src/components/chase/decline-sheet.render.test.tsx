// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark, on the chase board's "Why are you passing?" dialog: "needs a submit
 * button". Tapping a reason used to decline on the spot. Now it selects, and
 * Submit sends. The reason is optional in the data model
 * (decline_incident_with_reason stores nullable free text), so a note alone
 * is enough to submit.
 *
 * No DOM testing library: `react-dom/client` and `act`, the Radix dialog
 * swapped for plain elements as in code-scan-dialog.render.test.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const decline = vi.hoisted(() => ({ fn: vi.fn(async (_id: string, _text?: string | null) => {}) }));

vi.mock("@/lib/outcomes", () => ({
  DECLINE_REASONS: ["Too far", "On another chase", "Other"],
  declineWithReason: (id: string, text?: string | null) => decline.fn(id, text),
}));
vi.mock("@/lib/option-lists", () => ({
  useOptionList: () => ({
    options: [
      { id: "1", label: "Too far" },
      { id: "2", label: "Already on a job" },
    ],
  }),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement("div", { className }, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? createElement("div", { role: "dialog" }, children) : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogFooter: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
  };
});

import { DeclineSheet } from "./decline-sheet";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  decline.fn.mockReset();
  decline.fn.mockImplementation(async () => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  const onOpenChange = vi.fn();
  const onDeclined = vi.fn();
  await act(async () => {
    root.render(
      createElement(DeclineSheet, { open: true, onOpenChange, incidentId: "inc-1", onDeclined }),
    );
  });
  return { onOpenChange, onDeclined };
}

const button = (label: string) => {
  const b = [...container.querySelectorAll("button")].find((x) => x.textContent?.trim() === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
};
const submitButton = () =>
  [...container.querySelectorAll("button")].find((x) => /^Submit/.test(x.textContent ?? ""))!;
const textarea = () => container.querySelector("textarea")!;

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(value: string) {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the pass dialog", () => {
  it("tapping a reason selects it instead of declining; Submit sends it", async () => {
    const { onDeclined } = await mount();
    expect(submitButton().disabled).toBe(true);

    await click(button("Already on a job"));
    expect(decline.fn).not.toHaveBeenCalled();
    expect(button("Already on a job").getAttribute("aria-pressed")).toBe("true");
    expect(button("Too far").getAttribute("aria-pressed")).toBe("false");
    expect(submitButton().disabled).toBe(false);

    // Switching moves the selection; tapping the selected one clears it.
    await click(button("Too far"));
    expect(button("Too far").getAttribute("aria-pressed")).toBe("true");
    expect(button("Already on a job").getAttribute("aria-pressed")).toBe("false");
    await click(button("Too far"));
    expect(button("Too far").getAttribute("aria-pressed")).toBe("false");
    expect(submitButton().disabled).toBe(true);

    await click(button("Already on a job"));
    await type("  two streets over  ");
    await click(submitButton());

    expect(decline.fn).toHaveBeenCalledTimes(1);
    expect(decline.fn).toHaveBeenCalledWith("inc-1", "Already on a job — two streets over");
    expect(onDeclined).toHaveBeenCalledTimes(1);
    // Cleared for next time.
    expect(textarea().value).toBe("");
    expect(button("Already on a job").getAttribute("aria-pressed")).toBe("false");
  });

  it("a note alone is enough (reason is optional in the model)", async () => {
    const { onDeclined } = await mount();
    await type("   ");
    expect(submitButton().disabled).toBe(true);

    await type("Truck is in the shop");
    expect(submitButton().disabled).toBe(false);
    await click(submitButton());

    expect(decline.fn).toHaveBeenCalledWith("inc-1", "Truck is in the shop");
    expect(onDeclined).toHaveBeenCalledTimes(1);
  });

  it("Ctrl/Cmd+Enter in the note submits", async () => {
    await mount();
    await click(button("Too far"));
    await act(async () => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
    });
    expect(decline.fn).toHaveBeenCalledWith("inc-1", "Too far");

    decline.fn.mockClear();
    await type("plain enter");
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(decline.fn).not.toHaveBeenCalled();
  });

  it("shows pending, then on error shows it and keeps the dialog and inputs", async () => {
    let fail!: (e: Error) => void;
    decline.fn.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    const { onDeclined, onOpenChange } = await mount();
    await click(button("Already on a job"));
    await type("blocked road");
    await click(submitButton());

    expect(submitButton().textContent).toContain("Submitting");
    expect(submitButton().disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);

    await act(async () => {
      fail(new Error("Network is down"));
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Network is down");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(onDeclined).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(textarea().value).toBe("blocked road");
    expect(button("Already on a job").getAttribute("aria-pressed")).toBe("true");
    expect(submitButton().textContent).toBe("Submit");
    expect(submitButton().disabled).toBe(false);
  });

  it("Cancel closes without declining", async () => {
    const { onOpenChange } = await mount();
    await click(button("Too far"));
    await click(button("Cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(decline.fn).not.toHaveBeenCalled();
  });
});
