// @vitest-environment jsdom
import { deflateSync, strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { fetchEsx, MAX_ESX_BYTES, MAX_ESX_XML_BYTES, parseEsxBytes } from "./esx";

describe("ESX preview resource limits", () => {
  it("rejects a small ZIP whose XML expands past the limit", () => {
    const bytes = zipSync({ "XACTDOC.XML": new Uint8Array(MAX_ESX_XML_BYTES + 1) });
    expect(bytes.byteLength).toBeLessThan(100_000);
    expect(parseEsxBytes(bytes.slice().buffer)).toEqual({
      ok: false,
      reason: expect.stringContaining("preview limit"),
    });
  });
  it("bounds the nested deflate inside ZIPXML as well", () => {
    const inner = deflateSync(new Uint8Array(MAX_ESX_XML_BYTES + 1));
    const wrapped = new Uint8Array(inner.length + 5);
    wrapped.set(inner, 1);
    const bytes = zipSync({ "XACTDOC.ZIPXML": wrapped });
    expect(parseEsxBytes(bytes.slice().buffer)).toEqual({
      ok: false,
      reason: expect.stringContaining("preview limit"),
    });
  });
  it("keeps ordinary XML available for parsing", () => {
    const bytes = zipSync({
      "XACTDOC.XML": strToU8("<estimate><ClaimNumber>CLM-1</ClaimNumber></estimate>"),
    });
    const result = parseEsxBytes(bytes.slice().buffer);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary.claimNumber).toBe("CLM-1");
  });
  it("rejects excessive member counts before materializing an archive", () => {
    const bytes = zipSync(
      Object.fromEntries(Array.from({ length: 1025 }, (_, i) => [`${i}.xml`, new Uint8Array(0)])),
    );
    expect(parseEsxBytes(bytes.slice().buffer)).toEqual({
      ok: false,
      reason: expect.stringContaining("preview limit"),
    });
  });
  it("cancels an oversized download without reading its body", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ "content-length": String(MAX_ESX_BYTES + 1) }),
        body: { cancel },
      })),
    );
    try {
      expect(await fetchEsx("https://storage.example/file")).toEqual({
        ok: false,
        reason: expect.stringContaining("preview limit"),
      });
      expect(cancel).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
