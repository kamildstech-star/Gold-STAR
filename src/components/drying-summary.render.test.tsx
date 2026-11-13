/**
 * The drying summary's warning lines must be readable in the light theme.
 *
 * David, 27 Oct: "Materials", "Equipment hours" and "No fixed test points set
 * up" were invisible until selected. They were painted `text-warning-foreground`
 * — the token for text ON a solid amber fill, which is #ffffff in the light
 * theme — on a white card. Warning text on a card is `text-warning`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DryingSummaryCard } from "./drying-summary";

function html(props: Partial<Parameters<typeof DryingSummaryCard>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(DryingSummaryCard, {
      waterCategory: null,
      waterClass: null,
      dehus: null,
      materials: { total: 0, dry: 0 },
      hours: null,
      ...props,
    }),
  );
}

describe("drying summary colors", () => {
  it("paints warning lines in the readable warning color, never the on-fill foreground", () => {
    const out = html();
    expect(out).toContain("text-warning");
    expect(out).not.toContain("text-warning-foreground");
    expect(out).not.toMatch(/text-white|text-primary-foreground/);
  });

  it("labels stay in the muted body color", () => {
    const out = html();
    expect(out).toMatch(/<dt class="text-muted-foreground">Water<\/dt>/);
  });
});

/*
 * Project-wide guard for the same class of bug: `text-<status>-foreground` is
 * only for text on a solid `bg-<status>` fill. Anywhere else it is white (or,
 * in dark mode, near-background) text.
 */
describe("no on-fill foreground token used as plain text", () => {
  const root = path.resolve(__dirname, "..");
  const files: string[] = [];
  (function walk(d: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
    }
  })(root);

  it("pairs every text-warning/success/info/destructive-foreground with its solid fill", () => {
    const bad: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = line.match(/text-(warning|success|info|destructive)-foreground(?![-/\w])/);
          if (!m || line.trim().startsWith("{/*") || line.trim().startsWith("*")) return;
          if (new RegExp(`bg-${m[1]}(?![-/\\w])`).test(line)) return;
          if (/style=\{\{\s*color/.test(line)) return;
          bad.push(`${path.relative(root, f)}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
