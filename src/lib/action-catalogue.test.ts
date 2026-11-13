import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACTION_AREAS,
  ACTION_CATALOGUE,
  actionsForGroup,
  groupHitsByArea,
  keysNeedingCounts,
  searchActions,
} from "./action-catalogue";

/**
 * The catalogue is the contract between three things that cannot see each
 * other: the admin picker, the points math, and the SQL allowlist. These
 * tests hold the three together.
 */

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      "../../supabase/migrations/20260916140000_scorecard_action_catalogue.sql",
      import.meta.url,
    ),
  ),
  "utf8",
).replace(/\r\n/g, "\n");

/** Every seeded `scorecard_weights.component` value, from both seed migrations. */
const SEEDED_COMPONENTS = [
  // 20260805201804
  "touchpoints",
  "meetings_held",
  "accounts_advanced",
  "cadence_health",
  "contact_attempts",
  "jobs_won",
  "chase_acceptance",
  "chase_tta",
  "contracts_signed",
  // 20260820083748
  "jobs_signed_total",
  "calls_made",
  "stage_advances",
];

/** The six goal metrics wt/six-new-goal-metrics defines; same keys here. */
const GOAL_METRIC_KEYS = [
  "cold_calls",
  "cold_emails",
  "new_deals_worked",
  "cold_leads_converted",
  "active_client_reach_outs",
  "fires_chased",
];

describe("action catalog entries", () => {
  it("every entry has every field filled in", () => {
    for (const a of ACTION_CATALOGUE) {
      expect(a.key, "key").toMatch(/^[a-z][a-z0-9_]+$/);
      expect(a.label.trim().length, `${a.key} label`).toBeGreaterThan(2);
      expect(a.description.trim().length, `${a.key} description`).toBeGreaterThan(15);
      expect(a.rule.trim().length, `${a.key} rule`).toBeGreaterThan(10);
      expect(["count", "currency", "percent", "minutes"]).toContain(a.unit);
      expect(["higher", "lower"]).toContain(a.direction);
      expect(["sales", "chase", "both"]).toContain(a.group);
      expect(ACTION_AREAS.map((x) => x.id)).toContain(a.area);
      expect(a.synonyms.length, `${a.key} synonyms`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keys are unique", () => {
    const keys = ACTION_CATALOGUE.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is a real catalog, with every area populated", () => {
    expect(ACTION_CATALOGUE.length).toBeGreaterThanOrEqual(50);
    for (const area of ACTION_AREAS) {
      expect(
        ACTION_CATALOGUE.some((a) => a.area === area.id),
        `area ${area.id} has entries`,
      ).toBe(true);
    }
  });

  it("every seeded scorecard component maps to a catalog key, off the standings row", () => {
    for (const key of SEEDED_COMPONENTS) {
      const a = ACTION_CATALOGUE.find((x) => x.key === key);
      expect(a, `seeded component ${key}`).toBeDefined();
      expect(a!.standing, `${key} reads the standings row`).toBeTypeOf("function");
    }
  });

  it("defines the six goal metrics under the keys the goals branch uses", () => {
    for (const key of GOAL_METRIC_KEYS) {
      expect(
        ACTION_CATALOGUE.some((a) => a.key === key),
        key,
      ).toBe(true);
    }
  });

  it("offers chase-only actions to chase and sales-only to sales", () => {
    const sales = actionsForGroup("sales").map((a) => a.key);
    const chase = actionsForGroup("chase").map((a) => a.key);
    expect(sales).toContain("cold_calls");
    expect(sales).not.toContain("chase_tta");
    expect(chase).toContain("chase_tta");
    expect(chase).not.toContain("cold_calls");
    expect(sales).toContain("touchpoints");
    expect(chase).toContain("touchpoints");
  });
});

describe("the SQL allowlist covers the catalog", () => {
  /** The `WHEN 'key' THEN` branches in the migration — the allowlist itself. */
  const allowlisted = new Set(
    [...MIGRATION.matchAll(/WHEN '([a-z0-9_]+)'\s+THEN/g)].map((m) => m[1]),
  );

  it("has a WHEN branch for every catalog key", () => {
    const missing = ACTION_CATALOGUE.map((a) => a.key).filter((k) => !allowlisted.has(k));
    expect(missing, `add these to scorecard_action_counts: ${missing.join(", ")}`).toEqual([]);
  });

  it("ignores unknown keys instead of raising", () => {
    const tail = MIGRATION.match(/ELSE NULL;\s*END CASE;/);
    expect(tail).not.toBeNull();
  });

  it("is SECURITY DEFINER with its own access check, and the helpers are not callable by clients", () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf("FUNCTION public.scorecard_action_counts("));
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/public\.can_view_location\(auth\.uid\(\), lm\.location_id\)/);
    for (const helper of [
      "scorecard_account_client_since(uuid)",
      "scorecard_money_visible()",
      "scorecard_count_outreach(uuid[], timestamptz, timestamptz, text[], text[], text, boolean)",
      "scorecard_count_stage_moves(uuid[], timestamptz, timestamptz, text[], text[])",
    ]) {
      expect(MIGRATION).toContain(
        `REVOKE ALL ON FUNCTION public.${helper}`.replace(/\s+/g, " ").slice(0, 40),
      );
    }
  });

  it("guards every per-rep account aggregate against house accounts", () => {
    const guards = MIGRATION.match(/account_is_house_account\(/g) ?? [];
    // One per family helper plus one per direct branch that touches an account.
    expect(guards.length).toBeGreaterThanOrEqual(20);
  });

  it("only the RPC answers for keys with no standings column", () => {
    const need = keysNeedingCounts(ACTION_CATALOGUE.map((a) => a.key));
    expect(need).toContain("cold_calls");
    expect(need).toContain("documents_signed");
    expect(need).not.toContain("touchpoints");
    expect(need).not.toContain("chase_tta");
  });
});

describe("smart search", () => {
  const keys = (q: string, group?: "sales" | "chase") =>
    searchActions(q, { group }).map((h) => h.action.key);

  it('"cold call", "phone" and "dial" all find the calls entries', () => {
    expect(keys("cold call")[0]).toBe("cold_calls");
    expect(keys("phone")).toEqual(
      expect.arrayContaining(["calls_made", "cold_calls", "active_client_calls"]),
    );
    expect(keys("dial")).toEqual(
      expect.arrayContaining(["calls_made", "cold_calls", "active_client_calls"]),
    );
    expect(keys("dials")).toEqual(expect.arrayContaining(["calls_made", "cold_calls"]));
  });

  it('"showed up" finds in-person visits', () => {
    const top = keys("showed up").slice(0, 3);
    expect(top).toContain("meetings_in_person");
    expect(keys("showed up")).toContain("visits_logged");
  });

  it("matches synonyms, prefixes and one-letter typos", () => {
    expect(keys("zoom")[0]).toBe("meetings_virtual");
    expect(keys("emial")).toContain("emails_sent");
    expect(keys("ghost")[0]).toBe("moved_to_ghosted");
    expect(keys("linked")).toContain("linkedin_touches");
    expect(keys("$")).toContain("billed_value");
  });

  it("requires every word to land, and ranks label hits above description hits", () => {
    expect(keys("active client email")[0]).toBe("active_client_emails");
    expect(keys("purple elephant")).toEqual([]);
    const call = searchActions("call");
    const first = call.findIndex((h) => h.action.key === "calls_made");
    const desc = call.findIndex((h) => h.action.key === "touchpoints");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(desc === -1 || first < desc).toBe(true);
  });

  it("respects the group filter and groups by area in display order", () => {
    expect(keys("call", "chase")).not.toContain("cold_calls");
    expect(keys("", "chase")).toContain("chase_tta");
    const grouped = groupHitsByArea(searchActions("signed"));
    const order = grouped.map((g) => g.area);
    expect(order).toEqual(
      [...order].sort(
        (a, b) =>
          ACTION_AREAS.findIndex((x) => x.id === a) - ACTION_AREAS.findIndex((x) => x.id === b),
      ),
    );
    expect(grouped.every((g) => g.hits.length > 0)).toBe(true);
  });
});
