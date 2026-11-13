import { afterEach, describe, expect, it, vi } from "vitest";
import { sharePdfFile } from "./pdf-share";

afterEach(() => vi.unstubAllGlobals());
const bytes = new Uint8Array([37, 80, 68, 70]);

describe("sharing a customer PDF", () => {
  it("shares the exact PDF file with its name and title", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { canShare: () => true, share });
    expect(await sharePdfFile(bytes, "estimate", "Customer estimate")).toBe("shared");
    const data = share.mock.calls[0][0];
    expect(data.title).toBe("Customer estimate");
    expect(data.files[0].name).toBe("estimate.pdf");
    expect(data.files[0].type).toBe("application/pdf");
    expect(new Uint8Array(await data.files[0].arrayBuffer())).toEqual(bytes);
    expect(data.url).toBeUndefined();
  });
  it("offers the download fallback when file sharing is unsupported", async () => {
    const share = vi.fn();
    vi.stubGlobal("navigator", { canShare: () => false, share });
    expect(await sharePdfFile(bytes, "estimate.pdf", "Estimate")).toBe("unsupported");
    expect(share).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", {});
    expect(await sharePdfFile(bytes, "estimate.pdf", "Estimate")).toBe("unsupported");
  });
  it("treats dismissing the share sheet as cancellation", async () => {
    vi.stubGlobal("navigator", {
      canShare: () => true,
      share: vi.fn().mockRejectedValue(new DOMException("Canceled", "AbortError")),
    });
    expect(await sharePdfFile(bytes, "estimate.pdf", "Estimate")).toBe("cancelled");
  });
  it("surfaces a failed share rather than claiming success", async () => {
    vi.stubGlobal("navigator", {
      canShare: () => true,
      share: vi.fn().mockRejectedValue(new Error("Share failed")),
    });
    await expect(sharePdfFile(bytes, "estimate.pdf", "Estimate")).rejects.toThrow("Share failed");
  });
});
