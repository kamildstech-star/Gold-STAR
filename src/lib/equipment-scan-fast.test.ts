import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CODE128_PATTERNS, decodeCode128Row } from "@/lib/code128";
import {
  CAMERA_REPEAT_QUIET_MS,
  cameraReadIsNew,
  normalizeAssetTag,
  type CameraRead,
} from "@/lib/equipment-scan";

/**
 * David, 13 Oct: Jobs › Equipment scanning must be as quick as Supplies ›
 * Scan out, which takes a code on its first good read. The equipment scanner
 * used to wait for the same value on TWO reads before believing either. It
 * now accepts the first read that passes the checksum and the tag shape.
 */

/* A minimal Code 128 B encoder, for tests only (as in code128.test.ts). */
function encodeRow(text: string, scale = 3, breakChecksum = false): number[] {
  const values = [...text].map((c) => c.charCodeAt(0) - 32);
  let sum = 104;
  values.forEach((v, i) => (sum += (i + 1) * v));
  const check = (sum + (breakChecksum ? 1 : 0)) % 103;
  const runs = [104, ...values, check, 106].flatMap((s) => [...CODE128_PATTERNS[s]!].map(Number));
  const row: number[] = new Array(12 * scale).fill(255);
  runs.forEach((w, i) => {
    for (let p = 0; p < w * scale; p += 1) row.push(i % 2 === 0 ? 20 : 235);
  });
  row.push(...new Array(12 * scale).fill(255));
  return row;
}

/** The scanner's onCandidate, as a pure fold: which reads get handled. */
function handled(reads: { raw: string; at: number }[]): string[] {
  let last: CameraRead | null = null;
  const out: string[] = [];
  for (const r of reads) {
    if (!cameraReadIsNew(r.raw, last, r.at)) continue;
    last = r;
    out.push(`${r.raw}@${r.at}`);
  }
  return out;
}

describe("one confident read is enough", () => {
  it("accepts a plate on its very first read — no second frame needed", () => {
    expect(handled([{ raw: "GSR-00983-NJ", at: 0 }])).toEqual(["GSR-00983-NJ@0"]);
  });

  it("resolves that single read to the right equipment tag", () => {
    const raw = decodeCode128Row(encodeRow("GSR-00983-NJ"));
    expect(raw).toBe("GSR-00983-NJ");
    expect(normalizeAssetTag(raw!)).toBe("GSR-00983-NJ");
  });

  it("still never accepts a misread: the checksum and the tag shape guard a single read", () => {
    expect(decodeCode128Row(encodeRow("GSR-00983-NJ", 3, true))).toBeNull();
    expect(normalizeAssetTag("HELLO")).toBeNull();
    expect(normalizeAssetTag("0123456789")).toBeNull();
  });

  it("does not handle a plate left in view on every frame", () => {
    // 8 frames a second of the same plate, then a different one.
    const reads = [0, 125, 250, 375, 500].map((at) => ({ raw: "GSR-00983-NJ", at }));
    reads.push({ raw: "GSR-AM00034-NJ", at: 625 });
    expect(handled(reads)).toEqual(["GSR-00983-NJ@0", "GSR-AM00034-NJ@625"]);
  });

  it("takes the same plate again once it has been out of the way a moment", () => {
    expect(
      handled([
        { raw: "GSR-00983-NJ", at: 0 },
        { raw: "GSR-00983-NJ", at: CAMERA_REPEAT_QUIET_MS + 1 },
      ]),
    ).toHaveLength(2);
  });

  it("takes a different plate at once, even right after another", () => {
    expect(
      handled([
        { raw: "GSR-00983-NJ", at: 0 },
        { raw: "GSR-DH1-NY", at: 10 },
        { raw: "GSR-00983-NJ", at: 20 },
      ]),
    ).toEqual(["GSR-00983-NJ@0", "GSR-DH1-NY@10", "GSR-00983-NJ@20"]);
  });
});

describe("the equipment scanner's camera path", () => {
  const src = readFileSync("src/components/asset-tag-scanner.tsx", "utf8");
  const loop = src.slice(src.indexOf("const runLoop"), src.indexOf("const start = useCallback"));

  it("no longer waits for two agreeing frames", () => {
    expect(src).not.toMatch(/lastSeenRef/);
    expect(loop).not.toMatch(/two agreeing|Two agreeing/i);
  });

  it("hands the first new read straight to the same lookup as before", () => {
    expect(loop).toMatch(/cameraReadIsNew\(raw, lastReadRef\.current, now\)/);
    expect(loop).toMatch(/void acceptRef\.current\(raw, "camera"\)/);
    // Same formats: the loop is not given a format list, so it reads the
    // asset plate's Code 128 default, exactly as before.
    expect(loop).not.toMatch(/formats:/);
  });
});
