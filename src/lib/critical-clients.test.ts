import { describe, expect, it } from "vitest";

import {
  CRITICAL_CURE_WINDOW_DAYS,
  criticalDeadline,
  criticalTrack,
  criticalWindow,
  planCriticalSweep,
  recoveryTaskRow,
  type CriticalSweepRow,
} from "./critical-clients";

/**
 * Melly: "The day an account goes Critical, three things happen
 * automatically. A recovery task is created and assigned to the rep with a
 * hard deadline. ... The rep then has thirty days. Only a real acknowledged
 * response fixes it."
 *
 * The planner is the decision without the database: which episodes to open
 * tonight, which have recovered, and which are past day thirty.
 */

const NOW = Date.parse("2026-11-06T03:00:00Z");
const DAY = 86_400_000;

function row(over: Partial<CriticalSweepRow> = {}): CriticalSweepRow {
  return {
    accountId: "acc-1",
    name: "Kingsbridge Residential Mgmt",
    assignedRep: "rep-1",
    locationId: "loc-1",
    isDemo: false,
    healthTracked: true,
    health: "critical",
    healthTracks: [
      { key: "relationship", health: "critical", reason: "Quarterly follow-up 44 days overdue" },
      { key: "compliance", health: "healthy", reason: "Paperwork in order · 2 requirements" },
    ],
    ...over,
  };
}

describe("planCriticalSweep — the day an account goes Critical", () => {
  it("opens an episode with a thirty-day deadline and the driving track", () => {
    const plan = planCriticalSweep({ rows: [row()], open: [], now: NOW });
    expect(plan.open).toHaveLength(1);
    const ep = plan.open[0]!;
    expect(ep.account_id).toBe("acc-1");
    expect(ep.assigned_rep).toBe("rep-1");
    expect(ep.track).toBe("relationship");
    expect(ep.reason).toBe("Quarterly follow-up 44 days overdue");
    expect(ep.deadline).toBe(criticalDeadline(NOW));
    expect(criticalDeadline(NOW)).toBe("2026-12-06");
    expect(CRITICAL_CURE_WINDOW_DAYS).toBe(30);
  });

  it("any Critical counts — the paperwork track alone opens one", () => {
    const plan = planCriticalSweep({
      rows: [
        row({
          healthTracks: [
            { key: "relationship", health: "healthy", reason: "Touched 3 days ago" },
            { key: "compliance", health: "critical", reason: "Client owes us: w9 missing 35d" },
          ],
        }),
      ],
      open: [],
      now: NOW,
    });
    expect(plan.open[0]?.track).toBe("compliance");
    expect(plan.open[0]?.reason).toBe("Client owes us: w9 missing 35d");
  });

  it("does not open a second episode while one is open", () => {
    const plan = planCriticalSweep({
      rows: [row()],
      open: [{ id: "ep-1", account_id: "acc-1", recovery_task_id: null, deadline: "2026-12-01" }],
      now: NOW,
    });
    expect(plan.open).toHaveLength(0);
    expect(plan.recovered).toHaveLength(0);
  });

  it("neither At Risk nor an untracked account (a homeowner) opens one", () => {
    const plan = planCriticalSweep({
      rows: [
        row({ accountId: "a", health: "at_risk" }),
        row({ accountId: "b", healthTracked: false, health: "healthy" }),
      ],
      open: [],
      now: NOW,
    });
    expect(plan.open).toHaveLength(0);
  });

  it("closes as recovered only when the band itself has dropped", () => {
    const open = [
      { id: "ep-1", account_id: "acc-1", recovery_task_id: "t-1", deadline: "2026-12-01" },
    ];
    const still = planCriticalSweep({ rows: [row()], open, now: NOW });
    expect(still.recovered).toHaveLength(0);
    const answered = planCriticalSweep({
      rows: [row({ health: "at_risk" })],
      open,
      now: NOW,
    });
    expect(answered.recovered.map((e) => e.id)).toEqual(["ep-1"]);
  });

  it("closes an episode whose account has left Active Clients", () => {
    const plan = planCriticalSweep({
      rows: [],
      open: [{ id: "ep-1", account_id: "gone", recovery_task_id: null, deadline: "2026-12-01" }],
      now: NOW,
    });
    expect(plan.closed.map((e) => e.id)).toEqual(["ep-1"]);
    expect(plan.recovered).toHaveLength(0);
  });

  it("flags the day-30 decision once the deadline has passed and the client is still Critical", () => {
    const plan = planCriticalSweep({
      rows: [row()],
      open: [{ id: "ep-1", account_id: "acc-1", recovery_task_id: null, deadline: "2026-11-05" }],
      now: NOW,
    });
    expect(plan.decisionDue.map((e) => e.id)).toEqual(["ep-1"]);
    const onTheDay = planCriticalSweep({
      rows: [row()],
      open: [{ id: "ep-1", account_id: "acc-1", recovery_task_id: null, deadline: "2026-11-06" }],
      now: NOW,
    });
    expect(onTheDay.decisionDue).toHaveLength(0);
  });
});

describe("criticalTrack", () => {
  it("names the relationship first when both tracks are Critical, and keeps the other reason", () => {
    const t = criticalTrack([
      { key: "compliance", health: "critical", reason: "COI expired 40d" },
      { key: "relationship", health: "critical", reason: "Annual meeting 61 days overdue" },
    ]);
    expect(t.track).toBe("relationship");
    expect(t.reason).toBe("Annual meeting 61 days overdue · COI expired 40d");
  });
});

describe("the recovery task", () => {
  it("is urgent, due on the deadline, keyed to the episode, and says a tick does not clear it", () => {
    const plan = planCriticalSweep({ rows: [row()], open: [], now: NOW }).open[0]!;
    const task = recoveryTaskRow(plan, "ep-9", "rep-1");
    expect(task.priority).toBe("urgent");
    expect(task.due_date).toBe("2026-12-06");
    expect(task.cadence_key).toBe("critical:ep-9");
    expect(task.source).toBe("critical");
    expect(task.assignee).toBe("rep-1");
    expect(task.description).toContain("completing this task does not");
  });
});

describe("criticalWindow", () => {
  it("counts the day of the window and the days left", () => {
    const w = criticalWindow(
      { opened_at: new Date(NOW - 11 * DAY).toISOString(), deadline: "2026-11-25" },
      NOW,
    );
    expect(w.dayOf).toBe(12);
    expect(w.daysLeft).toBe(19);
    expect(w.decisionDue).toBe(false);
  });
  it("is decision-due the day after the deadline", () => {
    const w = criticalWindow(
      { opened_at: new Date(NOW - 31 * DAY).toISOString(), deadline: "2026-11-05" },
      NOW,
    );
    expect(w.daysLeft).toBe(-1);
    expect(w.decisionDue).toBe(true);
  });
});
