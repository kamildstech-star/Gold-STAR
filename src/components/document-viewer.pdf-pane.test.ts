import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, enforcedPolicy } from "@/lib/security-response";
import {
  PDF_PAGE_EDGE,
  PDF_PAGE_EDGE_ZOOMED,
  PDF_PAGE_ZOOM_STEP,
  pdfPageRasterEdge,
} from "@/lib/document-thumbnails";

/**
 * Mark, 5 Oct: "it should be previewing pdfs". He opened a field work ticket
 * on desktop Chrome and got "This browser will not display the PDF."
 *
 * The browser was never the problem. The viewer embedded the file in an
 * `<object type="application/pdf">`, and the browser-hardening batch (#259,
 * 28 Sep) started enforcing `object-src 'none'` on every response, so Chrome
 * blocked the embed and rendered the `<object>`'s fallback children — which
 * is that sentence. Chrome console, reproduced against the dev server:
 *
 *   Loading plugin data from '…/api/documents/…/file#page=1&zoom=100…'
 *   violates the following Content Security Policy directive:
 *   "object-src 'none'". The action has been blocked.
 *
 * These tests hold the two halves together: the directive stays enforced,
 * and the viewer stays off every embedding technique it forbids. There is no
 * DOM testing library in this repo, so the wiring is read off the file —
 * precedent in src/components/qty-takes-a-sum.test.ts.
 */
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/**
 * Comments out, because this file's own explanation of the bug quotes both
 * the sentence and the element it is asserting are gone — and an assertion a
 * comment can satisfy is not an assertion. Only lines that begin with `//`
 * go, so a `https://` inside a string survives.
 */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const VIEWER = code("src/components/document-viewer.tsx");
const RASTERISER = code("src/lib/document-thumbnails.ts");

describe("the CSP that blanked the PDF pane", () => {
  it("still enforces object-src 'none' — this is the directive, not a guess", () => {
    // If this ever stops being true, the comment in document-viewer.tsx
    // explaining why it draws pages is describing a world that moved on.
    expect(enforcedPolicy("goldstar.example.com")).toContain("object-src 'none'");
    expect(contentSecurityPolicy({ host: "goldstar.example.com" })).toContain("object-src 'none'");
  });

  it("does not list 'self' in frame-src, so an iframe is not the way back", () => {
    // Framing the file route is reported today and blocked the day
    // CSP_ENFORCED flips. Swapping <object> for <iframe> would have been a
    // fix with a fuse on it.
    const frameSrc = contentSecurityPolicy({ host: "goldstar.example.com" }).match(
      /frame-src [^;]*/,
    );
    expect(frameSrc, "frame-src went away").not.toBeNull();
    expect(frameSrc![0]).not.toContain("'self'");
  });

  it("denies framing outright on a published host, the file route included", () => {
    // secureResponse stamps these onto every response in src/server.ts, so
    // the document's own bytes refuse to be framed in production.
    expect(enforcedPolicy("goldstar.example.com")).toContain("frame-ancestors 'none'");
  });
});

describe("the document viewer's PDF pane", () => {
  it("embeds the PDF nowhere — no <object>, <embed> or <iframe>", () => {
    expect(VIEWER).not.toMatch(/<object[\s>]/);
    expect(VIEWER).not.toMatch(/<embed[\s>]/);
    expect(VIEWER).not.toMatch(/<iframe[\s>]/);
    // And no fragment-driven src for a plugin viewer to read.
    expect(VIEWER).not.toContain("navpanes=0");
  });

  it("draws the pages with the one rasteriser instead", () => {
    const branch = VIEWER.match(/loaded\.kind === "pdf" \? \(\s*<PdfPages[\s\S]{0,400}?\/>/);
    expect(branch, "the pdf branch no longer renders PdfPages").not.toBeNull();
    expect(branch![0]).toContain("page={page}");
    expect(branch![0]).toContain("zoom={zoom}");
    expect(branch![0]).toContain("rotation={rotation}");

    const render = VIEWER.match(/await pdf\.renderPage\(\{[^}]*\}\)/);
    expect(render, "the pane no longer renders a page").not.toBeNull();
    // Zoom and rotate have to reach the rasteriser or they are decoration.
    expect(render![0]).toContain("maxEdge: edge");
    expect(render![0]).toContain("rotation");
    // A letter page is 612x792 points. Without this it rasterises at 612px
    // and the pane stretches it — a soft preview that looks like a bad scan.
    expect(render![0]).toContain("upscale: true");
  });

  it("no longer tells people their browser cannot show a PDF", () => {
    expect(VIEWER).not.toContain("This browser will not display the PDF");
    expect(VIEWER).not.toContain("has no built-in PDF viewer");
  });

  it("keeps the escape hatch, for the document that genuinely will not draw", () => {
    const fallback = VIEWER.match(
      /This document could not be drawn here[\s\S]{0,900}?<\/div>\s*<\/div>/,
    );
    expect(fallback, "the PDF fallback went away").not.toBeNull();
    expect(fallback![0]).toContain("Open in a new tab");
    expect(fallback![0]).toContain("Download");
  });

  it("leaves the image preview alone — a document may be a photo", () => {
    const imageBranch = VIEWER.match(/loaded\.kind === "image" \? \([\s\S]{0,700}?\n {10}\) :/);
    expect(imageBranch, "the image branch went away").not.toBeNull();
    // Straight at the file route, sized by the same zoom control, and still
    // asking the server why when the <img> fails.
    expect(imageBranch![0]).toContain("src={fileUrl}");
    expect(imageBranch![0]).toContain("width: `${zoom}%`");
    expect(imageBranch![0]).toContain("explainImageFailure");
  });

  it("opens the document once and pages inside it", () => {
    // Reopening per page turn would re-download a 40MB photo report every
    // time somebody pressed Next; the response is `no-store`.
    expect(VIEWER).toContain("openPdfDocument(input)");
    expect(VIEWER.match(/openPdfDocument\(/g)).toHaveLength(1);
    const close = VIEWER.match(/return \(\) => \{\s*live = false;\s*opened\?\.close\(\);/);
    expect(close, "the pdf.js worker is never released").not.toBeNull();
  });
});

describe("one rasteriser, loaded on demand", () => {
  it("has exactly one pdf.js import site in the app", () => {
    expect(RASTERISER.match(/import\("pdfjs-dist\/legacy\/build\/pdf\.mjs"\)/g)).toHaveLength(1);
    expect(RASTERISER.match(/getDocument\(\{/g)).toHaveLength(1);
    // Dynamic, so a megabyte of pdf.js stays out of the main bundle and out
    // of the Worker's entry graph.
    expect(RASTERISER).not.toMatch(/^import .* from "pdfjs-dist/m);
  });

  it("adds a quarter turn to the page's own /Rotate rather than replacing it", () => {
    // pdf.js defaults the viewport's rotation to the page's, so passing 0
    // would straighten a page that is meant to be sideways.
    const turn = RASTERISER.match(/const turn = [^;]+;/);
    expect(turn, "the rotation calculation went away").not.toBeNull();
    expect(turn![0]).toContain("page.rotate");
    expect(turn![0]).toContain("opts.rotation");
  });

  it("only enlarges a page when the caller asks, so thumbnails are unchanged", () => {
    const scale = RASTERISER.match(/const scale = opts\.upscale[^;]+;/);
    expect(scale, "the scale calculation went away").not.toBeNull();
    expect(scale![0]).toContain("Math.min(1, maxEdge / longest)");
  });
});

describe("pdfPageRasterEdge", () => {
  it("draws at one size up to the step and a larger one past it", () => {
    expect(pdfPageRasterEdge(25)).toBe(PDF_PAGE_EDGE);
    expect(pdfPageRasterEdge(100)).toBe(PDF_PAGE_EDGE);
    expect(pdfPageRasterEdge(PDF_PAGE_ZOOM_STEP)).toBe(PDF_PAGE_EDGE);
    expect(pdfPageRasterEdge(PDF_PAGE_ZOOM_STEP + 25)).toBe(PDF_PAGE_EDGE_ZOOMED);
    expect(pdfPageRasterEdge(400)).toBe(PDF_PAGE_EDGE_ZOOMED);
  });

  it("is two tiers and not a redraw per click", () => {
    const edges = new Set<number>();
    for (let zoom = 25; zoom <= 400; zoom += 25) edges.add(pdfPageRasterEdge(zoom));
    expect([...edges].sort((a, b) => a - b)).toEqual([PDF_PAGE_EDGE, PDF_PAGE_EDGE_ZOOMED]);
  });

  it("stays inside what a phone can allocate for a letter page", () => {
    // 612 x 792 points at the zoomed tier, 4 bytes a pixel.
    const scale = PDF_PAGE_EDGE_ZOOMED / 792;
    const megabytes = (612 * scale * (792 * scale) * 4) / 1024 ** 2;
    expect(megabytes).toBeLessThan(32);
  });
});
