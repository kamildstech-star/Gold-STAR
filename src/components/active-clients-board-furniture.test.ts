import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, with a screenshot of Active Clients taken after the sticky-header work
 * landed: "this view was supposed to mimick the pipeline".
 *
 * The colour, the freeze, the density control and the view switcher were
 * already across. What was still different was the board furniture -- the
 * column shell and the card anatomy -- and those differences are pinned here,
 * because each one is a line or two that a later change can drop without
 * anything failing.
 *
 * A later pass held three of these back with reasoned arguments -- a
 * session-only fold, no label pills, no rot wash -- and Mark overruled all
 * three in one line: "keep the client 360 panel, make everything else match".
 * So they are here now, and pinned, along with the card cosmetics that were
 * left at the client card's own values.
 *
 * What is still NOT here, so nobody adds it back by pattern-matching: a WIP
 * limit (a health band is computed from a clock, so there is no number to be
 * over), and the folded-end right-edge strip (fold any one of four bands and
 * the rest widen to fit the screen, so there is never a sideways scroll for a
 * strip to be tucked out of).
 */
const KANBAN = readFileSync("src/components/active-clients-kanban.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);
const CARD = readFileSync("src/components/active-clients-cards.tsx", "utf8").replace(/\r\n/g, "\n");

describe("the column header says what a pipeline header says", () => {
  it("prints the money total next to the count", () => {
    // Pipeline: "Active Outreach / $313K · 14". Same formatter, so the two
    // boards round and abbreviate identically.
    expect(KANBAN).toContain('import { compactMoney } from "@/components/pipeline-board"');
    const line = KANBAN.match(/\{money \? `\$\{compactMoney\([^)]*\)\} · ` : ""\}/);
    expect(line, "money · count header line not found").toBeTruthy();
  });

  it("sums the column from the same job value the cards print", () => {
    const total = KANBAN.match(/const total = rows\.reduce\([^;]*;/);
    expect(total, "column total not found").toBeTruthy();
    expect(total![0]).toContain("r.jobValue ?? 0");
  });

  it("hides the total from anyone who may not see money", () => {
    // The commission rule reaches the header as well as the card.
    const header = KANBAN.match(/\{money \?[^}]*compactMoney/);
    expect(header, "column total is not gated on `money`").toBeTruthy();
  });

  it("folds a band from a chevron in the header", () => {
    const collapse = KANBAN.match(/aria-label=\{`Collapse \$\{meta\.label\}`\}/);
    expect(collapse, "collapse control not found").toBeTruthy();
    expect(KANBAN).toContain("<ChevronRight");
  });

  it("folds to a strip that is still a drop target", () => {
    // A folded band you cannot drag onto is a band you have to unfold first.
    const strip = KANBAN.match(/"flex w-\[52px\] shrink-0 snap-start flex-col[^"]*"/);
    expect(strip, "folded strip class string not found").toBeTruthy();
    // Full height, as the pipeline's strip is now -- Mark: "when collapsed it
    // still needs to scroll down with you" -- and not itself sticky, because
    // dnd-kit locates a droppable by adding the scroll to a rect it measured
    // once, and a target that has stopped moving is off by that scroll.
    expect(strip![0]).not.toContain("self-start");
    expect(strip![0]).not.toContain("sticky");
    const folded = KANBAN.match(/if \(folded\) \{[\s\S]*?\n  \}/);
    expect(folded, "folded branch not found").toBeTruthy();
    expect(folded![0]).toContain("ref={setNodeRef}");
    expect(folded![0]).toContain("aria-expanded={false}");
  });

  it("sticks the folded strip's label to the top of the screen, as the pipeline does", () => {
    // The label block inside the button, not the button: the button fills the
    // strip so the tap works from anywhere down the page.
    const label = KANBAN.match(/"flex min-h-\[160px\] flex-col items-center[^"]*"/);
    expect(label, "folded strip label class string not found").toBeTruthy();
    expect(label![0]).toContain("md:sticky");
    expect(label![0]).toContain("md:top-0");
    const button = KANBAN.match(/"flex flex-1 flex-col items-stretch rounded-xl[^"]*"/);
    expect(button, "folded strip button class string not found").toBeTruthy();
    expect(button![0]).not.toContain("sticky");
  });

  it("remembers the fold per person, under this board's own scope", () => {
    // Mark: "make everything else match". The pipeline persists its folds, so
    // this one does -- same hook, its own row, so folding At Risk here never
    // folds a stage on the pipeline.
    const call = KANBAN.match(/useFoldedStages\([\s\S]{0,160}?\);/);
    expect(call, "useFoldedStages call not found").toBeTruthy();
    expect(call![0]).toContain("ACTIVE_CLIENTS_FOLD_SCOPE");
    // Role preview reads the real person's row and never writes to it.
    expect(call![0]).toContain("!writes.disabled");
    expect(KANBAN).not.toContain("React.useState<ReadonlySet<ClientHealthKey>>");
  });

  it("gives the one band a new client can land in the pipeline's add footer", () => {
    // A health band is computed, so "add a client to At Risk" is not a thing.
    // A client created today is Healthy every time, so Healthy -- and only
    // Healthy -- gets the footer.
    const footer = KANBAN.match(/\{onAddClient \?[\s\S]*?\) : null\}/);
    expect(footer, "add footer not found").toBeTruthy();
    expect(footer![0]).toContain("Add Client");
    const wiring = KANBAN.match(/onAddClient=\{[\s\S]*?\)\s*: null\s*\}/);
    expect(wiring, "add footer wiring not found").toBeTruthy();
    expect(wiring![0]).toContain('k === "healthy"');
    expect(wiring![0]).toContain("!writes.disabled");
    expect(wiring![0]).toContain("/accounts/new");
  });
});

describe("the card carries what a pipeline card carries", () => {
  it("names the person who owns the account", () => {
    // The pipeline card has had a rep avatar and name since it shipped.
    expect(CARD).toContain("<OwnerAvatar name={row.assignedRepName} />");
    expect(CARD).toContain('row.assignedRepName ?? "Unassigned"');
  });

  it("keeps the owner at every density", () => {
    // Compact drops everything that is not who, how healthy and how much --
    // the same call the pipeline's compact card makes.
    const owner = CARD.match(/\{\/\* Owner\.[\s\S]*?<OwnerAvatar[\s\S]*?<\/div>/);
    expect(owner, "owner row not found").toBeTruthy();
    expect(owner![0]).not.toContain("minimal");
    expect(owner![0]).not.toContain("hidden");
  });

  it("reads the next milestone the way a pipeline card reads its next activity", () => {
    expect(CARD).toContain('import { dueLabel } from "@/components/pipeline-board"');
    const tone = CARD.match(/const dueTone =[\s\S]*?;\n/);
    expect(tone, "due tone not found").toBeTruthy();
    expect(tone![0]).toContain("var(--destructive)");
    expect(tone![0]).toContain("var(--warning)");
  });

  it("shows the lateness on the column card and on the full card", () => {
    // Two densities draw two different footers; both have to say it.
    const uses = [...CARD.matchAll(/className=\{cn\("shrink-0 tabular-nums", dueTone\)\}/g)];
    expect(uses.length, "lateness is missing from one of the card footers").toBe(2);
  });

  it("wears the pipeline card's radius and its name color", () => {
    // Two boards whose cards sit at different radii, with the name blue on one
    // and navy on the other, do not read as the same board.
    const root = CARD.match(/"rounded-\[10px\] border border-\[var\(--border\)\] bg-card[^"]*"/);
    expect(root, "card root class string not found").toBeTruthy();
    // The name was the only blue thing on a card of navy lines. It is still a
    // link and still underlines on hover; only the colour moved.
    expect(CARD).not.toContain('style={{ color: "var(--primary)" }}');
    expect(CARD).toContain("block truncate font-semibold hover:underline");
  });

  it("washes a card whose milestone is late, off the clock it already reads", () => {
    // The pipeline's rot wash. Driven by `dueLabel`, so the wash, the red
    // "12d late" and the column's ranking can never disagree -- and at compact
    // density, where the lateness is one of the lines dropped, it is the only
    // thing left saying so.
    const overdue = CARD.match(/const overdue = [^;]*;/);
    expect(overdue, "overdue signal not found").toBeTruthy();
    expect(overdue![0]).toContain('due.tone === "late"');
    expect(CARD).toContain('overdue && "rot-card"');
  });

  it("prints the account's labels where the pipeline card prints them", () => {
    // Under the chips, above the owner, and only at the densities that keep
    // more than name/health/money/owner.
    expect(CARD).toContain('import { fetchLabelMap, type Label } from "@/lib/labels"');
    expect(CARD).toContain("<CardLabels id={row.accountId} />");
    const gate = CARD.match(/\{minimal \? null : <CardLabels[^}]*\}/);
    expect(gate, "label row is not gated on density").toBeTruthy();
    // A card with no labels draws no row at all -- LabelPills would print a
    // bare em dash, which on a card is a line of nothing.
    const empty = CARD.match(/function CardLabels[\s\S]*?LabelPills[^;]*;/);
    expect(empty![0]).toContain("if (list.length === 0) return null;");
  });

  it("fetches those labels once for the board, off the critical path", () => {
    // One query for every card on screen, keyed on the sorted ids so that
    // re-ranking a column is not a fresh fetch of the same accounts.
    const q = KANBAN.match(/<ClientLabelsProvider ids=\{labelIds\}>/);
    expect(q, "board is not wrapped in the label provider").toBeTruthy();
    const provider = CARD.match(
      /export function ClientLabelsProvider[\s\S]*?LabelMapContext.Provider/,
    );
    expect(provider, "ClientLabelsProvider not found").toBeTruthy();
    expect(provider![0]).toContain("enabled: key.length > 0");
    expect(provider![0]).toContain("[...ids].sort()");
  });

  it("does not print a flat date twice on the full card", () => {
    const full = CARD.match(/\{fmtDate\(row\.nextMilestone\.due\)\}[\s\S]{0,400}?<\/div>/);
    expect(full, "full-density milestone date not found").toBeTruthy();
    expect(full![0]).toContain('due.tone !== "flat"');
  });
});

/**
 * Mark, 17 September, with a screenshot of a "Watch" chip sitting over
 * "Relationship · Watch · Compliance · Healthy": "watch is mentioned twice".
 *
 * The chip was the worse of the two tracks, so whenever the tracks line drew,
 * one of its words was the chip's word again. The line is the one that says
 * which job fixes it and colours each word with its band, so the line stays
 * and the chip yields to it. The chip still carries the whole story where the
 * line is not drawn -- compact density, and an account whose type runs no
 * clock -- so the card says health exactly once at every density, and
 * compliance once, in the line.
 *
 * The two conditions are pinned as each other's complement, because that is
 * the whole guarantee: one of them, never both, never neither.
 */
describe("health is said once on the card", () => {
  const chip = () => {
    const m = CARD.match(
      /\{(minimal \|\| row\.healthTracks\.length === 0) \? \(\s*<Chip bg=\{health\.soft\}/,
    );
    expect(m, "the headline health chip is no longer gated").toBeTruthy();
    return m![1]!;
  };
  const line = () => {
    const m = CARD.match(
      /\{(!minimal && row\.healthTracks\.length > 0) \? \(\s*<div className="mt-1\.5 flex flex-wrap/,
    );
    expect(m, "the tracks line is no longer gated").toBeTruthy();
    return m![1]!;
  };

  it("draws the chip exactly when the tracks line is not drawn", () => {
    expect(chip()).toBe("minimal || row.healthTracks.length === 0");
    expect(line()).toBe("!minimal && row.healthTracks.length > 0");
  });

  it("keeps the chip at compact density, where the line is dropped", () => {
    // Compact is name, health, money and owner: the chip IS the health there.
    expect(chip()).toContain("minimal");
    expect(line()).toContain("!minimal");
  });

  it("keeps the chip for an account whose type runs no clock", () => {
    // A homeowner has no tracks (`computeHealthTracks` returns none), so the
    // line would be empty and the chip is what carries the reason's colour.
    expect(chip()).toContain("row.healthTracks.length === 0");
    expect(line()).toContain("row.healthTracks.length > 0");
  });

  it("still names both tracks, each with its own band, in the line", () => {
    const track = CARD.match(/row\.healthTracks\.map\(\(t\) => \([\s\S]*?\)\)\}/);
    expect(track, "tracks line body not found").toBeTruthy();
    expect(track![0]).toContain("{t.label}");
    expect(track![0]).toContain("{HEALTH_META[t.health].label}");
  });
});
