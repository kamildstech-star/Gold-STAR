// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { DocumentDropzone } from "./document-dropzone";

/* FE2, 28 Oct: drag files onto Documents, or click to browse — several at once. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(props: Parameters<typeof DocumentDropzone>[0]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(DocumentDropzone, props)));
  const zone = host.querySelector("[data-document-dropzone]") as HTMLElement;
  return { host, zone, unmount: () => act(() => root.unmount()) };
}

function drop(zone: HTMLElement, types: string[], files: File[]) {
  const ev = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { types, files } });
  act(() => void zone.dispatchEvent(ev));
}

describe("document drop zone", () => {
  it("hands every dropped file over at once", () => {
    const onFiles = vi.fn();
    const { zone, unmount } = mount({ onFiles, progress: null });
    const a = new File(["a"], "a.pdf");
    const b = new File(["b"], "b.jpg");
    drop(zone, ["Files"], [a, b]);
    expect(onFiles).toHaveBeenCalledWith([a, b]);
    unmount();
  });

  it("ignores a document tile being dragged to a folder", () => {
    const onFiles = vi.fn();
    const { zone, unmount } = mount({ onFiles, progress: null });
    drop(zone, ["text/document-id"], []);
    expect(onFiles).not.toHaveBeenCalled();
    unmount();
  });

  it("says which file is going up and how many are left", () => {
    const { zone, unmount } = mount({
      onFiles: () => {},
      progress: { done: 1, total: 3, current: "b.jpg" },
    });
    expect(zone.textContent).toContain("Uploading 2 of 3 — b.jpg");
    unmount();
  });

  it("is on the Documents card, and the Upload button still takes several files", () => {
    const panel = readFileSync("src/components/documents-panel.tsx", "utf8");
    expect(panel).toContain("<DocumentDropzone");
    expect(panel).toMatch(/type="file"\s*multiple/);
  });
});
