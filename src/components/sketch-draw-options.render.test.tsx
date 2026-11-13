// @vitest-environment jsdom
/**
 * 12 Nov: "make it simple, give all shades inside the Draw". Shape, colour
 * and fill are rows of buttons, all on show while Draw is on; picking a fill
 * on a line or an arrow turns it into a rectangle.
 */
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { SketchDrawOptions } from "./sketch-draw-options";
import {
  SKETCH_INKS,
  SKETCH_INKS_OFFERED,
  SKETCH_SHADES,
  SKETCH_SHADES_OFFERED,
  type DrawStyle,
} from "@/lib/room-sketch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

async function mount(initial: DrawStyle) {
  const seen: DrawStyle[] = [];
  function Harness() {
    const [value, setValue] = useState(initial);
    return createElement(SketchDrawOptions, {
      value,
      onChange: (next: DrawStyle) => {
        seen.push(next);
        setValue(next);
      },
    });
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  const el = host;
  const group = (label: string) => el.querySelector(`[role='group'][aria-label='${label}']`)!;
  const pressed = (label: string) =>
    [...group(label).querySelectorAll("button[aria-pressed='true']")].map(
      (b) => b.getAttribute("aria-label") ?? b.textContent,
    );
  const click = async (b: Element) =>
    act(async () => {
      (b as HTMLButtonElement).click();
    });
  return { el, group, pressed, click, seen };
}

describe("the Draw tool's options", () => {
  it("shows every shape, every colour and every fill at once, as labelled buttons", async () => {
    const { group, pressed } = await mount({ shape: "arrow", ink: "red", fill: "none" });
    expect(
      [...group("Shape").querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Line", "Arrow", "Circle", "Rectangle"]);
    expect(
      [...group("Colour").querySelectorAll("button")].map((b) => b.getAttribute("aria-label")),
    ).toEqual(SKETCH_INKS_OFFERED.map((k) => SKETCH_INKS[k].label));
    expect([...group("Fill").querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "No fill",
      ...SKETCH_SHADES_OFFERED.map((k) => SKETCH_SHADES[k].label),
    ]);
    // Every fill but "No fill" shows its pattern.
    expect(group("Fill").querySelectorAll("button svg")).toHaveLength(SKETCH_SHADES_OFFERED.length);
    expect(pressed("Shape")).toEqual(["Arrow"]);
    expect(pressed("Colour")).toEqual(["Red"]);
    expect(pressed("Fill")).toEqual(["No fill"]);
  });

  it("is tap-sized: 40px on a phone, 32px on a desktop", async () => {
    const { el } = await mount({ shape: "rect", ink: "navy", fill: "none" });
    for (const b of el.querySelectorAll("[role='group'] button")) {
      expect(b.className).toMatch(/\b(size-10|h-10)\b/);
      expect(b.className).toMatch(/\bsm:(size-8|h-8)\b/);
    }
  });

  it("picks a colour", async () => {
    const { el, click, pressed, seen } = await mount({ shape: "line", ink: "red", fill: "none" });
    await click(el.querySelector("[data-ink='teal']")!);
    expect(seen.at(-1)).toEqual({ shape: "line", ink: "teal", fill: "none" });
    expect(pressed("Colour")).toEqual(["Teal"]);
  });

  it("turns a line or an arrow into a rectangle when a fill is picked", async () => {
    const { el, click, pressed, seen } = await mount({ shape: "arrow", ink: "red", fill: "none" });
    await click(el.querySelector("[data-fill='full_gut']")!);
    expect(seen.at(-1)).toEqual({ shape: "rect", ink: "red", fill: "full_gut" });
    expect(pressed("Shape")).toEqual(["Rectangle"]);
    expect(pressed("Fill")).toEqual(["Full gut"]);
  });

  it("keeps a circle a circle when it is filled, and drops the fill for a line", async () => {
    const { el, click, pressed, seen } = await mount({ shape: "circle", ink: "red", fill: "none" });
    await click(el.querySelector("[data-fill='flood_cut']")!);
    expect(seen.at(-1)).toMatchObject({ shape: "circle", fill: "flood_cut" });
    await click(el.querySelector("button[aria-label='Line']")!);
    expect(seen.at(-1)).toMatchObject({ shape: "line", fill: "none" });
    expect(pressed("Fill")).toEqual(["No fill"]);
  });
});
