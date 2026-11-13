import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * Mark's six activity goal metrics (16 Sep 2026): "add fires chased, cold
 * leak converted, cold calls, new deals worked on, active client reach out
 * (... messaging, emails, texts, calls, etc), cold email outreach".
 *
 * The counting rules themselves are SQL and are proven by
 * supabase/tests/goal-activity-actuals.pglite.mjs against the real migration.
 * What this file guards is the TypeScript side of the same feature: the
 * catalogue carries all six as counts, every screen reads the actual off the
 * standings row through one map (and reads "unmeasured", not zero, when the
 * column is not there yet), Team Goals folds them into progress and saves
 * them, and the three screens actually render them.
 */

const mocks = vi.hoisted(() => ({
  standings: [] as Record<string, unknown>[],
  goals: [] as Record<string, unknown>[],
  saved: [] as Record<string, unknown>[],
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/notifications.functions", () => ({ notifyUsers: vi.fn(async () => undefined) }));
vi.mock("@/lib/leaderboard", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/leaderboard")>();
  return { ...real, fetchStandings: vi.fn(async () => mocks.standings) };
});
vi.mock("@/lib/goals", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/goals")>();
  return {
    ...real,
    fetchGoals: vi.fn(async () => mocks.goals),
    saveGoal: vi.fn(async (input: Record<string, unknown>) => {
      mocks.saved.push(input);
    }),
    saveAnnualGoal: vi.fn(async () => "parent"),
  };
});

import {
  ACTIVITY_METRICS,
  GOAL_METRICS,
  GOAL_METRIC_LIST,
  attainmentFor,
  type Goal,
} from "./goals";
import { activityOf, rankStandings, type Standing } from "./leaderboard";
import { TEAM_ACTIVITY_METRICS, fetchTeamGoals, saveTeamGoals } from "./team-goals";
import type { PersonMetrics } from "./scorecard";

const SIX = [
  "cold_calls",
  "cold_emails",
  "new_deals_worked",
  "cold_leads_converted",
  "active_client_reach_outs",
  "fires_chased",
] as const;

const goal = (metric: Goal["metric"], target: number, user = "rep-1"): Goal => ({
  id: `g-${metric}`,
  subject_user_id: user,
  subject_location_id: null,
  location_id: "loc-1",
  metric,
  target_value: target,
  period_type: "month",
  starts_on: "2026-09-01",
  ends_on: "2026-09-30",
  is_active: true,
  notes: null,
  set_by: null,
  why: null,
  parent_goal_id: null,
});

/** A standings row as the database returns it AFTER 20260916130100. */
const standing = (over: Partial<Standing> = {}): Standing => ({
  user_id: "rep-1",
  full_name: "Test Sales Rep CA",
  roles: ["sales_person"],
  location_ids: ["loc-1"],
  touchpoints: 0,
  meetings_held: 0,
  accounts_advanced: 0,
  accounts_owned: 0,
  new_accounts: 0,
  cadence_health: null,
  jobs_won: 0,
  billed_value: 0,
  collected_value: 0,
  incidents_dispatched: 0,
  incidents_accepted: 3,
  contracts_signed: 0,
  chase_acceptance: null,
  median_tta_minutes: null,
  activity_events: 0,
  money_visible: true,
  calls_made: 8,
  stage_advances: 0,
  jobs_signed_insurance: 0,
  jobs_signed_cash: 0,
  jobs_signed_total: 0,
  cold_calls: 5,
  cold_emails: 1,
  new_deals_worked: 2,
  cold_leads_converted: 1,
  active_client_reach_outs: 4,
  fires_chased: 3,
  ...over,
});

/** The same row from a database the migration has not reached: no such columns. */
const legacyStanding = (): Standing => {
  const s = standing() as unknown as Record<string, unknown>;
  for (const m of SIX) delete s[m];
  return s as unknown as Standing;
};

describe("the catalog", () => {
  it("carries all six of Mark's metrics as higher-is-better counts", () => {
    expect([...ACTIVITY_METRICS].sort()).toEqual([...SIX].sort());
    for (const m of SIX) {
      const def = GOAL_METRICS[m];
      expect(def.key).toBe(m);
      expect(def.unit).toBe("count");
      expect(def.direction).toBe("higher");
      expect(def.label.length).toBeGreaterThan(3);
      expect(def.format(12)).toBe("12");
    }
    expect(GOAL_METRIC_LIST.map((d) => d.key)).toEqual(expect.arrayContaining([...SIX]));
  });

  it("labels them in Mark's words", () => {
    expect(GOAL_METRICS.fires_chased.label).toBe("Fires chased");
    expect(GOAL_METRICS.cold_leads_converted.label).toBe("Cold leads converted");
    expect(GOAL_METRICS.cold_calls.label).toBe("Cold calls");
    expect(GOAL_METRICS.new_deals_worked.label).toBe("New deals worked on");
    expect(GOAL_METRICS.active_client_reach_outs.label).toBe("Active client reach-outs");
    expect(GOAL_METRICS.cold_emails.label).toBe("Cold email outreach");
  });

  it("orders the Set Goals fields prospecting first, then the client one, then fires", () => {
    expect(TEAM_ACTIVITY_METRICS).toEqual([
      "cold_calls",
      "cold_emails",
      "new_deals_worked",
      "cold_leads_converted",
      "active_client_reach_outs",
      "fires_chased",
    ]);
  });
});

describe("the actual, read off the standings row", () => {
  it("rankStandings gives every activity goal its actual and ratio", () => {
    const goals = [
      goal("cold_calls", 10),
      goal("active_client_reach_outs", 8),
      goal("fires_chased", 3),
    ];
    const [r] = rankStandings([standing()], goals);
    const by = Object.fromEntries(r!.lines.map((l) => [l.metric, l]));
    expect(by.cold_calls).toMatchObject({ actual: 5, target: 10, ratio: 0.5 });
    expect(by.active_client_reach_outs).toMatchObject({ actual: 4, target: 8, ratio: 0.5 });
    expect(by.fires_chased).toMatchObject({ actual: 3, target: 3, ratio: 1 });
    expect(r!.attainment).toBeCloseTo((0.5 + 0.5 + 1) / 3);
  });

  it("reads 'unmeasured' — null, never zero — before the migration lands", () => {
    const [r] = rankStandings([legacyStanding()], [goal("cold_calls", 10), goal("jobs_won", 4)]);
    const cold = r!.lines.find((l) => l.metric === "cold_calls")!;
    expect(cold.actual).toBeNull();
    expect(cold.ratio).toBeNull();
    // The unmeasured line is left out of the average instead of dragging it
    // to zero: jobs_won 0/4 is the only scored line.
    expect(r!.attainment).toBe(0);
    expect(activityOf(legacyStanding())).toEqual({
      cold_calls: null,
      cold_emails: null,
      new_deals_worked: null,
      cold_leads_converted: null,
      active_client_reach_outs: null,
      fires_chased: null,
    });
  });

  it("attainmentFor takes the six from the activity extras and nothing else", () => {
    const m = { meetings_held: 2, accounts_advanced: 4, jobs_won: 1 } as PersonMetrics;
    const goals = [goal("cold_emails", 4), goal("new_deals_worked", 2)];

    const withActivity = attainmentFor(goals, m, {
      newAccounts: 0,
      activity: activityOf(standing()),
    });
    expect(withActivity.lines.map((l) => [l.def.key, l.actual, l.ratio])).toEqual([
      ["cold_emails", 1, 0.25],
      ["new_deals_worked", 2, 1],
    ]);

    // A caller that fetched no standings row (the coaching pack before its
    // read, say) gets no attainment for these — not a zero.
    const without = attainmentFor(goals, m, { newAccounts: 0 });
    expect(without.lines.every((l) => l.actual === null && l.ratio === null)).toBe(true);
    expect(without.pct).toBeNull();
  });
});

describe("Team Goals", () => {
  it("folds the activity goals into each rep's progress and row", async () => {
    mocks.standings = [standing()];
    mocks.goals = [goal("jobs_won", 2), goal("cold_calls", 10), goal("fires_chased", 6)];

    const data = await fetchTeamGoals("month", null);
    const row = data.rows[0]!;
    expect(row.activity.cold_calls).toEqual({ actual: 5, target: 10, ratio: 0.5 });
    expect(row.activity.fires_chased).toEqual({ actual: 3, target: 6, ratio: 0.5 });
    // No target = no ratio, and it stays out of the mean.
    expect(row.activity.cold_emails).toEqual({ actual: 1, target: null, ratio: null });
    // jobs 0/2, cold calls 5/10, fires 3/6.
    expect(row.progress).toBeCloseTo((0 + 0.5 + 0.5) / 3);
    expect(row.goals.cold_calls?.id).toBe("g-cold_calls");
  });

  it("saves one goal row per activity field the manager filled in, and skips the blanks", async () => {
    mocks.saved = [];
    await saveTeamGoals({
      userIds: ["rep-1"],
      period: "month",
      revenue: null,
      jobs: 24,
      conversion: null,
      activity: { cold_calls: 100, fires_chased: 10, cold_emails: null },
      startsOn: "2026-09-01",
      endsOn: "2026-09-30",
      locationFor: () => "loc-1",
      setBy: "mgr-1",
      existing: new Map([["rep-1", { cold_calls: goal("cold_calls", 40) }]]),
    });
    const byMetric = Object.fromEntries(mocks.saved.map((s) => [s.metric, s]));
    expect(Object.keys(byMetric).sort()).toEqual(["cold_calls", "fires_chased", "jobs_won"]);
    expect(byMetric.cold_calls).toMatchObject({ id: "g-cold_calls", target_value: 100 });
    expect(byMetric.fires_chased).toMatchObject({ id: undefined, target_value: 10 });
  });
});

describe("the screens", () => {
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

  it("the Set Goals panel renders one field per activity metric between Conversion and End Date", () => {
    const src = read("src/routes/_authenticated/team-goals.tsx");
    const between = src.slice(
      src.indexOf('<Field label="Conversion Goal (%)">'),
      src.indexOf('<Field label="End Date">'),
    );
    expect(between).toMatch(
      /TEAM_ACTIVITY_METRICS\.map\(\(m\) => \(\s*<Field key=\{m\} label=\{ACTIVITY_FIELD\[m\]\.label\}>/,
    );
    // Same input as the three fields above it.
    const field = /TEAM_ACTIVITY_METRICS\.map[\s\S]*?<\/Field>\s*\)\)\}/.exec(between)![0];
    expect(field).toContain("<Input");
    expect(field).toContain('inputMode="numeric"');
    expect(field).toContain("value={activity[m]}");
    // And every one of the six has a title and a placeholder, in the panel's
    // own "... Goal" style, so the map cannot render a blank field.
    const fields = /const ACTIVITY_FIELD[^=]*= \{([\s\S]*?)\};/.exec(src)![1]!;
    for (const m of SIX) {
      expect(fields).toMatch(
        new RegExp(`${m}: \\{ label: "[A-Z][^"]* Goal", placeholder: "\\d+" \\}`),
      );
    }
    // The save sends them through the `activity` bag.
    expect(src).toMatch(
      /activity: Object\.fromEntries\(\s*TEAM_ACTIVITY_METRICS\.map\(\(m\) => \[m, num\(activity\[m\]\)\]\)/,
    );
  });

  it("the Team Goals table shows the targeted activity goals as actual / target", () => {
    const src = read("src/routes/_authenticated/team-goals.tsx");
    const cell = /function ActivityCell[\s\S]*?\n\}\n/.exec(src)![0];
    expect(cell).toContain("row.activity[m].target != null");
    expect(cell).toContain("GOAL_METRICS[m].format(f.actual)} / {GOAL_METRICS[m].format(f.target)");
    expect(src).toContain("<ActivityCell row={r} />");
  });

  it("My Goals gives each targeted activity metric a tile off the same progress lines", () => {
    const src = read("src/routes/_authenticated/my-goals.tsx");
    // Whitespace-tolerant: Prettier decides where this expression wraps.
    expect(src).toMatch(
      /const activityLines = ACTIVITY_METRICS\.map\(\(m\) =>\s*progress\.lines\.find\(\(l\) => l\.metric === m\),?\s*\)/,
    );
    const tiles = /activityLines\.map\(\(l\) => \(\s*<MetricTile[\s\S]*?\/>\s*\)\)/.exec(src)![0];
    expect(tiles).toContain("label={GOAL_METRICS[l.metric].label}");
    expect(tiles).toContain("actual={l.actual}");
    expect(tiles).toContain("target={l.target}");
  });

  it("the rep diagnostic adds a Row per measured activity metric with its target", () => {
    const src = read("src/components/sales-director/rep-diagnostic.tsx");
    const rows =
      /const activityRows = ACTIVITY_METRICS\.filter\(\(m\) => rep\.activity\[m\] != null\)[\s\S]*?\}\)\);/.exec(
        src,
      )![0];
    expect(rows).toContain("target: rep.activity_target[m]");
    expect(src).toMatch(/activityRows\.map\(\(a\) => \(\s*<Row/);
  });
});
