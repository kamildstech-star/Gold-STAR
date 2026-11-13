import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compareByUrgency, sortByUrgency, type UrgencyCard } from "./card-urgency";

/**
 * Mark: "rank by overdue tasks, closest due date, then age" — then "pipeline
 * as well". The comparator is the whole rule, so it is tested here on its own
 * terms; the two board tests below only prove each board actually calls it.
 */

const DAY = 86_400_000;
const now = Date.now();
const inDays = (n: number) => new Date(now + n * DAY).toISOString();

function card(id: string, over: Partial<UrgencyCard> = {}): UrgencyCard {
  return { id, ...over };
}

const order = (cards: UrgencyCard[]) => sortByUrgency(cards).map((c) => c.id);

describe("ranking the cards in a board column", () => {
  it("puts a card with a past-due task above one with nothing overdue", () => {
    expect(
      order([
        card("upcoming", { nextDueAt: inDays(3) }),
        card("overdue", { nextDueAt: inDays(-2) }),
      ]),
    ).toEqual(["overdue", "upcoming"]);
  });

  it("puts the more overdue card first", () => {
    expect(
      order([
        card("late-by-1", { nextDueAt: inDays(-1) }),
        card("late-by-30", { nextDueAt: inDays(-30) }),
        card("late-by-9", { nextDueAt: inDays(-9) }),
      ]),
    ).toEqual(["late-by-30", "late-by-9", "late-by-1"]);
  });

  it("puts the closest due date first among cards that are not late", () => {
    expect(
      order([
        card("next-month", { nextDueAt: inDays(30) }),
        card("tomorrow", { nextDueAt: inDays(1) }),
        card("next-week", { nextDueAt: inDays(7) }),
      ]),
    ).toEqual(["tomorrow", "next-week", "next-month"]);
  });

  it("sorts a card with no due date last, never first", () => {
    // The bug this guards: a null read as 0 or as the epoch, which would rank
    // a card that owes nothing above one that is a month past due.
    expect(
      order([
        card("nothing-owed", { nextDueAt: null, ageDays: 400 }),
        card("due-in-a-year", { nextDueAt: inDays(365) }),
        card("overdue", { nextDueAt: inDays(-1) }),
      ]),
    ).toEqual(["overdue", "due-in-a-year", "nothing-owed"]);
  });

  it("breaks a due-date tie with the oldest card first", () => {
    const due = inDays(2);
    expect(
      order([
        card("young", { nextDueAt: due, ageDays: 3 }),
        card("old", { nextDueAt: due, ageDays: 88 }),
        card("middling", { nextDueAt: due, ageDays: 40 }),
      ]),
    ).toEqual(["old", "middling", "young"]);
  });

  it("ranks cards that owe nothing against each other by age", () => {
    expect(
      order([
        card("fresh", { ageDays: 1 }),
        card("stale", { ageDays: 120 }),
        card("no-age", { ageDays: null }),
      ]),
    ).toEqual(["stale", "fresh", "no-age"]);
  });

  it("sorts an unknown age last at the age level too", () => {
    // Not as zero: an unknown age must not outrank a card that has sat a day.
    expect(order([card("unknown", { ageDays: null }), card("one-day", { ageDays: 0 })])).toEqual([
      "one-day",
      "unknown",
    ]);
  });

  it("is total and stable — equal cards keep one order across renders", () => {
    const cards = ["c", "a", "b"].map((id) => card(id, { nextDueAt: inDays(5), ageDays: 10 }));
    expect(order(cards)).toEqual(["a", "b", "c"]);
    // Same input in a different arrival order still lands the same way, which
    // is what stops the board twitching when a query re-fetches.
    expect(order([...cards].reverse())).toEqual(["a", "b", "c"]);
  });

  it("never claims two different cards are the same card", () => {
    const a = card("a", { nextDueAt: inDays(1) });
    const b = card("b", { nextDueAt: inDays(1) });
    expect(compareByUrgency(a, b)).toBeLessThan(0);
    expect(compareByUrgency(b, a)).toBeGreaterThan(0);
    expect(compareByUrgency(a, a)).toBe(0);
  });

  it("does not throw on missing or nonsense fields", () => {
    const cards: UrgencyCard[] = [
      { id: "bare" },
      { id: "junk-date", nextDueAt: "not a date" },
      { id: "undefined-age", ageDays: undefined },
      { id: "real", nextDueAt: inDays(-1), ageDays: 5 },
    ];
    expect(() => sortByUrgency(cards)).not.toThrow();
    expect(order(cards)[0]).toBe("real");
    expect(order(cards)).toHaveLength(4);
  });

  it("leaves the array it was given alone", () => {
    const cards = [card("b", { ageDays: 1 }), card("a", { ageDays: 9 })];
    sortByUrgency(cards);
    expect(cards.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

/* --------------------------------------------------- wired into the boards */

/**
 * There is no DOM testing library here, so each board is checked at the
 * source: pull out the grouping that builds a column's card list and assert
 * the ranking runs on it. The fragment is extracted first — asserting on the
 * whole file lets a comment satisfy the test.
 */

describe("the prospect board ranks each stage column", () => {
  const SOURCE = readFileSync("src/components/pipeline-board.tsx", "utf8");

  it("sorts the per-stage lists with the shared comparator", () => {
    const byStage = SOURCE.match(/const byStage = React\.useMemo\([\s\S]*?\}, \[stages, cards\]\)/);
    expect(byStage, "byStage grouping not found").toBeTruthy();
    expect(byStage![0]).toContain("compareByUrgency(urgencyOf(a), urgencyOf(b))");
    // The old order was newest-created first, and it is what this replaces.
    expect(byStage![0]).not.toContain("a.created_at < b.created_at");
  });

  it("feeds it the due date and the stage age the card already shows", () => {
    const map = SOURCE.match(/function urgencyOf\(card: OpportunityCard\)[\s\S]*?\n\}/);
    expect(map, "urgencyOf mapping not found").toBeTruthy();
    expect(map![0]).toContain("card.next_activity?.due_date");
    expect(map![0]).toContain("ageDays(card)");
  });
});

describe("the client health board ranks each health column", () => {
  const SOURCE = readFileSync("src/components/active-clients-kanban.tsx", "utf8");

  it("sorts the per-band lists with the shared comparator", () => {
    const byColumn = SOURCE.match(/const byColumn = React\.useMemo\([\s\S]*?\}, \[rows\]\)/);
    expect(byColumn, "byColumn grouping not found").toBeTruthy();
    expect(byColumn![0]).toContain("compareByUrgency(urgencyOf(a), urgencyOf(b))");
  });

  it("feeds it the next milestone and the touch clock", () => {
    const map = SOURCE.match(/function urgencyOf\(row: ActiveClientRow\)[\s\S]*?\n\}/);
    expect(map, "urgencyOf mapping not found").toBeTruthy();
    expect(map![0]).toContain("row.nextMilestone?.due");
    expect(map![0]).toContain("row.daysSinceTouch");
  });
});
