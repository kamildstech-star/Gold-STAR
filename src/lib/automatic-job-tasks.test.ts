/**
 * Mark: "these are the tasks that should auto populate for each job
 * type". His list is copied below as the expected value — spelling fixed
 * ("withing", "its"), dashes evened out, nothing else — so a template that
 * drifts from what the crews follow fails here rather than on a job.
 *
 * Every date in this file is passed in. Nothing here may lean on the real
 * clock: a fixed fixture date beside a function that defaults to Date.now()
 * is what took main red on 24 September.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  addDays,
  automaticScopeTypeFor,
  automaticTaskGroupLabel,
  buildAutomaticTaskSyncPlan,
  coalescePerKey,
  equipmentFollowUpDates,
  type AutomaticTaskContext,
  type ExistingAutomaticTask,
  type PlacementDates,
} from "./automatic-job-tasks";
import { pushRetrievalDates, retrievalDateAfterReset, writeDryingReset } from "./drying-reset";
import type { DryingReset } from "./drying-clock";

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const TODAY = "2026-09-04";
/** UTC calendar date, so these tests read the same in any time zone. */
const utcDate = (at: Date) => at.toISOString().slice(0, 10);

const MARK = {
  waterExtraction: [
    "Inspection",
    "Extraction",
    "Readings",
    "Set up equipment – Scan",
    "Scope of work – if needed",
    "Pictures",
  ],
  // "Same as above", then the remediation work.
  waterRemediationOnly: [
    "Containment if needed",
    "Cover contents if needed",
    "Remove equipment",
    "Remediate walls/ceiling as needed",
    "Treat and clean",
    "Set back up equipment",
    "Reset 3 days of drying time",
    "Pictures",
    "Sketch",
    "Write up",
    "Make sure property is clean",
  ],
  monitoring: [
    "Check drying progress within first 3 days to make sure it's drying",
    "Readings",
    "Pictures",
  ],
  pickup: [
    "Confirm everything is dry (readings)",
    "Pictures to confirm dry",
    "Purge Dehu",
    "Scan all equipment",
    "Make sure property is clean",
  ],
  mold: [
    "Inspection",
    "Set up containment",
    "Set up Negative air – Scan scrubber",
    "Remediate as needed",
    "Wipe/HEPA/Wipe (must use HEPA vac) or HEPA/Wipe/HEPA – as needed",
    "Treat and clean",
    "Set up Dehu if needed",
    "Leave scrubber",
    "Encapsulate – as needed",
    "Pictures",
  ],
  fire: [
    "Inspection",
    "Board up",
    "Extraction",
    "Readings",
    "Seal off fire scene",
    "Secure property",
    "Winterize areas that will not have heat",
    "Release form",
    "Set up equipment – Scan",
    "Scope of work – if needed",
    "Pictures",
    "Remediate – as needed",
  ],
};

function context(overrides: Partial<AutomaticTaskContext> = {}): AutomaticTaskContext {
  return {
    jobId: JOB_ID,
    lossTypeKey: "water_mitigation",
    additionalRemediationRequired: false,
    equipmentAdded: false,
    syncDate: TODAY,
    ...overrides,
  };
}

function existingFromPlan(
  plan: ReturnType<typeof buildAutomaticTaskSyncPlan>,
  status = "open",
): ExistingAutomaticTask[] {
  return plan.insert.map((task, index) => ({
    id: `task-${index}`,
    status,
    source: task.source,
    cadenceKey: task.cadenceKey,
    dueDate: task.dueDate,
    title: task.title,
  }));
}

const titlesOf = (plan: ReturnType<typeof buildAutomaticTaskSyncPlan>, group: string) =>
  plan.insert.filter((task) => task.source === `job_scope:${group}`).map((task) => task.title);

function placement(placedAt: string, expected: string | null, retrievedAt: string | null = null) {
  return {
    placed_at: placedAt,
    expected_retrieval_date: expected,
    retrieved_at: retrievedAt,
  } satisfies PlacementDates;
}

function reset(resetAt: string): DryingReset {
  return {
    id: `r-${resetAt}`,
    reset_at: resetAt,
    reset_by: null,
    previous_started_at: null,
    note: null,
  };
}

describe("job type mapping", () => {
  it("maps the service categories that exist in the data, and nothing else", () => {
    expect(automaticScopeTypeFor("water_mitigation")).toBe("water");
    expect(automaticScopeTypeFor("water")).toBe("water");
    expect(automaticScopeTypeFor("mold_remediation")).toBe("mold");
    expect(automaticScopeTypeFor("mold")).toBe("mold");
    expect(automaticScopeTypeFor("fire_smoke_cleaning")).toBe("fire_smoke");
    expect(automaticScopeTypeFor("fire")).toBe("fire_smoke");
    expect(automaticScopeTypeFor("smoke")).toBe("fire_smoke");
    expect(automaticScopeTypeFor("reconstruction")).toBeNull();
    expect(automaticScopeTypeFor(null)).toBeNull();
  });

  it("labels each group the way Mark headed it", () => {
    expect(automaticTaskGroupLabel("job_scope:water_extraction")).toBe("Water · Extraction");
    expect(automaticTaskGroupLabel("job_scope:water_remediation")).toBe("Water · Remediation");
    expect(automaticTaskGroupLabel("job_scope:water_monitoring")).toBe("Monitoring");
    expect(automaticTaskGroupLabel("job_scope:water_pickup")).toBe("Pick up equipment");
    expect(automaticTaskGroupLabel("job_scope:mold_remediation")).toBe("Mold");
    expect(automaticTaskGroupLabel("job_scope:fire_smoke")).toBe("Fire");
    expect(automaticTaskGroupLabel("manual")).toBeNull();
  });
});

describe("each job type seeds exactly Mark's list, in his order", () => {
  it("Water seeds Extraction and nothing else at creation", () => {
    const plan = buildAutomaticTaskSyncPlan(context(), []);
    expect(plan.insert.map((task) => task.title)).toEqual(MARK.waterExtraction);
    expect(plan.insert.every((task) => task.dueDate === TODAY)).toBe(true);
    expect(new Set(plan.insert.map((task) => task.cadenceKey)).size).toBe(6);
  });

  it("Mold seeds Mark's Mold list", () => {
    const plan = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "mold_remediation" }), []);
    expect(plan.insert.map((task) => task.title)).toEqual(MARK.mold);
  });

  it("Fire seeds Mark's Fire list", () => {
    const plan = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "fire_smoke_cleaning" }), []);
    expect(plan.insert.map((task) => task.title)).toEqual(MARK.fire);
  });

  it("Water · Remediation is 'Same as above' followed by the remediation work", () => {
    const plan = buildAutomaticTaskSyncPlan(context({ additionalRemediationRequired: true }), []);
    expect(titlesOf(plan, "water_remediation")).toEqual([
      ...MARK.waterExtraction,
      ...MARK.waterRemediationOnly,
    ]);
  });

  it("Monitoring and Pick up equipment carry Mark's wording", () => {
    const plan = buildAutomaticTaskSyncPlan(context({ equipmentAdded: true }), []);
    expect(titlesOf(plan, "water_monitoring")).toEqual(MARK.monitoring);
    expect(titlesOf(plan, "water_pickup")).toEqual(MARK.pickup);
  });

  it("the reset task points at the button, since half of Mark's line is a feature", () => {
    const plan = buildAutomaticTaskSyncPlan(context({ additionalRemediationRequired: true }), []);
    const task = plan.insert.find((t) => t.cadenceKey.endsWith(":water_remediation:reset_drying"));
    expect(task?.title).toBe("Reset 3 days of drying time");
    expect(task?.description).toContain("Reset 3-day drying");
  });

  it("an unmapped job type seeds nothing", () => {
    const plan = buildAutomaticTaskSyncPlan(
      context({ lossTypeKey: "reconstruction", equipmentAdded: true }),
      [],
    );
    expect(plan.insert).toEqual([]);
  });
});

describe("seeding is idempotent", () => {
  it("a second reconcile of the same job inserts and changes nothing", () => {
    const full = context({ additionalRemediationRequired: true, equipmentAdded: true });
    const first = buildAutomaticTaskSyncPlan(full, []);
    const second = buildAutomaticTaskSyncPlan(full, existingFromPlan(first));
    expect(second).toEqual({
      insert: [],
      reopenIds: [],
      cancelIds: [],
      dueDateUpdates: [],
      titleUpdates: [],
    });
  });

  it("Remediation seeds once: the flag adds its 17 rows, and only those, exactly once", () => {
    const base = buildAutomaticTaskSyncPlan(context(), []);
    const rows = existingFromPlan(base);
    const flagged = buildAutomaticTaskSyncPlan(
      context({ additionalRemediationRequired: true }),
      rows,
    );
    expect(flagged.insert).toHaveLength(17);
    expect(flagged.insert.every((task) => task.source === "job_scope:water_remediation")).toBe(
      true,
    );

    const again = buildAutomaticTaskSyncPlan(context({ additionalRemediationRequired: true }), [
      ...rows,
      ...existingFromPlan(flagged).map((row, i) => ({ ...row, id: `rem-${i}` })),
    ]);
    expect(again.insert).toEqual([]);
  });

  it("Remediation is a Water phase only", () => {
    const mold = buildAutomaticTaskSyncPlan(
      context({ lossTypeKey: "mold", additionalRemediationRequired: true }),
      [],
    );
    expect(titlesOf(mold, "water_remediation")).toEqual([]);
  });

  it("retires only unfinished automatic work after a type change", () => {
    const water = buildAutomaticTaskSyncPlan(context(), []);
    const rows = existingFromPlan(water);
    rows[0]!.status = "done";
    rows.push({
      id: "manual-task",
      status: "open",
      source: "manual",
      cadenceKey: null,
      dueDate: null,
    });

    const mold = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "mold" }), rows);
    expect(mold.cancelIds).toHaveLength(5);
    expect(mold.cancelIds).not.toContain(rows[0]!.id);
    expect(mold.cancelIds).not.toContain("manual-task");
    expect(mold.insert).toHaveLength(10);
  });

  it("reopens retired automatic tasks but never reopens completed ones", () => {
    const first = buildAutomaticTaskSyncPlan(context(), []);
    const rows = existingFromPlan(first, "cancelled");
    rows[0]!.status = "done";

    const resumed = buildAutomaticTaskSyncPlan(context(), rows);
    expect(resumed.reopenIds).toHaveLength(5);
    expect(resumed.reopenIds).not.toContain(rows[0]!.id);
    expect(resumed.insert).toEqual([]);
  });

  it("brings open rows seeded under the old wording to Mark's, and leaves ticked ones alone", () => {
    const plan = buildAutomaticTaskSyncPlan(context({ equipmentAdded: true }), []);
    const rows = existingFromPlan(plan);
    const purge = rows.find((r) => r.cadenceKey!.endsWith(":water_pickup:purge_dehu"))!;
    const check = rows.find((r) =>
      r.cadenceKey!.endsWith(":water_monitoring:check_drying_progress"),
    )!;
    purge.title = "Purge dehumidifier";
    check.title = "Check drying progress within the first 3 days";
    check.status = "done";

    const next = buildAutomaticTaskSyncPlan(context({ equipmentAdded: true }), rows);
    expect(next.titleUpdates).toEqual([{ id: purge.id, title: "Purge Dehu" }]);
    expect(next.insert).toEqual([]);
  });
});

describe("whenever equipment is added", () => {
  // Six machines dropped one at a time over an afternoon.
  const sixDrops = [
    "2026-09-04T14:00:00Z",
    "2026-09-04T14:20:00Z",
    "2026-09-04T15:05:00Z",
    "2026-09-04T16:40:00Z",
    "2026-09-04T17:10:00Z",
    "2026-09-04T18:30:00Z",
  ].map((at) => placement(at, "2026-09-07"));

  it("dates Monitoring from the first placement plus three days", () => {
    const dates = equipmentFollowUpDates(sixDrops, [], utcDate);
    expect(dates).toEqual({
      equipmentAdded: true,
      dryingWindowEndsOn: "2026-09-07",
      retrievalDueOn: "2026-09-07",
    });
    const plan = buildAutomaticTaskSyncPlan(context({ syncDate: "2026-09-04", ...dates }), []);
    const monitoring = plan.insert.filter((t) => t.source === "job_scope:water_monitoring");
    expect(monitoring.map((t) => t.title)).toEqual(MARK.monitoring);
    expect(monitoring.every((t) => t.dueDate === addDays("2026-09-04", 3))).toBe(true);
  });

  it("seeds Monitoring once per job, not once per machine", () => {
    let rows: ExistingAutomaticTask[] = existingFromPlan(buildAutomaticTaskSyncPlan(context(), []));
    let monitoringInserted = 0;
    for (let n = 1; n <= sixDrops.length; n++) {
      const dates = equipmentFollowUpDates(sixDrops.slice(0, n), [], utcDate);
      const plan = buildAutomaticTaskSyncPlan(context({ ...dates }), rows);
      monitoringInserted += plan.insert.filter(
        (t) => t.source === "job_scope:water_monitoring",
      ).length;
      rows = [...rows, ...existingFromPlan(plan).map((r, i) => ({ ...r, id: `drop${n}-${i}` }))];
    }
    expect(monitoringInserted).toBe(3);
    expect(rows.filter((r) => r.source === "job_scope:water_pickup")).toHaveLength(5);
  });

  it("does not seed anything for equipment before a unit is placed", () => {
    const dates = equipmentFollowUpDates([], [], utcDate);
    expect(dates).toEqual({
      equipmentAdded: false,
      dryingWindowEndsOn: null,
      retrievalDueOn: null,
    });
  });

  it("applies to Mold and Fire jobs too — the heading is not under Water", () => {
    const dates = equipmentFollowUpDates(sixDrops, [], utcDate);
    for (const type of ["mold_remediation", "fire_smoke_cleaning"]) {
      const plan = buildAutomaticTaskSyncPlan(context({ lossTypeKey: type, ...dates }), []);
      expect(titlesOf(plan, "water_monitoring")).toEqual(MARK.monitoring);
      expect(titlesOf(plan, "water_pickup")).toEqual(MARK.pickup);
    }
  });

  it("dates Pick up equipment on the expected-retrieval date of units still on site", () => {
    const placements = [
      placement("2026-09-04T14:00:00Z", "2026-09-06", "2026-09-06T15:00:00Z"),
      placement("2026-09-04T15:00:00Z", "2026-09-10"),
      placement("2026-09-04T16:00:00Z", "2026-09-12"),
    ];
    const dates = equipmentFollowUpDates(placements, [], utcDate);
    expect(dates.retrievalDueOn).toBe("2026-09-10");
    const plan = buildAutomaticTaskSyncPlan(context({ ...dates }), []);
    const pickup = plan.insert.filter((t) => t.source === "job_scope:water_pickup");
    expect(pickup.every((t) => t.dueDate === "2026-09-10")).toBe(true);
    // Monitoring still keys off the first drop, not the retrieval plan.
    const monitoring = plan.insert.filter((t) => t.source === "job_scope:water_monitoring");
    expect(monitoring.every((t) => t.dueDate === "2026-09-07")).toBe(true);
  });

  it("coalesces a burst of placement syncs into at most two runs per job", async () => {
    const runs: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const schedule = coalescePerKey(async (key) => {
      runs.push(key);
      await gate;
    });
    const calls = Array.from({ length: 6 }, () => schedule(JOB_ID));
    calls.push(schedule("other-job"));
    release();
    await Promise.all(calls);
    expect(runs.filter((k) => k === JOB_ID)).toHaveLength(2);
    expect(runs.filter((k) => k === "other-job")).toHaveLength(1);
  });
});

describe("Reset 3 days of drying time", () => {
  const placements = [
    placement("2026-09-04T14:00:00Z", "2026-09-07"),
    placement("2026-09-04T15:00:00Z", "2026-09-07"),
  ];

  it("moves the drying window to 72 hours after the reset", () => {
    const before = equipmentFollowUpDates(placements, [], utcDate);
    const after = equipmentFollowUpDates(placements, [reset("2026-09-09T13:00:00Z")], utcDate);
    expect(before.dryingWindowEndsOn).toBe("2026-09-07");
    expect(after.dryingWindowEndsOn).toBe("2026-09-12");
  });

  it("re-dates open Monitoring and Pick up tasks, never finished ones", () => {
    const initial = buildAutomaticTaskSyncPlan(
      context({ ...equipmentFollowUpDates(placements, [], utcDate) }),
      [],
    );
    const rows = existingFromPlan(initial);
    const doneCheck = rows.find((r) => r.cadenceKey!.endsWith(":water_monitoring:readings"))!;
    doneCheck.status = "done";

    // After the reset the units were pushed to the new date, too.
    const resetAt = "2026-09-09T13:00:00Z";
    const moved = placements.map((p) => ({ ...p, expected_retrieval_date: "2026-09-12" }));
    const plan = buildAutomaticTaskSyncPlan(
      context({
        syncDate: "2026-09-09",
        ...equipmentFollowUpDates(moved, [reset(resetAt)], utcDate),
      }),
      rows,
    );

    expect(plan.dueDateUpdates).toHaveLength(7);
    expect(plan.dueDateUpdates.every((u) => u.dueDate === "2026-09-12")).toBe(true);
    expect(plan.dueDateUpdates.map((u) => u.id)).not.toContain(doneCheck.id);
    expect(plan.insert).toEqual([]);
  });

  it("sets the retrieval date 72 hours from the moment it was pressed", () => {
    // Noon UTC, so the calendar date is the same in every time zone a phone is in.
    expect(retrievalDateAfterReset("2026-09-10T12:00:00Z")).toBe("2026-09-13");
  });
});

/* A PostgREST builder that records what it was asked, for the reset write. */
function recordingClient(log: string[]) {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        log.push(`${table}.${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
        return chain;
      };
    for (const name of ["update", "upsert", "eq", "is", "or", "select"]) chain[name] = record(name);
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: [{ id: "p1" }], error: null });
    return chain;
  };
  return { from: (table: string) => builder(table) } as never;
}

describe("the reset write", () => {
  it("only ever pushes units still on site forward", async () => {
    const log: string[] = [];
    const moved = await pushRetrievalDates(JOB_ID, "2026-09-12", recordingClient(log));
    expect(moved).toBe(1);
    expect(log).toContain(`equipment_placements.is("retrieved_at",null)`);
    expect(log).toContain(
      `equipment_placements.or("expected_retrieval_date.is.null,expected_retrieval_date.lt.2026-09-12")`,
    );
  });

  it("moves the dates before it records the reset", async () => {
    const log: string[] = [];
    await writeDryingReset(
      {
        id: "reset-1",
        job_id: JOB_ID,
        reset_at: "2026-09-10T12:00:00Z",
        reset_by: null,
        previous_started_at: null,
        note: null,
      },
      recordingClient(log),
    );
    const update = log.findIndex((l) => l.startsWith("equipment_placements.update"));
    const record = log.findIndex((l) => l.startsWith("job_drying_resets.upsert"));
    expect(log[update]).toContain(`"expected_retrieval_date":"2026-09-13"`);
    expect(update).toBeGreaterThanOrEqual(0);
    expect(record).toBeGreaterThan(update);
  });
});

/* ------------------------------------------------------------------ */
/* Wiring: where the triggers actually fire                            */
/* ------------------------------------------------------------------ */

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("wiring", () => {
  it("a placement written online seeds the equipment tasks", () => {
    const placeUnit = read("src/lib/equipment-writes.ts").match(
      /export async function placeUnit[\s\S]*?\n}\n/,
    )![0];
    expect(placeUnit).toMatch(
      /await writePlacement\(row\);[\s\S]*?scheduleAutomaticTaskSync\(input\.jobId, input\.userId\)/,
    );
  });

  it("the queue seeds after a drained placement or a reset lands", () => {
    const source = read("src/lib/offline-queue.ts");
    const send = source.match(/async function send\([\s\S]*?\nlet draining = false;/)![0];
    const hook = send.match(/if \(item\.kind === "equipment_place"[^\n]*\n[^\n]*\n[^\n]*\n/)![0];
    expect(hook).toContain(`item.kind === "drying_reset"`);
    expect(hook).toContain("scheduleAutomaticTaskSync(jobId, scope.ownerId)");
  });

  it("the Tasks tab offers remediation once and uses the one shared reset", () => {
    const tab = read("src/components/job-tasks-tab.tsx");
    expect(tab).not.toMatch(/resetWaterDryingWindow/);
    expect(tab.match(/<DryingClockCard jobId=\{jobId\}[^>]*\/>/)).not.toBeNull();
    const button = tab.match(/\{!additionalWorkPending && \([\s\S]*?<\/Button>/)![0];
    expect(button).toContain("Add remediation tasks");
  });

  it("the reset dialog no longer promises to leave the dates alone", () => {
    const card = read("src/components/drying-clock-card.tsx");
    const note = card.match(/<p\s+data-reset-moves-dates[\s\S]*?<\/p>/)![0];
    expect(note).toContain("expected back 72 hours from now");
    expect(card).not.toMatch(/are not changed/);
  });

  it("a saved field ticket reconciles the checklist, since it can raise the remediation flag", () => {
    const page = read("src/routes/_authenticated/jobs.$id.tsx");
    const ticket = page.match(/<FieldWorkTicketPanel[\s\S]*?\/>/)![0];
    expect(ticket).toContain("onSaved={() => void syncScopeTasks()}");
  });
});
