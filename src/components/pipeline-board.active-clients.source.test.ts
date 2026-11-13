import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, 2026-09-10, in three messages: "this needs to follow down too" (a
 * screenshot of the short tile beside tall columns), "what happened to be able
 * to click on the active clients to open it as a full size card and show all
 * the deals in there", and "and that size should be the collapsed view".
 *
 * Read together that is collapse/expand in place, not a link to another page,
 * and the expanded state has to be the board's own column rather than a second
 * card design that drifts away from it. A static render can prove the
 * collapsed default (pipeline-board.active-clients.render.test.tsx); it cannot
 * press the button, so what the other half of the branch is made of is checked
 * here, in the source.
 *
 * Every check below pulls out its own fragment first. Asserting on the whole
 * file lets a comment satisfy or break the assertion, which has caused three
 * false results in this repo already.
 */
const SOURCE = readFileSync(new URL("./pipeline-board.tsx", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);

/** The `expanded` branch of ActiveClientsTile, from the guard to its return. */
function expandedBranch(): string {
  const at = SOURCE.indexOf("if (expanded) {");
  expect(at, "ActiveClientsTile no longer branches on `expanded`").toBeGreaterThan(-1);
  const end = SOURCE.indexOf("\n  }", at);
  return SOURCE.slice(at, end);
}

describe("the Active Clients tile expands in place", () => {
  it("starts collapsed, with nothing remembering otherwise", () => {
    // Fold state persists per user through `user_view_prefs`; this must not.
    const declaration = SOURCE.match(/const \[activeClientsExpanded[^;]*;/);
    expect(declaration, "the expanded flag is gone or is no longer local state").not.toBeNull();
    expect(declaration![0]).toContain("useState(false)");
    expect(declaration![0]).not.toContain("user_view_prefs");
  });

  it("renders the board's own Column, with the clients as its cards", () => {
    const branch = expandedBranch();
    expect(branch).toMatch(/<Column\b/);
    expect(branch).toMatch(/cards=\{clients\}/);
    expect(branch).toMatch(/asActiveClients/);
  });

  it("keeps the expanded column a drop target by reusing the drop id", () => {
    // The synthesised stage IS the drop id, so `useDroppable({ id: stage.id })`
    // registers the expanded column without a second code path.
    const stage = SOURCE.match(/const ACTIVE_CLIENTS_STAGE: PipelineStage = \{[^}]*\}/)![0];
    expect(stage).toContain("id: ACTIVE_CLIENTS_DROP_ID");
    const droppable = SOURCE.match(/useDroppable\(\{ id: stage\.id[^}]*\}\)/);
    expect(droppable, "Column stopped registering its stage id as a drop target").not.toBeNull();
  });

  it("draws the clients with the board's own card, not a second design", () => {
    const cards = SOURCE.match(/asActiveClients \? \(\n\s*<BoardCard/);
    expect(cards, "the expanded column stopped using BoardCard").not.toBeNull();
  });

  it("carries aria-expanded on both controls", () => {
    // Collapsed: the tile's own button. Expanded: the column's collapse
    // chevron, which is the way back and the only control in that state.
    expect(SOURCE).toContain("aria-expanded={false}");
    expect(SOURCE).toContain("aria-expanded={asActiveClients ? true : undefined}");
  });

  it("no longer navigates anywhere on click", () => {
    // The click used to run `navigate({ to: "/farming" })` from the page. The
    // tile is the list now, so nothing on this board points away from it.
    expect(SOURCE).not.toContain("/farming");
    expect(SOURCE).not.toContain("onShowActiveClients");
    const handler = SOURCE.match(
      /const toggles = togglesActiveClients\([^;]*;\n[^;]*;\n[^;]*;/,
    )![0];
    expect(handler).toContain("onToggle()");
    expect(handler).not.toContain("navigate");
  });

  it("stretches to the tallest column instead of sizing to its own content", () => {
    const classes = SOURCE.match(/"flex w-\[112px\][^"]*"/)![0];
    expect(classes).toContain("self-stretch");
    expect(classes).not.toContain("self-start");
  });
});

describe("the pipeline page hands over the clients, not a count", () => {
  const PAGE = readFileSync(
    new URL("../routes/_authenticated/pipeline.index.tsx", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("derives the list from the same rule the board's own list is the complement of", () => {
    const memo = PAGE.match(/const activeClients = React\.useMemo\([\s\S]*?\n\s*\);/)![0];
    expect(memo).toContain("filtered.filter");
    expect(memo).toContain("!isProspectingBoardCard(card, boardStageIds)");
    // `boardCards` is the other half of the same partition, off the same set.
    const board = PAGE.match(/const boardCards = React\.useMemo\([\s\S]*?\n\s*\);/)![0];
    expect(board).toContain("filtered.filter");
    expect(board).toContain("isProspectingBoardCard(card, boardStageIds)");
  });

  it("has no separate count left to disagree with the list", () => {
    expect(PAGE).not.toContain("activeClientCount");
  });
});
