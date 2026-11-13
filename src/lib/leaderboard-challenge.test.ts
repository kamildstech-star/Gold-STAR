import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ACTION_BY_KEY, actionFor } from "./action-catalogue";
import type { Standing } from "./leaderboard";
import {
  challengeAggregate,
  challengeCountKeys,
  challengeLabel,
  challengeProgress,
  challengeRatio,
  challengeValue,
  challengeWindow,
  challengeWinnerRule,
  DEFAULT_CHALLENGE_METRIC,
  formatChallengeValue,
  LEGACY_METRICS,
  rankChallengeLines,
  targetField,
  targetFromInput,
  targetToInput,
} from "./leaderboard-challenge";

/**
 * Mark: "add the ability to add more metrics, custom to the user". The
 * challenge's Metric is now any catalogue key. These tests hold three things:
 * the old five keys still mean what they meant, any key scores through the
 * same two roads as points, and a metric's unit and direction decide how the
 * target reads and who wins.
 */

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

function standing(over: Partial<Standing>): Standing {
  return {
    user_id: "u1",
    full_name: "Rep",
    roles: ["sales_person"],
    location_ids: ["loc-1"],
    touchpoints: 41,
    meetings_held: 3,
    accounts_advanced: 9,
    accounts_owned: 30,
    new_accounts: 2,
    cadence_health: 0.8,
    jobs_won: 4,
    billed_value: 12000,
    collected_value: 8000,
    incidents_dispatched: 12,
    incidents_accepted: 9,
    contracts_signed: 3,
    chase_acceptance: 0.75,
    median_tta_minutes: 26,
    activity_events: 57,
    money_visible: true,
    calls_made: 150,
    stage_advances: 11,
    jobs_signed_insurance: 3,
    jobs_signed_cash: 1,
    jobs_signed_total: 4,
    cold_calls: null,
    cold_emails: null,
    new_deals_worked: null,
    cold_leads_converted: null,
    active_client_reach_outs: null,
    fires_chased: null,
    ...over,
  };
}

const CHALLENGE = {
  metric: "contracts_signed",
  target: 25,
  starts_at: "2026-09-14T00:00:00.000Z",
  ends_at: "2026-09-21T00:00:00.000Z",
};

describe("the five old dropdown values are catalog keys", () => {
  it("every legacy metric resolves, so no rename migration is needed", () => {
    for (const k of LEGACY_METRICS) expect(actionFor(k), k).not.toBeNull();
    expect(ACTION_BY_KEY.has(DEFAULT_CHALLENGE_METRIC)).toBe(true);
    // The seed migration's row uses the default key verbatim.
    const seed = src(
      "../../supabase/migrations/20260814073305_61d586ce-0b56-4969-99da-09a14ab93421.sql",
    );
    const insert = seed.match(
      /INSERT INTO public\.leaderboard_challenges[\s\S]*?VALUES\s*\(([^)]*)\)/,
    );
    expect(insert).not.toBeNull();
    expect(insert![1]).toContain(`'${DEFAULT_CHALLENGE_METRIC}'`);
  });

  it("the five read straight off the standings row and never need the RPC", () => {
    const s = standing({});
    expect(challengeValue(s, "contracts_signed")).toBe(3);
    expect(challengeValue(s, "incidents_accepted")).toBe(9);
    expect(challengeValue(s, "jobs_won")).toBe(4);
    expect(challengeValue(s, "meetings_held")).toBe(3);
    expect(challengeValue(s, "touchpoints")).toBe(41);
    for (const k of LEGACY_METRICS) expect(challengeCountKeys(k), k).toEqual([]);
  });

  it("labels come from the catalog, with a readable fallback for a stray key", () => {
    expect(challengeLabel("contracts_signed")).toBe(actionFor("contracts_signed")!.label);
    expect(challengeLabel("meetings_held")).toBe("Meetings held");
    expect(challengeLabel("no_such_thing")).toBe("no such thing");
  });
});

describe("any catalog key scores", () => {
  it("an RPC-only key asks for exactly that key and reads the counts row", () => {
    expect(actionFor("door_knocks")?.standing).toBeUndefined();
    expect(challengeCountKeys("door_knocks")).toEqual(["door_knocks"]);
    const s = standing({});
    expect(challengeValue(s, "door_knocks")).toBeNull();
    expect(challengeValue(s, "door_knocks", { door_knocks: 7 })).toBe(7);
  });

  it("without the RPC an RPC-only key is unmeasured, not zero", () => {
    const p = challengeProgress({ ...CHALLENGE, metric: "door_knocks" }, [standing({})], null);
    expect(p.measured).toBe(false);
    expect(p.team).toBeNull();
    expect(p.leaders).toEqual([]);
    expect(p.ratio).toBe(0);
  });

  it("the window is the challenge's own dates", () => {
    const w = challengeWindow(CHALLENGE);
    expect(w.from.toISOString()).toBe(CHALLENGE.starts_at);
    expect(w.to.toISOString()).toBe(CHALLENGE.ends_at);
  });

  it("counts add up across the team and the most wins", () => {
    const p = challengeProgress(CHALLENGE, [
      standing({ user_id: "a", full_name: "Ann", contracts_signed: 3 }),
      standing({ user_id: "b", full_name: "Bob", contracts_signed: 10 }),
      standing({ user_id: "c", full_name: "Cy", contracts_signed: 7 }),
    ]);
    expect(p.unit).toBe("count");
    expect(p.aggregate).toBe("sum");
    expect(p.team).toBe(20);
    expect(p.ratio).toBeCloseTo(0.8);
    expect(p.leaders.map((l) => l.name)).toEqual(["Bob", "Cy", "Ann"]);
  });
});

describe("unit and direction", () => {
  it("counts and money sum; rates and times average", () => {
    expect(challengeAggregate("count")).toBe("sum");
    expect(challengeAggregate("currency")).toBe("sum");
    expect(challengeAggregate("percent")).toBe("average");
    expect(challengeAggregate("minutes")).toBe("average");
  });

  it("a percent target typed as 25 is stored as 0.25 and reads back as 25%", () => {
    expect(targetFromInput(25, "percent")).toBe(0.25);
    expect(targetToInput(0.25, "percent")).toBe(25);
    expect(formatChallengeValue(0.25, "percent")).toBe("25%");
    expect(targetField("percent").suffix).toBe("%");
    // Everything else is stored as typed.
    expect(targetFromInput(25, "count")).toBe(25);
    expect(targetFromInput(2500, "currency")).toBe(2500);
    expect(targetToInput(30, "minutes")).toBe(30);
  });

  it("a currency target is dollars and formats as money", () => {
    expect(targetField("currency").prefix).toBe("$");
    expect(formatChallengeValue(12000, "currency")).toBe("$12,000");
    expect(formatChallengeValue(1234.6, "count")).toBe("1,235");
    expect(formatChallengeValue(26.4, "minutes")).toBe("26 min");
    expect(formatChallengeValue(null, "count")).toBe("—");
  });

  it("the catalog's own entries drive it: billed value is money, cadence is percent, TTA is lower-is-better", () => {
    expect(actionFor("billed_value")?.unit).toBe("currency");
    expect(actionFor("cadence_health")?.unit).toBe("percent");
    expect(actionFor("chase_tta")).toMatchObject({ unit: "minutes", direction: "lower" });
  });

  it("lower is better flips the ranking and the bar", () => {
    const lines = [
      { user_id: "a", name: "Ann", value: 40 },
      { user_id: "b", name: "Bob", value: 12 },
      { user_id: "c", name: "Cy", value: null },
      { user_id: "d", name: "Di", value: 25 },
    ];
    expect(rankChallengeLines(lines, "lower").map((l) => l.name)).toEqual(["Bob", "Di", "Ann"]);
    expect(rankChallengeLines(lines, "higher").map((l) => l.name)).toEqual(["Ann", "Di", "Bob"]);
    // Under target on a lower-is-better metric is "there".
    expect(challengeRatio(20, 30, "lower")).toBeCloseTo(1.5);
    expect(challengeRatio(60, 30, "lower")).toBeCloseTo(0.5);
    expect(challengeRatio(15, 30, "higher")).toBeCloseTo(0.5);
    expect(challengeRatio(null, 30, "higher")).toBe(0);
  });

  it("a time-to-arrival challenge averages the team and the fastest leads", () => {
    const p = challengeProgress({ ...CHALLENGE, metric: "chase_tta", target: 30 }, [
      standing({ user_id: "a", full_name: "Ann", median_tta_minutes: 40 }),
      standing({ user_id: "b", full_name: "Bob", median_tta_minutes: 20 }),
      standing({ user_id: "c", full_name: "Cy", median_tta_minutes: null }),
    ]);
    expect(p.direction).toBe("lower");
    expect(p.aggregate).toBe("average");
    expect(p.team).toBe(30);
    expect(p.ratio).toBeCloseTo(1);
    expect(p.leaders.map((l) => l.name)).toEqual(["Bob", "Ann"]);
  });

  it("the winner rule reads the direction and unit", () => {
    expect(challengeWinnerRule("contracts_signed")).toBe("Most contracts signed wins");
    expect(challengeWinnerRule("chase_tta")).toBe("Lowest time to arrival wins");
    expect(challengeWinnerRule("chase_acceptance")).toBe("Highest acceptance rate wins");
  });

  it("money withheld from the viewer is unmeasured, not a zero on the board", () => {
    const p = challengeProgress({ ...CHALLENGE, metric: "billed_value", target: 50000 }, [
      standing({ user_id: "a", full_name: "Ann", money_visible: false, billed_value: null }),
    ]);
    expect(p.measured).toBe(false);
    expect(p.leaders).toEqual([]);
  });
});

describe("the leaderboard wires it up", () => {
  const route = src("../routes/_authenticated/leaderboard.index.tsx");

  it("the dialog uses the shared catalog picker and no longer carries a fixed list", () => {
    expect(route).toMatch(/import \{ ActionPicker \} from "@\/components\/action-picker"/);
    const dialog = route.match(/function ChallengeDialog\(\{[\s\S]*?\n\}\n/);
    expect(dialog).not.toBeNull();
    expect(dialog![0]).toMatch(/<ActionPicker\s/);
    expect(dialog![0]).not.toMatch(/<Select\b/);
    expect(route).not.toMatch(/CHALLENGE_METRICS/);
    expect(route).not.toMatch(/label: "Incidents accepted"/);
  });

  it("the target field follows the metric's unit", () => {
    const dialog = route.match(/function ChallengeDialog\(\{[\s\S]*?\n\}\n/)![0];
    expect(dialog).toMatch(/const unit = challengeUnit\(form\.metric\)/);
    expect(dialog).toMatch(/targetToInput\(/);
    expect(dialog).toMatch(/targetFromInput\(Number\(form\.target\), unit\)/);
    expect(dialog).toMatch(/\{field\.prefix\}/);
    expect(dialog).toMatch(/\{field\.suffix\}/);
  });

  it("scoring goes through the challenge window's standings and fetchActionCounts", () => {
    const page = route.match(/function LeaderboardPage\(\) \{[\s\S]*?\n\}\n/)![0];
    expect(page).toMatch(/fetchStandings\(cw!\.from, cw!\.to, challengeLoc\)/);
    expect(page).toMatch(/fetchActionCounts\(cw!\.from, cw!\.to, challengeKeys, challengeLoc\)/);
    expect(page).toMatch(/challengeProgress\(challenge,/);
    expect(page).not.toMatch(/challengeValue\(/);
  });

  it("the card names the metric from the catalog and formats by unit", () => {
    const card = route.match(/\{\/\* Weekly challenge \*\/\}[\s\S]*?\{\/\* Team vs goal \*\/\}/);
    expect(card).not.toBeNull();
    expect(card![0]).toMatch(/challengeLabel\(challenge\.metric\)/);
    expect(card![0]).toMatch(/challengeWinnerRule\(challenge\.metric\)/);
    expect(card![0]).toMatch(/formatChallengeValue\(l\.value, progress!\.unit\)/);
  });

  it("the admin page imports the same picker rather than its own", () => {
    const admin = src("../routes/_authenticated/admin.scorecard.tsx");
    expect(admin).toMatch(
      /import \{ ActionPicker, UNIT_HINT \} from "@\/components\/action-picker"/,
    );
    expect(admin).not.toMatch(/function ActionPicker\(/);
    const picker = src("../components/action-picker.tsx");
    expect(picker).toMatch(/searchActions\(q, \{ group \}\)/);
    expect(picker).toMatch(/export function ActionPicker\(/);
  });
});
