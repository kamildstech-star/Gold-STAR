import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "Create proposal" on a pipeline card. Mark: "Is there a way to make
 * something in the pipeline a proposal?"
 *
 * A static render of a card you may open needs a router for its <Link>, so —
 * as pipeline-board.snooze.test.ts does for the snooze — what the button is
 * made of is checked in the source, each check on its own fragment.
 */
const BOARD = readFileSync(new URL("./pipeline-board.tsx", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
const PAGE = readFileSync(
  new URL("../routes/_authenticated/pipeline.index.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const LAZY = readFileSync(
  new URL("./account-proposals/lazy-proposal-dialog.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function button(): string {
  const at = BOARD.indexOf("onCreateProposal && card.full_access");
  expect(at, "the card no longer draws a Create proposal button").toBeGreaterThan(-1);
  return BOARD.slice(BOARD.lastIndexOf("{", at), BOARD.indexOf("</button>", at));
}

describe("the card's Create proposal button", () => {
  it("is only on an open deal you may open, and not on the drag picture", () => {
    const b = button();
    expect(b).toMatch(/!won && !overlay && onCreateProposal && card\.full_access/);
  });

  it("neither opens the record nor starts a drag when pressed", () => {
    const b = button();
    expect(b).toContain("{...stopRowClick}");
    expect(b).toContain("e.stopPropagation()");
    expect(b).toContain("onCreateProposal(card)");
    expect(b).toContain("disabled={writesDisabled}");
  });

  it("has a name a screen reader can say", () => {
    expect(button()).toContain("aria-label={`Create proposal for ${card.name}`}");
  });

  it("reaches the kanban and the grid cards", () => {
    expect(BOARD.match(/onCreateProposal=\{props\.onCreateProposal\}/g)).toHaveLength(2);
  });
});

describe("the pipeline page", () => {
  it("opens the proposal dialog for the card's account, loaded on first use", () => {
    expect(PAGE).toContain("onCreateProposal={onCreateProposal}");
    expect(PAGE).toContain(
      'import { LazyAccountProposalDialog } from "@/components/account-proposals/lazy-proposal-dialog";',
    );
    expect(LAZY).toMatch(
      /lazy\(\(\) =>\s*import\("@\/components\/account-proposals\/proposal-dialog"\)/,
    );
    const dialog = PAGE.slice(PAGE.indexOf("<LazyAccountProposalDialog"));
    expect(dialog.slice(0, 400)).toContain("accountId={proposalFor.id}");
  });

  it("re-reads the board afterwards — the database moved the card", () => {
    const dialog = PAGE.slice(PAGE.indexOf("<LazyAccountProposalDialog"));
    expect(dialog.slice(0, 600)).toContain("cardsQuery.refetch()");
  });
});
