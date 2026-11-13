// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TokenEditor, highlightTokens, stripTokenMarkup } from "./token-editor";

vi.mock("@/components/merge-key-picker", () => ({ MergeKeyPicker: () => null }));

describe("template editor security", () => {
  it("highlights text tokens without inserting markup into attributes", () => {
    const result = highlightTokens(
      '<p title="{Job.Name}">Hello {Job.Name}</p><img src=x onerror=alert(1)>',
    );
    const el = document.createElement("div");
    el.innerHTML = result;
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("p")?.title).toBe("{Job.Name}");
    expect(el.querySelectorAll("span.mk-token")).toHaveLength(1);
    expect(highlightTokens(result)).toBe(result);
    expect(stripTokenMarkup(result)).toBe('<p title="{Job.Name}">Hello {Job.Name}</p>');
  });

  it("sanitizes stored values and clipboard HTML before DOM insertion", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const exec = vi.fn(() => true);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: exec });
    try {
      await act(async () =>
        root.render(
          <TokenEditor value="<p>Hello</p><img src=x onerror=alert(1)>" onChange={() => {}} />,
        ),
      );
      const editor = container.querySelector('[role="textbox"]')!;
      expect(editor.querySelector("img")).toBeNull();
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { getData: () => "<b>Paste</b><img src=x onerror=alert(1)>" },
      });
      await act(async () => {
        editor.dispatchEvent(paste);
      });
      expect(paste.defaultPrevented).toBe(true);
      expect(exec).toHaveBeenCalledWith("insertHTML", false, "<b>Paste</b>");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});
