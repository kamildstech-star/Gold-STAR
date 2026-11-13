import { readFileSync } from "node:fs";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  BRAND_LOGO,
  drawLogo,
  embedLogoSource,
  embedOfficeOrBrandLogo,
  sourceFor,
} from "@/lib/brand-logo";

/** Serves the site's public/ folder the way the browser would. */
const fromPublic = async (url: string) => {
  try {
    return new Uint8Array(readFileSync(`public${url}`));
  } catch {
    return null;
  }
};

describe("the Gold Star logo on generated paper (12 Nov)", () => {
  it("prints the brand logo when the office has none", async () => {
    const doc = await PDFDocument.create();
    const logo = await embedOfficeOrBrandLogo(doc, null, fromPublic);
    expect(logo).not.toBeNull();
    expect(logo!.width / logo!.height).toBeGreaterThan(2); // the wide GOLD ★ STAR mark
  });

  it("prefers the office's own logo, and falls back when it cannot load", async () => {
    const seen: string[] = [];
    const load = async (url: string) => {
      seen.push(url);
      return url === "/missing.png" ? null : fromPublic(url);
    };
    const doc = await PDFDocument.create();
    expect(await embedOfficeOrBrandLogo(doc, "/missing.png", load)).not.toBeNull();
    expect(seen).toEqual(["/missing.png", BRAND_LOGO.url]);
  });

  it("draws the supplied vector PDFs as well as the PNG", async () => {
    for (const url of ["/brand/gold-star-logo-black.pdf", "/brand/gold-star-logo-color.pdf"]) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const logo = await embedLogoSource(doc, sourceFor(url), fromPublic);
      expect(logo, url).not.toBeNull();
      expect(drawLogo(page, logo!, 54, 740, 120)).toBeGreaterThan(20);
      expect((await doc.save()).byteLength).toBeGreaterThan(1000);
    }
  });

  it("prints nothing, rather than failing the document, when no logo can be read", async () => {
    const doc = await PDFDocument.create();
    expect(await embedOfficeOrBrandLogo(doc, null, async () => null)).toBeNull();
    expect(sourceFor("/x/logo.JPG").kind).toBe("jpg");
  });
});
