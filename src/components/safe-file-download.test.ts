// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { downloadPreviewFile } from "./safe-file-preview";

it("downloads a cross-origin file as an inert blob without navigating to uploaded content", async () => {
  vi.useFakeTimers();
  const create = vi.fn((_blob: Blob) => "blob:https://app.example/download");
  const revoke = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.download).toBe("receipt.pdf");
    expect(this.href).toBe("blob:https://app.example/download");
    expect(this.isConnected).toBe(true);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer })),
  );
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  try {
    await downloadPreviewFile("https://storage.example/file", "receipt.pdf");
    expect(create.mock.calls[0][0].type).toBe("application/octet-stream");
    expect(click).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
    expect(revoke).toHaveBeenCalledWith("blob:https://app.example/download");
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
