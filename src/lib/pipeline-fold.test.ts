import { describe, expect, it } from "vitest";

import {
  ACTIVE_CLIENTS_FOLD_SCOPE,
  PIPELINE_FOLD_SCOPE,
  layoutColumns,
  parseFoldedStages,
  toggleFolded,
} from "@/lib/pipeline-fold";

/**
 * Mark, 2026-09-09: "When a tab is folded it should move to the right side of
 * the page, if its in middle then all other pipelines should get wider and it
 * should stay in its place." The placement rule is pinned here; the width
 * is CSS now (every open column grows, a strip never does -- see the column
 * class string in pipeline-board.tsx and its source test), since Mark asked
 * for the growing on an unfolded board too: "cards need to auto resize to
 * the cards above it".
 */

const placements = (count: number, folded: number[]) =>
  layoutColumns(count, folded).map((c) => c.placement);

describe("where a folded column sits", () => {
  it("leaves every column open, in place, with nothing folded", () => {
    expect(placements(4, [])).toEqual(["open", "open", "open", "open"]);
  });

  it("tucks the rightmost column to the edge when it is folded", () => {
    expect(placements(4, [3])).toEqual(["open", "open", "open", "edge"]);
  });

  it("stacks a run of folded columns at the right end on the edge", () => {
    expect(placements(5, [3, 4])).toEqual(["open", "open", "open", "edge", "edge"]);
  });

  it("keeps a folded middle column in its place", () => {
    expect(placements(4, [1])).toEqual(["open", "inline", "open", "open"]);
  });

  it("keeps a folded first column in its place — the left end is not the right edge", () => {
    expect(placements(4, [0])).toEqual(["inline", "open", "open", "open"]);
  });

  it("only the contiguous run at the right end goes to the edge", () => {
    // Folded 1 is separated from the end run by open 2.
    expect(placements(5, [1, 3, 4])).toEqual(["open", "inline", "open", "edge", "edge"]);
  });

  it("an open column at the very end keeps every folded column inline", () => {
    expect(placements(4, [1, 2])).toEqual(["open", "inline", "inline", "open"]);
  });

  it("folding every column puts them all on the edge", () => {
    expect(placements(3, [0, 1, 2])).toEqual(["edge", "edge", "edge"]);
  });

  it("returns columns in board order with their index", () => {
    expect(layoutColumns(3, [2]).map((c) => c.index)).toEqual([0, 1, 2]);
    expect(layoutColumns(3, [2]).map((c) => c.folded)).toEqual([false, false, true]);
  });

  it("ignores indices that are not a column", () => {
    expect(placements(3, [-1, 3, 7, 1.5])).toEqual(["open", "open", "open"]);
    expect(layoutColumns(0, [0])).toEqual([]);
  });
});

describe("reading the saved folded set", () => {
  it("keeps stage ids, in the order saved, once each", () => {
    expect(parseFoldedStages('["s3","s1","s3"]')).toEqual(["s3", "s1"]);
  });

  it("drops anything that is not a stage id", () => {
    expect(parseFoldedStages('["s1",7,null,"",{"id":"s2"}]')).toEqual(["s1"]);
  });

  it("reads anything that is not a list as nothing folded", () => {
    expect(parseFoldedStages(null)).toEqual([]);
    expect(parseFoldedStages("")).toEqual([]);
    expect(parseFoldedStages("not json")).toEqual([]);
    expect(parseFoldedStages('{"s1":true}')).toEqual([]);
  });
});

describe("toggling a stage", () => {
  it("folds a stage that is open and unfolds one that is folded", () => {
    expect(toggleFolded([], "s2")).toEqual(["s2"]);
    expect(toggleFolded(["s1", "s2"], "s2")).toEqual(["s1"]);
  });

  it("leaves other pipelines' folded stages alone", () => {
    // Stage ids from a different pipeline ride along untouched.
    expect(toggleFolded(["other-1"], "s2")).toEqual(["other-1", "s2"]);
  });

  it("never mutates the saved list", () => {
    const saved = ["s1"];
    toggleFolded(saved, "s1");
    expect(saved).toEqual(["s1"]);
  });
});

/**
 * The Active Clients health board folds its four bands with this same hook,
 * under its own scope -- Mark, overruling the session-only fold it shipped
 * with: "keep the client 360 panel, make everything else match".
 *
 * What is stored is the band key, not a stage id, which is the whole reason
 * the two boards cannot share one row.
 */
const BANDS = ["healthy", "monitoring", "at_risk", "critical"];

describe("the health board's folded bands", () => {
  it("keeps its own row, never the pipeline's", () => {
    expect(ACTIVE_CLIENTS_FOLD_SCOPE).not.toBe(PIPELINE_FOLD_SCOPE);
    expect(ACTIVE_CLIENTS_FOLD_SCOPE).toBeTruthy();
  });

  it("round-trips a set of band keys", () => {
    expect(parseFoldedStages(JSON.stringify(["healthy", "critical"]))).toEqual([
      "healthy",
      "critical",
    ]);
  });

  it("reads an unset, empty or hand-edited row as nothing folded", () => {
    // A stored preference is free text in user_view_prefs. A board that cannot
    // read its row shows every band, which is the state it shipped in.
    for (const bad of [null, undefined, "", "not json", "{}", '"healthy"', "[1,2]", "[null]"]) {
      expect(parseFoldedStages(bad as string | null | undefined)).toEqual([]);
    }
  });

  it("folds and unfolds one band at a time", () => {
    let saved: string[] = [];
    for (const band of BANDS) saved = toggleFolded(saved, band);
    expect(saved).toEqual(BANDS);
    expect(toggleFolded(saved, "at_risk")).toEqual(["healthy", "monitoring", "critical"]);
  });

  it("never folds the same band twice", () => {
    // Two clicks land as fold then unfold, never as a duplicate entry.
    expect(toggleFolded(["healthy"], "healthy")).toEqual([]);
    expect(parseFoldedStages('["healthy","healthy"]')).toEqual(["healthy"]);
  });
});
