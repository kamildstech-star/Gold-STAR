import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { walkFiles } from "@/lib/source-files";

import {
  SIGNED_URL_DEFAULT_SECONDS,
  signStoredFile,
  signStoredFiles,
  signedUrlSeconds,
  signedUrlStaleMs,
} from "./signed-url";

describe("signed URLs are short by default", () => {
  it("defaults to ten minutes", () => {
    expect(SIGNED_URL_DEFAULT_SECONDS).toBe(600);
    expect(signedUrlSeconds()).toBe(600);
    expect(signedUrlSeconds({ seconds: 300 })).toBe(300);
  });

  it("refuses a longer life without a reason, and accepts it with one", () => {
    expect(() => signedUrlSeconds({ seconds: 3600 })).toThrow(/needs a reason/);
    expect(() => signedUrlSeconds({ seconds: 3600, why: "  " })).toThrow(/needs a reason/);
    expect(signedUrlSeconds({ seconds: 3600, why: "emailed to a carrier" })).toBe(3600);
    expect(() => signedUrlSeconds({ seconds: 0 })).toThrow(/positive/);
  });

  it("caches hold a link a minute short of its life", () => {
    expect(signedUrlStaleMs()).toBe(9 * 60_000);
    expect(signedUrlStaleMs(300)).toBe(4 * 60_000);
  });

  it("signs through the storage client with the checked lifetime", async () => {
    const createSignedUrl = vi.fn(async () => ({ data: { signedUrl: "u" }, error: null }));
    const createSignedUrls = vi.fn(async () => ({ data: [], error: null }));
    const client = { storage: { from: () => ({ createSignedUrl, createSignedUrls }) } } as never;
    await signStoredFile(client, "documents", "a.pdf");
    expect(createSignedUrl).toHaveBeenCalledWith("a.pdf", 600, undefined);
    await signStoredFile(client, "p", "b.jpg", { seconds: 300, download: true });
    expect(createSignedUrl).toHaveBeenCalledWith("b.jpg", 300, { download: true });
    await signStoredFiles(client, "p", ["c"]);
    expect(createSignedUrls).toHaveBeenCalledWith(["c"], 600);
    expect(() => signStoredFile(client, "p", "d", { seconds: 86_400 })).toThrow(/needs a reason/);
  });
});

const SOURCES = walkFiles("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("every read link is signed through the helper", () => {
  it("nothing outside signed-url.ts calls createSignedUrl(s) directly", () => {
    const direct = SOURCES.filter(
      (f) => f !== "src/lib/signed-url.ts" && /\.createSignedUrls?\(/.test(read(f)),
    );
    expect(direct).toEqual([]);
  });

  it("every long-lived link at a call site says why", () => {
    for (const f of SOURCES) {
      for (const m of read(f).matchAll(/seconds:\s*([0-9 *_]+),?\s*\n?\s*(why:)?/g)) {
        const seconds = m[1]!
          .replace(/_/g, "")
          .split("*")
          .reduce((a, n) => a * Number(n.trim() || 1), 1);
        if (seconds > 600) expect(m[2], `${f}: ${seconds}s with no why`).toBe("why:");
      }
    }
  });

  it("no query holds a signed link for longer than it lives", () => {
    const offenders = SOURCES.filter((f) => {
      const src = read(f);
      return (
        /signStoredFiles?\(|signed[A-Z]\w*Url/.test(src) &&
        /staleTime:\s*(?:55|30)\s*\*\s*60_000/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });
});
