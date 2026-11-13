import { describe, expect, it } from "vitest";

import { clientHealthRail, healthRailSummary } from "./client-health-rail";
import { healthMoveRefusal } from "./client-health-move";
import { CLIENT_HEALTH_KEYS, type ClientHealthKey } from "./client-health";

function verdict(over: {
  health: ClientHealthKey;
  metric: ClientHealthKey;
  tracked?: boolean;
  reason?: string;
}) {
  return {
    health: over.health,
    metric: over.metric,
    tracked: over.tracked ?? true,
    reason: over.reason ?? "No touch in 134 days",
  };
}

describe("clientHealthRail", () => {
  it("is the four Farming bands, in the /farming board's order", () => {
    const rail = clientHealthRail(verdict({ health: "healthy", metric: "healthy" }));
    expect(rail.steps.map((s) => s.key)).toEqual(["healthy", "monitoring", "at_risk", "critical"]);
    expect(rail.steps.map((s) => s.label)).toEqual(["Healthy", "Watch", "At Risk", "Critical"]);
  });

  it("marks exactly the band the client is in", () => {
    const rail = clientHealthRail(verdict({ health: "at_risk", metric: "at_risk" }));
    expect(rail.steps.filter((s) => s.current).map((s) => s.key)).toEqual(["at_risk"]);
    expect(rail.currentIndex).toBe(2);
  });

  it("locks every band below the metric floor and leaves the rest open", () => {
    const rail = clientHealthRail(verdict({ health: "at_risk", metric: "at_risk" }));
    const locked = rail.steps.filter((s) => s.locked).map((s) => s.key);
    expect(locked).toEqual(["healthy", "monitoring"]);
  });

  it("locks the whole rail for an account with no follow-up clock", () => {
    const rail = clientHealthRail(
      verdict({ health: "healthy", metric: "healthy", tracked: false }),
    );
    expect(rail.tracked).toBe(false);
    expect(rail.steps.every((s) => s.locked)).toBe(true);
  });

  it("opens every band above the floor when the metric says Healthy", () => {
    const rail = clientHealthRail(verdict({ health: "healthy", metric: "healthy" }));
    expect(rail.steps.filter((s) => s.locked)).toEqual([]);
  });

  /**
   * The rail's lock and the board's refusal are the same rule asked at two
   * moments — before the click and after it. If they ever disagreed, the
   * record would offer a move the board would refuse, or grey out one it
   * would allow. Every band against every floor, both clock states.
   */
  it("never disagrees with healthMoveRefusal", () => {
    for (const tracked of [true, false]) {
      for (const metric of CLIENT_HEALTH_KEYS) {
        const rail = clientHealthRail(verdict({ health: metric, metric, tracked }));
        for (const step of rail.steps) {
          const refusal = healthMoveRefusal(
            {
              name: "Test comapny",
              healthMetric: metric,
              healthReason: "No touch in 134 days",
              healthTracked: tracked,
            },
            step.key,
          );
          // The band it is already in is never a move, so the refusal rule has
          // nothing to say about it; the rail draws it as the pill either way.
          if (step.current) continue;
          expect({ key: step.key, locked: step.locked }).toEqual({
            key: step.key,
            locked: refusal !== null,
          });
        }
      }
    }
  });
});

describe("healthRailSummary", () => {
  it("names the band and why it is that band", () => {
    expect(
      healthRailSummary({ health: "at_risk", reason: "No touch in 134 days", tracked: true }),
    ).toBe("At Risk · No touch in 134 days");
  });

  it("says only the reason when the account has no clock — it is not Healthy, it is untracked", () => {
    const reason = "Homeowner — a one-time job, so there is no follow-up clock";
    expect(healthRailSummary({ health: "healthy", reason, tracked: false })).toBe(reason);
  });
});
