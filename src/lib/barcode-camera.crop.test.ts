import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  NATIVE_BACKUP_EVERY,
  NATIVE_ERRORS_TO_FALL_BACK,
  describeDiagnostic,
} from "@/lib/barcode-camera";

/**
 * 22 Oct — "scans not reading at all". The camera loop used to read Code 128
 * only along horizontal lines through the middle half of the frame (and only
 * when the platform had no detector of its own). These pin the replacement:
 * the whole frame, every angle, and a JavaScript reader that backs the native
 * detector up instead of being switched off by it. The decode itself is
 * tested on synthetic frames in code128-frame.test.ts.
 */
const SOURCE = readFileSync("src/lib/barcode-camera.ts", "utf8").replace(/\r\n/g, "\n");
const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const loop = code.slice(code.indexOf("export function startScanLoop"));

describe("no band, no aim box", () => {
  it("has no middle band or center crop left in the decoder", () => {
    expect(code).not.toMatch(/const BAND\b|CROP_FRACTION|framePasses/);
  });

  it("decodes the region scanRegionFor picks, in the video's own pixels", () => {
    expect(code).toMatch(/scanRegionFor\(tick, video\.videoWidth, video\.videoHeight\)/);
    expect(code).toMatch(/ctx\.drawImage\(video, region\.sx, region\.sy, region\.sw, region\.sh/);
    // Nothing about the on-screen box (its size, object-fit, the pixel ratio)
    // decides what is decoded.
    expect(code).not.toMatch(/devicePixelRatio|clientWidth|getBoundingClientRect/);
  });
});

describe("the native detector is backed up, not trusted blindly", () => {
  it("runs the JavaScript Code 128 reader beside a native detector", () => {
    expect(loop).toMatch(/const jsTurn = !native \|\| examined % NATIVE_BACKUP_EVERY === 0/);
    expect(NATIVE_BACKUP_EVERY).toBeGreaterThanOrEqual(2);
    expect(NATIVE_BACKUP_EVERY).toBeLessThanOrEqual(4);
  });

  it("gives up a native detector that keeps throwing", () => {
    expect(NATIVE_ERRORS_TO_FALL_BACK).toBe(2);
    expect(loop).toMatch(/if \(nativeErrors >= NATIVE_ERRORS_TO_FALL_BACK\) \{\s*native = null;/);
  });
});

describe("the field breadcrumb", () => {
  it("reports every frame, and writes it to the console when debugging", () => {
    expect(loop).toMatch(/opts\.onDiagnostic\?\.\(diag\)/);
    expect(loop).toMatch(/if \(debug\) console\.debug\("\[scan\]", describeDiagnostic\(diag\)\)/);
  });

  it("reads as one line a person can paste", () => {
    expect(
      describeDiagnostic({
        frame: 12,
        decoders: ["native", "code128-whole"],
        result: "checksum",
        lines: 190,
        barcodeLike: 14,
        video: "1920x1080",
        ms: 23.4,
      }),
    ).toBe("#12 [native+code128-whole] checksum lines=190 barcode-like=14 1920x1080 23ms");
  });
});
