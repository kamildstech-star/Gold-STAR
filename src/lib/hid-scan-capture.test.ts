// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useHidScanCapture } from "@/hooks/use-hid-scan-capture";
import {
  HID_EMPTY,
  HID_KEY_GAP_MS,
  hidCaptureStep,
  isTypingTarget,
  keepKeyboardDown,
  type HidCaptureState,
} from "@/lib/hid-scan-capture";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 22 Oct, field screenshot: on an iPhone the scanner opened with the keyboard
 * and its accessory bar over the camera. Two paths have to work afterwards:
 * a Bluetooth scanner (types a burst + Enter, nothing focused) and a person
 * typing a tag (taps the box first).
 */

function feed(keys: string[], start = 1000, gap = 15) {
  let state: HidCaptureState = HID_EMPTY;
  const codes: string[] = [];
  keys.forEach((k, i) => {
    const step = hidCaptureStep(state, k, start + i * gap);
    state = step.state;
    if (step.code) codes.push(step.code);
  });
  return codes;
}

describe("a Bluetooth scanner, read with nothing focused", () => {
  it("hands over a burst of keys on Enter", () => {
    expect(feed([..."GSR-00037-NJ", "Enter"])).toEqual(["GSR-00037-NJ"]);
  });

  it("accepts Tab as the terminator, and ignores Shift and friends", () => {
    expect(feed(["Shift", ..."GSR00037NJ", "Tab"])).toEqual(["GSR00037NJ"]);
  });

  it("starts a new code after a pause, so stray keys do not prefix it", () => {
    let state: HidCaptureState = HID_EMPTY;
    state = hidCaptureStep(state, "x", 0).state;
    const keys = [..."ABC-123", "Enter"];
    let code: string | null = null;
    keys.forEach((k, i) => {
      const step = hidCaptureStep(state, k, HID_KEY_GAP_MS + 100 + i * 10);
      state = step.state;
      code = step.code ?? code;
    });
    expect(code).toBe("ABC-123");
  });

  it("ignores a lone Enter and a too-short burst", () => {
    expect(feed(["Enter"])).toEqual([]);
    expect(feed(["A", "B", "Enter"])).toEqual([]);
  });

  it("knows a text box from everything else", () => {
    const input = document.createElement("input");
    const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(checkbox)).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("in a page", () => {
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    host?.remove();
    host = null;
  });

  function Probe({ onCode }: { onCode: (c: string) => void }) {
    useHidScanCapture(true, onCode);
    return createElement("input", { "data-typed": true });
  }

  const type = (target: EventTarget, text: string) => {
    for (const k of [...text, "Enter"]) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    }
  };

  it("a scanner's keys at the page are captured; keys typed into the box are the box's", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const onCode = vi.fn();
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe, { onCode })));

    type(document.body, "GSR-00037-NJ");
    expect(onCode).toHaveBeenCalledWith("GSR-00037-NJ");

    onCode.mockClear();
    const box = host.querySelector("input")!;
    type(box, "GSR-00038-NJ");
    expect(onCode).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("the real dialog opens with NO text box focused — the iPhone keyboard stays down", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(
          Dialog,
          { open: true },
          createElement(
            DialogContent,
            { onOpenAutoFocus: keepKeyboardDown, "aria-describedby": undefined },
            createElement(DialogTitle, null, "Scan"),
            createElement("input", { id: "typed-tag" }),
          ),
        ),
      ),
    );
    const active = document.activeElement as HTMLElement | null;
    expect(active?.id).not.toBe("typed-tag");
    expect(isTypingTarget(active)).toBe(false);
    // Tapping the box still gives it focus — a deliberate tap is honoured.
    const box = document.getElementById("typed-tag") as HTMLInputElement;
    box.focus();
    expect(document.activeElement).toBe(box);
    await act(async () => root.unmount());
  });
});

describe("every scanner surface", () => {
  it.each(["src/components/asset-tag-scanner.tsx", "src/components/code-scan-dialog.tsx"])(
    "%s keeps the keyboard down on open and reads a Bluetooth scanner",
    (file) => {
      const src = readFileSync(file, "utf8");
      expect(src).toMatch(/onOpenAutoFocus=\{keepKeyboardDown\}/);
      expect(src).toMatch(/useHidScanCapture\(open,/);
      expect(src).not.toMatch(/\bautoFocus\b/);
    },
  );
});
