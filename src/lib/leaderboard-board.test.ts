import { describe, expect, it } from "vitest";

import { buildRows, countKeysFor, pointsFor, type Weight } from "./leaderboard-board";
import type { Standing } from "./leaderboard";

/**
 * Points must not move because the plumbing changed.
 *
 * `componentValue()` was a `switch` over fixed standings columns; it is now
 * the action catalogue. For every component the seed migrations put in
 * `scorecard_weights` — the six sales and five chase rows of 20260805201804
 * and the three sales rows 20260820083748 added — the new path has to produce
 * the number the old switch produced, on the same standings row. The old
 * switch is kept here, verbatim, as the oracle.
 */

function oldComponentValue(s: Standing, component: string): number | null {
  switch (component) {
    case "touchpoints":
      return s.touchpoints;
    case "contact_attempts":
      return s.activity_events;
    case "meetings_held":
      return s.meetings_held;
    case "accounts_advanced":
      return s.accounts_advanced;
    case "cadence_health":
      return s.cadence_health;
    case "jobs_won":
      return s.jobs_won;
    case "contracts_signed":
      return s.contracts_signed;
    case "chase_acceptance":
      return s.chase_acceptance;
    case "chase_tta":
      return s.median_tta_minutes;
    case "incidents_accepted":
      return s.incidents_accepted;
    case "incidents_dispatched":
      return s.incidents_dispatched;
    case "new_accounts":
      return s.new_accounts;
    case "billed_value":
      return s.billed_value;
    case "calls_made":
      return s.calls_made ?? 0;
    case "stage_advances":
      return s.stage_advances ?? 0;
    case "jobs_signed_total":
      return s.jobs_signed_total ?? s.jobs_won;
    case "jobs_signed_insurance":
      return s.jobs_signed_insurance ?? 0;
    case "jobs_signed_cash":
      return s.jobs_signed_cash ?? 0;
    default:
      return null;
  }
}

function oldPointsFor(s: Standing, weights: Weight[]): number {
  const group =
    s.roles.includes("field_chaser") || s.roles.includes("field") || s.roles.includes("crew")
      ? "chase"
      : "sales";
  const rows = weights.filter((w) => w.enabled && w.role_group === group);
  let total = 0;
  for (const w of rows) {
    const v = oldComponentValue(s, w.component);
    if (v == null || !Number.isFinite(v)) continue;
    const target = Number(w.target) || 1;
    const ratio = w.direction === "lower" ? target / Math.max(v, 0.0001) : v / target;
    total += Number(w.weight) * Math.min(Math.max(ratio, 0), 3);
  }
  return Math.round(total * 25);
}

/** The seeds, exactly as the two migrations insert them (company-wide rows). */
const SEEDS: Weight[] = [
  {
    location_id: null,
    role_group: "sales",
    component: "touchpoints",
    weight: 20,
    target: 30,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "sales",
    component: "meetings_held",
    weight: 15,
    target: 4,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "sales",
    component: "accounts_advanced",
    weight: 15,
    target: 6,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "sales",
    component: "cadence_health",
    weight: 25,
    target: 1,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "sales",
    component: "contact_attempts",
    weight: 10,
    target: 20,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "sales",
    component: "jobs_won",
    weight: 15,
    target: 3,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "chase",
    component: "chase_acceptance",
    weight: 30,
    target: 1,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "chase",
    component: "chase_tta",
    weight: 25,
    target: 20,
    direction: "lower",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "chase",
    component: "contracts_signed",
    weight: 25,
    target: 5,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "chase",
    component: "touchpoints",
    weight: 10,
    target: 10,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "chase",
    component: "jobs_won",
    weight: 10,
    target: 3,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "sales",
    component: "jobs_signed_total",
    weight: 30,
    target: 6,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "sales",
    component: "calls_made",
    weight: 20,
    target: 200,
    direction: "higher",
    enabled: true,
  },
  {
    location_id: null,
    role_group: "sales",
    component: "stage_advances",
    weight: 20,
    target: 25,
    direction: "higher",
    enabled: true,
  },
];

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
    // The six activity goals (#196) are required on Standing; null = not
    // measured, which is what a standings row carries before that migration.
    cold_calls: null,
    cold_emails: null,
    new_deals_worked: null,
    cold_leads_converted: null,
    active_client_reach_outs: null,
    fires_chased: null,
    ...over,
  };
}

const CASES: Standing[] = [
  standing({}),
  standing({ roles: ["field_chaser"], user_id: "c1" }),
  standing({
    cadence_health: null,
    chase_acceptance: null,
    median_tta_minutes: null,
    user_id: "u2",
  }),
  standing({ touchpoints: 0, jobs_won: 0, calls_made: 0, stage_advances: 0, user_id: "u3" }),
  standing({ roles: ["field"], median_tta_minutes: 4, contracts_signed: 20, user_id: "c2" }),
  // A row from a build before 20260820083748: the newer columns are absent.
  standing({
    calls_made: undefined as unknown as number,
    stage_advances: undefined as unknown as number,
    jobs_signed_total: undefined as unknown as number,
    user_id: "u4",
  }),
];

describe("seeded components score identically to the old switch", () => {
  it.each(CASES.map((s) => [s.user_id, s] as const))("%s", (_id, s) => {
    expect(pointsFor(s, SEEDS)).toBe(oldPointsFor(s, SEEDS));
  });

  it("per component, on every case", () => {
    for (const s of CASES) {
      for (const w of SEEDS) {
        const one = [w];
        expect(pointsFor(s, one), `${s.user_id} ${w.component}`).toBe(oldPointsFor(s, one));
      }
    }
  });

  it("a rep who exactly hits every seeded sales target scores 170 × 25", () => {
    const s = standing({
      touchpoints: 30,
      meetings_held: 4,
      accounts_advanced: 6,
      cadence_health: 1,
      activity_events: 20,
      jobs_won: 3,
      jobs_signed_total: 6,
      calls_made: 200,
      stage_advances: 25,
    });
    expect(pointsFor(s, SEEDS)).toBe(170 * 25);
  });
});

describe("catalog components the standings row does not carry", () => {
  const cold: Weight = {
    location_id: null,
    role_group: "sales",
    component: "cold_calls",
    weight: 10,
    target: 50,
    direction: "higher",
    enabled: true,
  };

  it("contribute nothing until the RPC answers — the old behavior, not a wrong number", () => {
    const s = standing({});
    expect(pointsFor(s, [...SEEDS, cold])).toBe(oldPointsFor(s, SEEDS));
    expect(pointsFor(s, [...SEEDS, cold], null)).toBe(oldPointsFor(s, SEEDS));
  });

  it("score from the counts row when it is there", () => {
    const s = standing({});
    expect(pointsFor(s, [cold], { cold_calls: 25 })).toBe(Math.round(10 * 0.5 * 25));
    expect(pointsFor(s, [cold], { cold_calls: null })).toBe(0);
  });

  it("are the only keys the board asks the RPC for", () => {
    expect(countKeysFor([...SEEDS, cold])).toEqual(["cold_calls"]);
    expect(countKeysFor([...SEEDS, { ...cold, enabled: false }])).toEqual([]);
  });

  it("flow through buildRows for current and previous windows", () => {
    const s = standing({});
    const rows = buildRows(
      [s],
      [s],
      [cold],
      [],
      {},
      { u1: { cold_calls: 50 } },
      { u1: { cold_calls: 25 } },
    );
    expect(rows[0].points).toBe(250);
    expect(rows[0].rank).toBe(1);
  });
});

describe("office overrides follow weightsFor()", () => {
  it("an office row replaces the company row for that component, for reps of that office", () => {
    const company: Weight = SEEDS[0]; // sales touchpoints 20 @ 30
    const office: Weight = { ...company, id: "o", location_id: "loc-1", target: 60 };
    const s = standing({ touchpoints: 30 });
    expect(pointsFor(s, [company])).toBe(20 * 25);
    expect(pointsFor(s, [company, office])).toBe(Math.round(20 * 0.5 * 25));
    // A rep in another office keeps the company rule.
    expect(
      pointsFor(standing({ touchpoints: 30, location_ids: ["loc-2"] }), [company, office]),
    ).toBe(20 * 25);
  });
});
