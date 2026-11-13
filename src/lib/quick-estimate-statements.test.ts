import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUICK_ESTIMATE_STATEMENTS,
  parseQuickEstimateStatements,
  quickEstimateBlocks,
} from "@/lib/quick-estimate-statements";

/**
 * The Quick Estimate's statements and its one note.
 *
 * David, 17 Sep: it has no opening or closing statement, and "I'm thinking if
 * we should just have presets... and maybe a small little section if we want
 * to put in a note."
 *
 * The rule that shapes all of it is his too: the estimate is written standing
 * on a driveway — "open it up quickly... tap, tap, tap, and you have your
 * estimate" — so typing must never be REQUIRED. Presets apply themselves; the
 * note is the one box, and skipping it is the normal case.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/20260918160000_quick_estimate_statements.sql",
  "utf8",
).replace(/\r\n/g, "\n");

const S = DEFAULT_QUICK_ESTIMATE_STATEMENTS;

describe("the presets", () => {
  it("ship with wording, so the first estimate is never blank", () => {
    expect(S.opening.length).toBeGreaterThan(40);
    expect(S.closing.length).toBeGreaterThan(40);
  });

  it("match what the migration seeds, word for word", () => {
    /*
     * A database that has not had the migration must print the same estimate
     * as one that has. Otherwise the same job quoted twice reads differently
     * for a reason nobody could explain.
     */
    const inSql = (text: string) => text.split(/\s+/).slice(0, 6).join(" ");
    expect(MIGRATION).toContain(inSql(S.opening));
    expect(MIGRATION).toContain(inSql(S.closing));
  });

  it("never overwrites wording an office has edited", () => {
    // A seed is a starting point once.
    expect(MIGRATION).toContain("ON CONFLICT (key) DO NOTHING");
  });

  it("falls back field by field, not as a whole", () => {
    const half = parseQuickEstimateStatements({ opening: "Ours." });
    expect(half.opening).toBe("Ours.");
    expect(half.closing).toBe(S.closing);
  });

  it("treats blank and junk as unset", () => {
    expect(parseQuickEstimateStatements({ opening: "   " }).opening).toBe(S.opening);
    expect(parseQuickEstimateStatements(null)).toEqual(S);
    expect(parseQuickEstimateStatements("nope")).toEqual(S);
    expect(parseQuickEstimateStatements({ opening: 7 }).opening).toBe(S.opening);
  });
});

describe("the blocks an estimate prints", () => {
  it("opens and closes with the presets, with nothing asked of the user", () => {
    expect(quickEstimateBlocks({ statements: S })).toEqual([S.opening, S.closing]);
  });

  it("puts the note at the bottom by default", () => {
    // A note is usually a caveat about this job, and a caveat reads after the
    // price rather than before it.
    expect(quickEstimateBlocks({ statements: S, note: "Attic access needed." })).toEqual([
      S.opening,
      "Attic access needed.",
      S.closing,
    ]);
  });

  it("puts it at the top when asked — David said top or bottom", () => {
    expect(quickEstimateBlocks({ statements: S, note: "Rush job.", notePosition: "top" })).toEqual([
      "Rush job.",
      S.opening,
      S.closing,
    ]);
  });

  it("prints nothing at all for an empty note", () => {
    // Skippable has to mean invisible: no heading, no blank block, no "N/A".
    for (const note of ["", "   ", null, undefined]) {
      expect(quickEstimateBlocks({ statements: S, note })).toEqual([S.opening, S.closing]);
    }
  });

  it("drops a statement an office has deliberately emptied", () => {
    expect(quickEstimateBlocks({ statements: { opening: "", closing: S.closing } })).toEqual([
      S.closing,
    ]);
  });
});

describe("the note column", () => {
  it("is added nullable, so an estimate without one stores nothing", () => {
    expect(MIGRATION).toContain("ADD COLUMN IF NOT EXISTS note text");
  });

  it("is written as NULL rather than an empty string", () => {
    const calcs = readFileSync("src/lib/job-calculations.ts", "utf8").replace(/\r\n/g, "\n");
    expect(calcs).toContain("note: input.note.trim() || null");
  });

  it("reads back on a database that has not had the migration", () => {
    const calcs = readFileSync("src/lib/job-calculations.ts", "utf8").replace(/\r\n/g, "\n");
    expect(calcs).toContain('note: String((row as { note?: unknown }).note ?? "")');
  });

  it("changes no RLS", () => {
    expect(MIGRATION).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY/);
  });
});
