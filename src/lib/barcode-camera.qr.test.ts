import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ASSET_TAG_FORMATS, BADGE_FORMATS, scanWantsQr } from "@/lib/barcode-camera";

/**
 * The scanner reads QR codes, on every device.
 *
 * Melly, 17 Sep, watching three printed business-card QR codes fail in a row on
 * the call: "basically it's looking for a barcode instead of QR codes." He was
 * right, and literally so — the only JavaScript decoder in the live loop was a
 * Code 128 scanline reader, which samples a narrow horizontal band. A QR code
 * is two-dimensional; a 34% strip through the middle of one cannot be decoded
 * by construction. Safari ships no `BarcodeDetector`, so on every iPhone that
 * scanline reader was the whole of it.
 *
 * His bar for the fix: "you want it to be instant, quick, done, no problems."
 *
 * The camera and the decoders cannot run in vitest — there is no DOM testing
 * library here and no camera — so the loop's structure is asserted at source
 * level, per the house rules, with each assertion pulling out the one fragment
 * it is about. The manual camera test is in the PR body.
 */

const SOURCE = readFileSync("src/lib/barcode-camera.ts", "utf8").replace(/\r\n/g, "\n");

describe("scanWantsQr — paying for QR only where it is wanted", () => {
  it("is on for the formats a badge or a business card uses", () => {
    expect(scanWantsQr(BADGE_FORMATS)).toBe(true);
  });

  it("is off for the asset plate, which is Code 128 and nothing else", () => {
    // So the equipment scanner never loads jsQR and never pays for a QR pass
    // on every frame. The fix must not slow down the thing that already worked.
    expect(scanWantsQr(ASSET_TAG_FORMATS)).toBe(false);
  });

  it("is off for an empty format list rather than guessing", () => {
    expect(scanWantsQr([])).toBe(false);
  });
});

describe("the QR sampler reads a frame, not a stripe", () => {
  it("draws the whole frame, unlike the Code 128 band", () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf("function sampleFrameQr"),
      SOURCE.indexOf("type JsQrLike"),
    );
    // The 1-D sampler crops to BAND around the aim line; this one must not.
    expect(fn).not.toContain("BAND");
    expect(fn).toContain("ctx.drawImage(video, 0, 0, vw, vh, 0, 0, w, h)");
  });

  it("works at a small enough frame to stay quick", () => {
    // "Instant, quick, done" — jsQR's cost is roughly the pixel count.
    const width = /const QR_WORK_WIDTH = (\d+);/.exec(SOURCE)?.[1];
    expect(Number(width)).toBeLessThanOrEqual(960);
    expect(Number(width)).toBeGreaterThanOrEqual(320);
  });

  it("does not pay for inverted codes on every frame", () => {
    const fn = SOURCE.slice(
      SOURCE.indexOf("function sampleFrameQr"),
      SOURCE.indexOf("type JsQrLike"),
    );
    expect(fn).toContain('inversionAttempts: "dontInvert"');
  });
});

describe("the loop", () => {
  const loop = SOURCE.slice(SOURCE.indexOf("export function startScanLoop"));

  it("loads jsQR only when there is no native reader and QR was asked for", () => {
    expect(loop).toMatch(/if \(!native && opts\.qrFallback !== false && scanWantsQr\(formats\)\)/);
  });

  it("imports jsQR dynamically, so a screen that never scans does not carry it", () => {
    expect(loop).toContain('await import("jsqr")');
  });

  it("survives jsQR failing to load rather than taking the camera down", () => {
    const block = loop.slice(loop.indexOf('await import("jsqr")'));
    expect(block.slice(0, 260)).toContain("catch");
  });

  it("tries QR before the Code 128 band", () => {
    const body = loop.slice(loop.indexOf("const tick"));
    const qrAt = body.indexOf("sampleFrameQr");
    const code128At = body.indexOf("sampleFrame(opts.video");
    expect(qrAt).toBeGreaterThan(-1);
    expect(code128At).toBeGreaterThan(-1);
    expect(qrAt).toBeLessThan(code128At);
  });

  it("still falls through to Code 128 when the frame holds no QR", () => {
    // Both decoders run on the JavaScript path; QR did not replace Code 128.
    // Pinned as "runs only when QR found nothing", not as a call signature:
    // the Code 128 pass grew a second, cropped look at the frame and takes its
    // surfaces as a list, and that is not what this test is about.
    // 22 Oct: the Code 128 look is the whole frame now, taken on the JS
    // reader's turn; it still runs only when QR found nothing.
    expect(loop).toMatch(
      /if \(!hit && scanline && jsTurn\) \{\s*const look = sampleFrame\(opts\.video,/,
    );
  });

  it("reports the JavaScript path by a name that no longer means Code-128-only", () => {
    expect(loop).toContain('opts.onEngine?.(native ? "native" : "javascript")');
    expect(SOURCE).not.toContain('"scanline";');
  });
});

describe("nothing still claims the device can only read Code 128", () => {
  it("has no stale message left in a scanning screen", () => {
    /*
     * The rename from "scanline" to "javascript" was chosen to force exactly
     * this: every message about what the fallback can read had to be revisited.
     *
     * Comments are stripped first, and that is not incidental. The first
     * version of this test failed against the comment EXPLAINING the fix, which
     * quotes the old sentence — the house rule about an explanatory comment
     * satisfying or breaking an assertion, caught in the act.
     */
    const withoutComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    for (const file of [
      "src/components/badge-scan-sheet.tsx",
      "src/components/asset-tag-scanner.tsx",
      "src/components/code-scan-dialog.tsx",
      "src/routes/_authenticated/supplies.index.tsx",
    ]) {
      const text = withoutComments(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
      expect(text, `${file} still promises Code 128 only`).not.toMatch(
        /only Code 128 [a-z]+ will decode/i,
      );
    }
  });
});
