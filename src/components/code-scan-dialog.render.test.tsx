// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Supplies "Scan out" report: the camera read the bin label, the code
 * matched no item, and the dialog closed with nothing on screen — which every
 * user reads as "scanning stopped working".
 *
 * Drives the real dialog with the camera swapped out: `startScanLoop` hands
 * back its `onCandidate`, so a test can "read" a code the way the decode loop
 * would. The Radix dialog is a plain element, as in drying-room-select.
 *
 * No DOM testing library, per the brief: `react-dom/client` and `act`.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let candidate: ((raw: string) => void) | null = null;

vi.mock("@/lib/barcode-camera", () => ({
  BADGE_FORMATS: ["qr_code", "code_128"],
  CAMERA_FAILURE_TEXT: {},
  CameraError: class extends Error {},
  openCamera: vi.fn(async () => ({ getTracks: () => [] })),
  stopCamera: vi.fn(),
  acquireCamera: vi.fn(async () => ({ getTracks: () => [] })),
  releaseCamera: vi.fn(),
  waitForPicture: vi.fn(async () => true),
  startScanLoop: vi.fn((opts: { onCandidate: (raw: string) => void }) => {
    candidate = opts.onCandidate;
    return () => {
      candidate = null;
    };
  }),
}));
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? createElement("div", { role: "dialog" }, children) : null,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
  };
});

import { CodeScanDialog } from "./code-scan-dialog";
import { NO_MATCH_TITLE, settleScan, type ScanRejection } from "@/lib/code-scan";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  candidate = null;
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** Only BIN-12 is a real item; anything else is refused, as Supplies does. */
async function mount() {
  const onOpenChange = vi.fn();
  const onScanned = vi.fn((raw: string): ScanRejection | void => {
    if (raw === "BIN-12") return;
    return { rejected: true, message: `No item carries the code “${raw}”.` };
  });
  await act(async () => {
    root.render(
      createElement(CodeScanDialog, {
        open: true,
        onOpenChange,
        onScanned,
        title: "Scan an item off the shelf",
        description: "",
        manualLabel: "Or type the code on the bin",
        manualPlaceholder: "BIN-12",
        dismissLabel: "Cancel",
        fallbackNote: "",
      }),
    );
  });
  expect(candidate).not.toBeNull();
  return { onOpenChange, onScanned };
}

const read = (raw: string) => act(() => candidate!(raw));
const alert = () => container.querySelector('[role="alert"]');

describe("CodeScanDialog — a read that matches nothing", () => {
  it("stays open and says what was scanned and that nothing matched", async () => {
    const { onOpenChange, onScanned } = await mount();
    read("BIN-99");
    expect(onScanned).toHaveBeenCalledWith("BIN-99");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(alert()?.textContent).toContain(NO_MATCH_TITLE);
    expect(alert()?.textContent).toContain("BIN-99");
    expect(alert()?.textContent).toContain("Still scanning");
  });

  it("keeps scanning, and a matching read after a miss closes as before", async () => {
    const { onOpenChange, onScanned } = await mount();
    read("BIN-99");
    read("BIN-99"); // the same label still in view is not re-checked every frame
    expect(onScanned).toHaveBeenCalledTimes(1);
    read("BIN-12");
    expect(onScanned).toHaveBeenLastCalledWith("BIN-12");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on a matching read with no message, exactly as before", async () => {
    const { onOpenChange } = await mount();
    read("BIN-12");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(alert()).toBeNull();
  });
});

describe("settleScan", () => {
  it("closes when the caller returns nothing (badge scans, matches)", () => {
    expect(settleScan("ABC", undefined)).toEqual({ close: true });
  });

  it("stays open with the default title on a rejection", () => {
    expect(settleScan("X1", { rejected: true, message: "nope" })).toEqual({
      close: false,
      code: "X1",
      title: NO_MATCH_TITLE,
      message: "nope",
    });
  });
});
