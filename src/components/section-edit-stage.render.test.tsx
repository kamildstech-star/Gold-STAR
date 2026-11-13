// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";

import { SectionEdit, useSectionStage } from "./job-inline-field";

/*
 * 4 Nov: "before make done why it is saving??" Under a card's pencil a
 * field's write waits for Done — and only Done: leaving the card drops it.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stage: ReturnType<typeof useSectionStage> = null;
function Probe() {
  stage = useSectionStage();
  return null;
}

const mount = () => {
  const el = document.createElement("div");
  const root = createRoot(el);
  const render = (editing: boolean) =>
    act(() => root.render(createElement(SectionEdit, { editing, children: createElement(Probe) })));
  return { root, render };
};

describe("SectionEdit holds writes until Done", () => {
  it("writes nothing while open, then the last value per field on Done", async () => {
    const { render } = mount();
    await render(true);
    const run = vi.fn();
    const last = vi.fn();
    stage!("a", run);
    stage!("a", last); // the same field changed again: only the last counts
    expect(run).not.toHaveBeenCalled();
    expect(last).not.toHaveBeenCalled();
    await render(false);
    await act(async () => {});
    expect(run).not.toHaveBeenCalled();
    expect(last).toHaveBeenCalledTimes(1);
  });

  it("writes nothing if the card goes away while open, and says so", async () => {
    const { root, render } = mount();
    await render(true);
    const run = vi.fn();
    stage!("a", run);
    await act(() => root.unmount());
    await act(async () => {});
    expect(run).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith("Changes not saved — press Done to save them.");
  });

  it("offers no staging while closed — a clicked field saves at once", async () => {
    const { render } = mount();
    await render(false);
    expect(stage).toBeNull();
  });
});
