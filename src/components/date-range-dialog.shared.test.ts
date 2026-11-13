import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Mark: "on hte leaderboard page, add a customs date range picker".
 *
 * The pipeline already had one, inline. Rather than a second copy on the
 * leaderboard, the dialog moved to src/components/date-range-dialog.tsx and
 * both pages render that. These guards read the two route files and pin the
 * wiring: one shared dialog, a "Custom" choice beside the presets, the range
 * in the URL, and the leaderboard's queries keyed on the real bounds so a
 * second custom range cannot be served the first one's rows. There is no
 * DOM testing library in this repo; reading the source is the precedent
 * (src/components/qty-takes-a-sum.test.ts).
 */
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const LEADERBOARD = read("../routes/_authenticated/leaderboard.index.tsx");
const PIPELINE = read("../routes/_authenticated/pipeline.index.tsx");

/** Every `<DateRangeDialog ... />` element in a file. */
const dialogs = (src: string) => src.match(/<DateRangeDialog[\s\S]*?\/>/g) ?? [];

describe("the shared custom date range dialog", () => {
  it("is rendered once by the leaderboard and once by the pipeline", () => {
    expect(dialogs(LEADERBOARD)).toHaveLength(1);
    expect(dialogs(PIPELINE)).toHaveLength(1);
  });

  it("is the only implementation — the pipeline's inline copy is gone", () => {
    // The inline version was recognisable by its own draft state.
    expect(PIPELINE).not.toMatch(/useState\(""\)[^\n]*\n[^\n]*setToDraft/);
    expect(PIPELINE).not.toContain("fromDraft");
    expect(PIPELINE).not.toContain("<DialogTitle>Custom date range</DialogTitle>");
  });

  it("applies on confirm, writing period=custom plus from/to to the URL", () => {
    for (const src of [LEADERBOARD, PIPELINE]) {
      const [dialog] = dialogs(src);
      expect(dialog).toMatch(
        /onApply=\{\(\{ from, to \}\) => update\(\{ period: "custom", from, to \}\)\}/,
      );
      // Reopening starts from the range already applied.
      expect(dialog).toContain('initialFrom={customRange?.from ?? ""}');
      expect(dialog).toContain('initialTo={customRange?.to ?? ""}');
    }
  });
});

describe("the leaderboard period control", () => {
  /** The segmented control: everything inside the bordered `flex … rounded-lg` box. */
  const control = () => {
    const m = LEADERBOARD.match(
      /<div className="flex [^"]*rounded-lg border border-border bg-card p-0\.5">([\s\S]*?)\n {14}<\/div>/,
    );
    expect(m, "period control not found").not.toBeNull();
    return m![1];
  };

  it("keeps week, month and quarter as the presets", () => {
    expect(LEADERBOARD).toMatch(/PRESET_PERIODS\.map\(\(p\) =>/);
    const lib = read("../lib/leaderboard-window.ts");
    const presets = lib.match(/PRESET_PERIODS: PresetPeriod\[\] = \[([^\]]*)\]/);
    expect(presets![1].replace(/\s|"/g, "")).toBe("week,month,quarter");
  });

  it("offers Custom, which opens the dialog rather than applying anything", () => {
    const c = control();
    const custom = c.match(
      /<button[^>]*onClick=\{\(\) => setRangeOpen\(true\)\}[\s\S]*?<\/button>/,
    );
    expect(custom, "no Custom button that opens the dialog").not.toBeNull();
    expect(custom![0]).toContain("Custom");
    expect(custom![0]).not.toContain("update(");
  });

  it("picking a preset clears the custom endpoints from the URL", () => {
    expect(control()).toContain('update({ period: p, from: "", to: "" })');
  });

  it("declares period, from and to as search params", () => {
    const vs = LEADERBOARD.match(/validateSearch: \(raw[^)]*\) => \(\{([\s\S]*?)\}\),/);
    expect(vs, "validateSearch not found").not.toBeNull();
    expect(vs![1]).toMatch(/period: \(isPeriod\(raw\.period\) \? raw\.period : "month"\)/);
    expect(vs![1]).toMatch(/from: isDay\(raw\.from\) \? raw\.from : ""/);
    expect(vs![1]).toMatch(/to: isDay\(raw\.to\) \? raw\.to : ""/);
  });

  it("prints the window as dates, from the shared label helper", () => {
    expect(LEADERBOARD).toContain("const labels = windowLabels(period, w);");
    expect(LEADERBOARD).toMatch(/\{labels\.current\} · \{labels\.previous\}/);
  });
});

describe("the leaderboard queries", () => {
  const key = (name: string) => {
    const m = LEADERBOARD.match(new RegExp(`queryKey: \\["${name}"([^\\]]*)\\]`));
    expect(m, `${name} query key not found`).not.toBeNull();
    return m![1];
  };

  it("key the standings on the actual bounds, not the period name", () => {
    expect(key("lb-standings")).toContain("w.from.toISOString(), w.to.toISOString()");
    expect(key("lb-standings")).not.toMatch(/\bperiod\b/);
  });

  it("key the comparison standings on the previous window's bounds", () => {
    expect(key("lb-standings-prev")).toContain("w.prevFrom.toISOString(), w.prevTo.toISOString()");
    expect(key("lb-standings-prev")).not.toMatch(/\bperiod\b/);
  });

  it("key the drill on its from/to", () => {
    expect(key("lb-drill")).toContain("from.toISOString(), to.toISOString()");
  });

  it("leave the queries that are not window-scoped alone", () => {
    /*
     * Streaks, the weekly challenge, team goals, wins, badges and kudos have
     * their own clocks; a custom range must not refetch or filter them.
     *
     * This asserts the absence of the *window*, not the absence of every key.
     * It used to demand an empty key, which also forbade the office — and the
     * office is exactly what "Recent wins" was missing when it listed New
     * Jersey and California wins on a board scoped to NC (QA, 2026-09-16).
     */
    const WINDOW = /toISOString|\bw\.(from|to|prevFrom|prevTo)\b|\bperiod\b/;
    for (const name of [
      "lb-weights",
      "lb-achievements",
      "lb-streaks",
      "lb-challenge",
      "lb-team-goals",
      "lb-wins",
      "badges-earned-all",
      "lb-kudos",
    ]) {
      expect(key(name), `${name} should not be window-keyed`).not.toMatch(WINDOW);
    }
  });
});
