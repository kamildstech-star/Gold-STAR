// @vitest-environment jsdom
/**
 * 11 Nov: "Clean up with AI". The rough sketch is read into a plan and shown
 * for a person to check: every room is listed and drawn, a rename shows on
 * the plan at once, and a failed read says why and offers another go.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-start", () => ({ useServerFn: () => read }));
vi.mock("@/lib/sketch-cleanup.functions", () => ({ readSketchPlan: {} }));
vi.mock("@/components/app-context", () => ({ useAppContext: () => ({ userId: "u1" }) }));
vi.mock("@/lib/documents", () => ({
  documentFileUrl: (id: string) => `/files/${id}`,
  uploadDocumentFile: vi.fn(),
}));
vi.mock("@/lib/room-sketch", () => ({
  createRoomSketch: vi.fn(),
  saveSketchAnnotations: vi.fn(),
}));
vi.mock("@/lib/db-errors", () => ({ toastDbError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Radix dialogs portal and trap focus; a plain wrapper is enough here.
vi.mock("@/components/ui/dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Dialog: pass,
    DialogContent: pass,
    DialogHeader: pass,
    DialogTitle: pass,
    DialogDescription: pass,
  };
});

import { SketchCleanupDialog } from "./sketch-cleanup-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
beforeEach(() => {
  // The sketch is fetched and downscaled in the browser before it is sent.
  globalThis.fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(["x"]) })) as never;
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width: 2000,
    height: 1500,
  });
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => {},
    drawImage: () => {},
    set fillStyle(_v: string) {},
  })) as never;
  HTMLCanvasElement.prototype.toDataURL = () => `data:image/jpeg;base64,${"A".repeat(80)}`;
});
afterEach(() => {
  host?.remove();
  host = null;
  read.mockReset();
});

const sketch = {
  id: "s1",
  job_id: "j1",
  room_id: null,
  floor_label: "1st floor",
  name: "20261006_0002",
  document_id: "d1",
  width: 1000,
  height: 750,
  annotations: [],
  created_by: null,
  updated_at: "2026-11-11T00:00:00Z",
};

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(SketchCleanupDialog, {
        sketch,
        job: { id: "j1", location_id: "l1" },
        marks: [{ kind: "marker", x: 0.3, y: 0.3, equipment: "dehumidifier" }],
        onClose: () => {},
        onCreated: () => {},
      }),
    );
  });
  for (let i = 0; i < 20 && !/Rooms ·|Try again/.test(host.textContent ?? ""); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return host;
}

describe("Clean up with AI", () => {
  it("lists and draws every room read from the sketch, and a rename shows on the plan", async () => {
    read.mockResolvedValue({
      ok: true,
      plan: {
        title: "1st Floor",
        rooms: [
          { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4, name: "Kitchen", width: `13'3"`, length: null },
          { x0: 0.4, y0: 0.1, x1: 0.7, y1: 0.4, name: "Bath", width: null, length: null },
        ],
        stairs: [],
      },
    });
    const el = await mount();
    // The sketch went to the server as an image data URL.
    expect(read.mock.calls[0]![0].data.image_data_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(el.textContent).toContain("Rooms · 2");
    const plan = el.querySelector("[data-clean-plan]")!;
    expect([...plan.querySelectorAll("text")].map((t) => t.textContent)).toEqual(
      expect.arrayContaining(["Kitchen", "Bath", `13'3"`, "1st Floor"]),
    );
    expect(el.textContent).toContain("Bring my 1 mark onto the clean plan");

    const name = el.querySelector<HTMLInputElement>("input[aria-label='Room name']")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(name, "Kitchen / Dining");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...plan.querySelectorAll("text")].map((t) => t.textContent)).toContain(
      "Kitchen / Dining",
    );
  });

  it("says why a read failed and offers another go", async () => {
    read.mockResolvedValue({ ok: false, retryable: false, error: "Couldn't find any rooms." });
    const el = await mount();
    expect(el.textContent).toContain("Couldn't find any rooms.");
    expect(el.textContent).toContain("Try again");
    expect(el.querySelector("[data-clean-plan]")).toBeNull();
  });
});
