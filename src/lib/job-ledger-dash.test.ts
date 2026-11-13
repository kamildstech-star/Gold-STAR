import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * David, 22 Sep: "anything that's blank, I would just leave like just dash. I
 * wouldn't write not tracked."
 *
 * The rail card this first guarded is gone (Mark, 2026-10-07: "remove the job
 * ledger box at the right side"); the strip is the ledger now, so the rule is
 * held on the strip's cell.
 */
const PANEL = readFileSync("src/components/job-ledger-panel.tsx", "utf8").replace(/\r\n/g, "\n");
const STRIP = PANEL.match(/export function JobLedgerStrip[\s\S]*?\n}\n/)![0];

describe("the job ledger shows a dash for an untracked cost", () => {
  it("renders an em dash, and not the words", () => {
    const cell = STRIP.match(/<span aria-label="Not tracked">([^<]*)<\/span>/);
    expect(cell).not.toBeNull();
    expect(cell![1]).toBe("—");
    // Outside comments and attributes, the phrase is gone from the screen.
    const visible = STRIP.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"]*"/g, "");
    expect(visible).not.toMatch(/>\s*not tracked\s*</i);
  });

  it("never renders a zero in its place", () => {
    const value = STRIP.match(/const value = [^;]*;/)![0];
    expect(value).toContain("r.tracked");
    expect(value).toContain(": null");
  });
});
