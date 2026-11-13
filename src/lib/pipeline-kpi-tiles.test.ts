import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Mark, 10 Sep 2026, on the pipeline stat strip: "qty of leads in piepline
 * instead of new leads,"
 *
 * The second tile counted leads created in the last seven days. On a board of
 * hundreds that reads "1" most weeks, so the strip spent a fifth of its width
 * on a number nobody could act on. It now counts the cards the board is
 * drawing, which is the number a rep would reach by counting the columns.
 *
 * Two things here are easy to undo by accident, so both are pinned: the tile
 * has to count off `boardCards` (the board's own set, cross-office cards
 * included) rather than `openCards` (full-access only), and Open Pipeline has
 * to stop footing with that same count or the strip prints one number twice.
 *
 * This repo carries no DOM testing library, so the assertion reads the source
 * — the precedent is src/components/qty-takes-a-sum.test.ts. Every check pulls
 * out the one fragment it cares about first, so the prose above a line of code
 * can neither satisfy nor break it.
 */
const source = readFileSync(
  new URL("../routes/_authenticated/pipeline.index.tsx", import.meta.url),
  "utf8",
);

/** The one `<KpiTile ... />` element carrying the given `label=`. */
function tile(label: string): string {
  const tiles = (source.match(/<KpiTile[\s\S]*?\/>/g) ?? []).filter((t) =>
    t.includes(`label="${label}"`),
  );
  expect(tiles.length, `expected exactly one "${label}" tile`).toBe(1);
  return tiles[0]!;
}

/**
 * The right-hand side of a top-level `const <name> = ... ;` inside the route.
 * Checked out on Windows the file arrives with CRLF endings, hence the CR.
 */
function declaration(name: string): string {
  const match = source.match(new RegExp(String.raw`\r?\n  const ${name} =([\s\S]*?);\r?\n`));
  if (!match) throw new Error(`no declaration for ${name}`);
  return match[1]!;
}

describe("the pipeline stat strip counts the leads in the pipeline", () => {
  it("no longer offers a New Leads tile", () => {
    expect(source).not.toContain('label="New Leads"');
  });

  it("shows the quantity of leads in the pipeline", () => {
    const t = tile("Leads in Pipeline");
    expect(t).toContain("value={String(leadsInPipeline.length)}");
    // Same shape as the tile it replaces: big number, label, sub-line, icon.
    expect(t).toContain("icon={Users}");
    expect(t).toMatch(/foot=\{/);
  });

  it("counts the board's own cards, so cross-office leads are not dropped", () => {
    // `openCards` is full_access only. Counting off it would make the tile
    // disagree with the columns underneath it whenever the scope is "All".
    const decl = declaration("leadsInPipeline");
    expect(decl).toContain("boardCards.filter");
    expect(decl).not.toContain("openCards");
  });

  it("leaves the lost column out of the count", () => {
    expect(declaration("leadsInPipeline")).toContain("!lostIds.has(c.stage_id)");
  });

  it("draws the sub-line from data the page already fetched", () => {
    // `rotDays` and `ruleWarning` are already loaded for the card wash, so the
    // sub-line costs no extra round trip. A fresh query here would.
    expect(declaration("coldLeads")).toContain("isRotting(c, rotDays, ruleWarning)");
    expect(tile("Leads in Pipeline")).toContain("coldLeads");
  });

  it("stops printing the same count twice by footing Open Pipeline with the average deal", () => {
    const t = tile("Open Pipeline");
    expect(t).not.toContain("openCards.length");
    expect(t).toContain("Avg deal ${compactMoney(avgDeal)}");
  });
});
