import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { topBriefItems, type BriefItem, type BriefSection } from "./morning-brief";

const item = (id: string, severity: BriefItem["severity"]): BriefItem => ({
  id,
  title: id,
  detail: "",
  severity,
  action: { kind: "open", href: `/accounts/${id}`, label: "Open" },
});

const section = (key: BriefSection["key"], items: BriefItem[]): BriefSection => ({
  key,
  title: key,
  items,
});

describe("the rows the tile shows", () => {
  it("picks the most urgent rows across every section, not the first rows of the first", () => {
    const sections = [
      section("needs_you", [
        item("stalled-a", "warn"),
        item("stalled-b", "warn"),
        item("stalled-c", "warn"),
        item("unclaimed", "danger"),
      ]),
      section("off_pace", [item("rep", "warn")]),
      section("slipping", [item("no-touch", "danger"), item("annual", "warn")]),
    ];

    expect(topBriefItems(sections, 3).map((r) => r.id)).toEqual([
      "unclaimed",
      "no-touch",
      "stalled-a",
    ]);
  });

  it("breaks ties by the section a manager reads first, then by the section's own order", () => {
    const sections = [
      section("slipping", [item("slip-1", "warn"), item("slip-2", "warn")]),
      section("needs_you", [item("need-1", "warn"), item("need-2", "warn")]),
      section("off_pace", [item("pace-1", "warn")]),
    ];

    expect(topBriefItems(sections, 5).map((r) => r.id)).toEqual([
      "need-1",
      "need-2",
      "pace-1",
      "slip-1",
      "slip-2",
    ]);
  });

  it("carries the section key so a row can say where it came from", () => {
    const [row] = topBriefItems([section("off_pace", [item("rep", "danger")])], 1);
    expect(row.section).toBe("off_pace");
  });

  it("never returns more than asked, and nothing for an empty brief", () => {
    const sections = [section("needs_you", [item("a", "info"), item("b", "info")])];
    expect(topBriefItems(sections, 1)).toHaveLength(1);
    expect(topBriefItems(sections, 0)).toEqual([]);
    expect(topBriefItems([], 3)).toEqual([]);
  });
});

// ---- What the brief counts ---------------------------------------------------

import {
  buildMorningBrief,
  isRealAccount,
  type BriefAccountRow,
  type BriefInput,
} from "./morning-brief";
import type { Ranked } from "./leaderboard";

const NOW = Date.parse("2026-09-08T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const account = (
  over: Partial<BriefAccountRow> & { id: string; name: string },
): BriefAccountRow => ({
  stage: "conversation_established",
  stage_id: "stage-conversation",
  assigned_rep: "rep-real",
  stage_changed_at: daysAgo(5),
  created_at: daysAgo(60),
  approval_state: null,
  approval_due_on: null,
  annual_meeting_due_on: null,
  location_id: "loc-il",
  is_demo: false,
  is_reference: false,
  ...over,
});

const ranked = (userId: string, name: string, attainment: number): Ranked => ({
  standing: { user_id: userId } as Ranked["standing"],
  motion: "relationship" as Ranked["motion"],
  name,
  attainment,
  lines: [],
  headline: null,
});

const empty: BriefInput = {
  accounts: [],
  stageWindows: [],
  overdueTasks: [],
  profiles: [
    { user_id: "rep-real", full_name: "Dana Real", is_demo: false },
    { user_id: "rep-demo", full_name: "Renata Demo", is_demo: true },
  ],
  pendingExpenseCount: 0,
  requestedSupplyCount: 0,
  history: [],
  touchedAccountIds: [],
  // Every real account below has a decision-maker, so Coverage gaps stays quiet
  // and the assertions are about the rows under test.
  contacts: [
    { account_id: "real", is_decision_maker: true },
    { account_id: "real-lead", is_decision_maker: true },
  ],
  ranked: [],
  elapsed: 0.25,
};

/** The national carriers exactly as the 10 Aug migration seeded them, 29 days before NOW. */
const carrier = (name: string) =>
  account({
    id: `carrier-${name}`,
    name,
    stage: "reference",
    stage_id: null,
    assigned_rep: null,
    stage_changed_at: daysAgo(29),
    is_reference: true,
  });

describe("what the brief counts", () => {
  it("does not count shared reference records as stalled deals", () => {
    const carriers = ["Liberty Mutual", "USAA", "Farmers", "Nationwide", "The Hartford", "Amica"];
    const brief = buildMorningBrief(
      {
        ...empty,
        accounts: [
          ...carriers.map(carrier),
          account({ id: "real", name: "Palisade PM", stage_changed_at: daysAgo(29) }),
        ],
      },
      NOW,
    );

    const needs = brief.sections.find((s) => s.key === "needs_you");
    expect(needs?.items.map((i) => i.title)).toEqual(["Palisade PM"]);
    expect(needs?.items[0].detail).toBe("29d in stage, window is 21d · Dana Real");
    expect(brief.total).toBe(1);
  });

  it("treats a reference account as fixture even if the flag arrives without the stage", () => {
    expect(isRealAccount(account({ id: "a", name: "A", is_reference: true }))).toBe(false);
    expect(isRealAccount(account({ id: "b", name: "B", stage: "reference" }))).toBe(false);
    expect(isRealAccount(account({ id: "c", name: "C", is_demo: true }))).toBe(false);
    expect(isRealAccount(account({ id: "d", name: "D" }))).toBe(true);
  });

  it("leaves demo accounts, demo tasks and demo people out of every section", () => {
    const brief = buildMorningBrief(
      {
        ...empty,
        accounts: [
          account({
            id: "demo-lead",
            name: "Bregman & Associates",
            stage: "leads",
            assigned_rep: null,
            created_at: daysAgo(3),
            is_demo: true,
          }),
          account({
            id: "demo-client",
            name: "Lakeview Commercial",
            stage: "active_client",
            is_demo: true,
          }),
          account({
            id: "real-lead",
            name: "Ridge Property Group",
            stage: "leads",
            assigned_rep: null,
            created_at: daysAgo(3),
          }),
        ],
        overdueTasks: [
          {
            id: "t1",
            title: "Demo next activity",
            assignee: "rep-real",
            due_date: "2026-09-01",
            account_id: "demo-lead",
            is_demo: true,
          },
          {
            id: "t2",
            title: "Quarterly touch",
            assignee: "rep-demo",
            due_date: "2026-09-01",
            account_id: null,
            is_demo: false,
          },
          {
            id: "t3",
            title: "Call back",
            assignee: "rep-real",
            due_date: "2026-09-01",
            account_id: "real-lead",
            is_demo: false,
          },
        ],
        ranked: [ranked("rep-demo", "Renata Demo", 0), ranked("rep-real", "Dana Real", 0)],
        history: [
          {
            id: "h1",
            account_id: "demo-client",
            to_stage: "active_client",
            reason: null,
            changed_at: daysAgo(0.5),
          },
        ],
      },
      NOW,
    );

    const titles = Object.fromEntries(
      brief.sections.map((s) => [s.key, s.items.map((i) => i.title)]),
    );
    expect(titles).toEqual({
      needs_you: ["Ridge Property Group", "Dana Real"],
      off_pace: ["Dana Real"],
    });
    const tasks = brief.sections.find((s) => s.key === "needs_you")?.items[1];
    expect(tasks?.detail).toBe("1 overdue task");
    expect(brief.total).toBe(3);
  });

  it("says plainly when nothing is left", () => {
    const brief = buildMorningBrief({ ...empty, accounts: [carrier("USAA")] }, NOW);
    expect(brief.sections).toEqual([]);
    expect(brief.total).toBe(0);
  });
});
