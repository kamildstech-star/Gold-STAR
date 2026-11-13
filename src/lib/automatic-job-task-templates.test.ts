/**
 * The checklist lines as data — Mark, shown the Supply catalog: "like this
 * for tasks" — and what an edit in Settings does to jobs already carrying the
 * list. `automatic-job-tasks.test.ts` stays the spec for Mark's wording and
 * order; this file is the spec for the table, the switches, the ledger of
 * deleted tasks, and the SQL backfill agreeing with the TypeScript planner.
 *
 * Every date is passed in. Nothing here reads the clock.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BUILT_IN_TASK_CATALOG,
  TASK_GROUPS,
  automaticCadenceKey,
  automaticScopeTypeFor,
  automaticTaskGroupLabel,
  buildAutomaticTaskSyncPlan,
  catalogFromRows,
  equipmentTasksSeedOn,
  loadTaskCatalog,
  resolveScopeKey,
  sectionsFromRows,
  sortTasksByChecklist,
  type AutomaticTaskContext,
  type CustomSection,
  type ExistingAutomaticTask,
  type JobTaskTemplateRow,
  type TaskCatalog,
  type TaskGroupKey,
} from "./automatic-job-tasks";
import { DRYING_WINDOW_HOURS } from "./drying-clock";
import { OPEN_JOB_STATUSES } from "./jobs";

const JOB = "00000000-0000-4000-8000-0000000000aa";
const TODAY = "2026-09-04";
const MIGRATION = readFileSync(
  "supabase/migrations/20261006174500_job_task_templates.sql",
  "utf8",
).replace(/\r\n/g, "\n");
/** The newest definition of the backfill's candidate list, and the type helper it reads. */
const SECTIONS_MIGRATION = readFileSync(
  "supabase/migrations/20261013122000_job_checklist_sections.sql",
  "utf8",
).replace(/\r\n/g, "\n");

function context(overrides: Partial<AutomaticTaskContext> = {}): AutomaticTaskContext {
  return {
    jobId: JOB,
    lossTypeKey: "water_mitigation",
    additionalRemediationRequired: false,
    equipmentAdded: false,
    syncDate: TODAY,
    ...overrides,
  };
}

/** The built-in catalog as table rows, the way the migration seeds them. */
function rowsOf(catalog: TaskCatalog): JobTaskTemplateRow[] {
  return TASK_GROUPS.flatMap((group) =>
    catalog.tasks[group.key].map((task, i) => ({
      id: `${group.key}:${task.key}`,
      group_key: group.key,
      task_key: task.key,
      title: task.title,
      description: task.description ?? null,
      sort_order: (i + 1) * 10,
      active: task.active,
    })),
  );
}

function edit(
  mutate: (tasks: Record<TaskGroupKey, ReturnType<typeof copyTasks>[number][]>) => void,
  seeding = BUILT_IN_TASK_CATALOG.equipmentSeeding,
): TaskCatalog {
  const tasks = Object.fromEntries(
    TASK_GROUPS.map((g) => [g.key, copyTasks(BUILT_IN_TASK_CATALOG.tasks[g.key])]),
  ) as Record<TaskGroupKey, ReturnType<typeof copyTasks>>;
  mutate(tasks);
  return { tasks, equipmentSeeding: { ...seeding } };
}
const copyTasks = (list: TaskCatalog["tasks"][TaskGroupKey]) => list.map((t) => ({ ...t }));

function rowsFromPlan(plan: ReturnType<typeof buildAutomaticTaskSyncPlan>, status = "open") {
  return plan.insert.map((task, i): ExistingAutomaticTask => ({
    id: `t-${i}`,
    status,
    source: task.source,
    cadenceKey: task.cadenceKey,
    dueDate: task.dueDate,
    title: task.title,
  }));
}

describe("the migration seeds exactly the lists that are compiled in", () => {
  // ('group', 'key', 'Title', NULL | 'desc', 10)
  const tuple =
    /\('([a-z_]+)', '([a-z0-9_]+)', '((?:[^']|'')*)',\s*(NULL|'(?:[^']|'')*'),\s*(\d+)\)/g;
  const seeded = [...MIGRATION.matchAll(tuple)].map((m) => ({
    group: m[1]!,
    key: m[2]!,
    title: m[3]!.replace(/''/g, "'"),
    description: m[4] === "NULL" ? null : m[4]!.slice(1, -1).replace(/''/g, "'"),
    order: Number(m[5]),
  }));

  it("line for line, in Mark's order, with the one description", () => {
    for (const group of TASK_GROUPS) {
      const fromSql = seeded
        .filter((row) => row.group === group.key)
        .sort((a, b) => a.order - b.order)
        .map(({ key, title, description }) => ({ key, title, description }));
      const compiled = BUILT_IN_TASK_CATALOG.tasks[group.key].map(
        ({ key, title, description }) => ({ key, title, description: description ?? null }),
      );
      expect(fromSql, group.key).toEqual(compiled);
    }
    expect(seeded).toHaveLength(53);
  });

  it("and seeding from those rows plans what the compiled lists plan", () => {
    const fromTable = catalogFromRows(rowsOf(BUILT_IN_TASK_CATALOG), []);
    const full = context({ additionalRemediationRequired: true, equipmentAdded: true });
    for (const loss of ["water_mitigation", "mold_remediation", "fire_smoke_cleaning"]) {
      const c = { ...full, lossTypeKey: loss };
      expect(buildAutomaticTaskSyncPlan(c, [], { catalog: fromTable })).toEqual(
        buildAutomaticTaskSyncPlan(c, []),
      );
    }
  });
});

describe("catalogFromRows", () => {
  it("orders by sort order, ignores an unknown group, and reads a missing switch as on", () => {
    const catalog = catalogFromRows(
      [
        {
          id: "2",
          group_key: "fire_smoke",
          task_key: "b",
          title: "Second",
          description: null,
          sort_order: 20,
          active: true,
        },
        {
          id: "1",
          group_key: "fire_smoke",
          task_key: "a",
          title: "First",
          description: null,
          sort_order: 10,
          active: false,
        },
        {
          id: "x",
          group_key: "roofing",
          task_key: "z",
          title: "Not ours",
          description: null,
          sort_order: 1,
          active: true,
        },
      ],
      [{ job_scope: "fire_smoke", seed_equipment_tasks: false }],
    );
    expect(catalog.tasks.fire_smoke.map((t) => [t.title, t.active])).toEqual([
      ["First", false],
      ["Second", true],
    ]);
    expect(catalog.tasks.water_extraction).toEqual([]);
    expect(catalog.equipmentSeeding).toEqual({ water: true, mold: true, fire_smoke: false });
  });
});

describe('Mark: "for now yes, but make a way for him to disable it in the admin"', () => {
  const placed = {
    equipmentAdded: true,
    equipmentOnSite: true,
    dryingWindowEndsOn: "2026-09-07",
    retrievalDueOn: "2026-09-08",
  };
  const groupsIn = (plan: ReturnType<typeof buildAutomaticTaskSyncPlan>) =>
    [...new Set(plan.insert.map((t) => t.source))].sort();

  it("defaults on: Mold and Fire jobs with gear get Monitoring and Pick up", () => {
    for (const loss of ["mold_remediation", "fire_smoke_cleaning"]) {
      const plan = buildAutomaticTaskSyncPlan(context({ lossTypeKey: loss, ...placed }), []);
      expect(groupsIn(plan)).toContain("job_scope:water_monitoring");
      expect(groupsIn(plan)).toContain("job_scope:water_pickup");
    }
  });

  it("switched off for Mold: a mold job gets its own list and no equipment groups; Fire is untouched", () => {
    const catalog = edit(() => undefined, { water: true, mold: false, fire_smoke: true });
    const mold = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "mold", ...placed }), [], {
      catalog,
    });
    expect(groupsIn(mold)).toEqual(["job_scope:mold_remediation"]);
    const fire = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "fire", ...placed }), [], {
      catalog,
    });
    expect(groupsIn(fire)).toContain("job_scope:water_monitoring");
  });

  it("switching it off does not retire the Monitoring tasks a mold job already has", () => {
    const before = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "mold", ...placed }), []);
    const rows = rowsFromPlan(before);
    const after = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "mold", ...placed }), rows, {
      catalog: edit(() => undefined, { water: true, mold: false, fire_smoke: false }),
    });
    expect(after.cancelIds).toEqual([]);
    expect(after.insert).toEqual([]);
  });

  it('Water has a switch too — Mark, 13 Oct: "let him turn off drying log"', () => {
    const all = { water: true, mold: true, fire_smoke: true };
    expect(equipmentTasksSeedOn("water", all)).toBe(true);
    expect(equipmentTasksSeedOn("water", { ...all, water: false })).toBe(false);
    expect(equipmentTasksSeedOn("mold", { ...all, water: false })).toBe(true);
    expect(equipmentTasksSeedOn(null, all)).toBe(false);
  });

  it("switched off for Water: a water job with gear gets Extraction only, and keeps what it had", () => {
    const catalog = edit(() => undefined, { water: false, mold: true, fire_smoke: true });
    const fresh = buildAutomaticTaskSyncPlan(context(placed), [], { catalog });
    expect(groupsIn(fresh)).toEqual(["job_scope:water_extraction"]);

    const before = buildAutomaticTaskSyncPlan(context(placed), []);
    const after = buildAutomaticTaskSyncPlan(context(placed), rowsFromPlan(before), { catalog });
    expect(after.cancelIds).toEqual([]);
    expect(after.insert).toEqual([]);
    // Still re-dated with the drying window: the tasks are on the job.
    const moved = buildAutomaticTaskSyncPlan(
      context({ ...placed, dryingWindowEndsOn: "2026-09-10" }),
      rowsFromPlan(before),
      { catalog },
    );
    expect(moved.dueDateUpdates.length).toBe(3);
  });

  it("a missing Water switch row reads as on — today's behavior until the migration", () => {
    expect(catalogFromRows([], []).equipmentSeeding.water).toBe(true);
    expect(
      catalogFromRows([], [{ job_scope: "water", seed_equipment_tasks: false }]).equipmentSeeding
        .water,
    ).toBe(false);
  });
});

describe('"these dont show up in the job" — the job type is read however it is spelled', () => {
  it("the label the office picked, the option key and the legacy value are one type", () => {
    for (const v of [
      "Water Mitigation",
      "water_mitigation",
      "water",
      " WATER ",
      "water-mitigation",
    ])
      expect(automaticScopeTypeFor(v), v).toBe("water");
    expect(automaticScopeTypeFor("Fire & Smoke Cleaning")).toBe("fire_smoke");
    expect(automaticScopeTypeFor("Mold Remediation")).toBe("mold");
    expect(automaticScopeTypeFor("Sewer / Category 3")).toBeNull();
    expect(automaticScopeTypeFor(null)).toBeNull();
  });

  it("a job whose legacy loss_type was left NULL still gets its checklists from the picked option", () => {
    // trg_sync_loss_type leaves jobs.loss_type NULL when the option's key is
    // one enum_for_loss_type_key does not know: before, no checklists at all.
    const picked = resolveScopeKey(null, { key: "water_mitigation_2", label: "Water Mitigation" });
    expect(picked).toBe("Water Mitigation");
    const placed = {
      equipmentAdded: true,
      equipmentOnSite: true,
      dryingWindowEndsOn: "2026-09-07",
    };
    const before = buildAutomaticTaskSyncPlan(context({ lossTypeKey: null, ...placed }), []);
    expect(before.insert).toEqual([]);
    const after = buildAutomaticTaskSyncPlan(context({ lossTypeKey: picked, ...placed }), []);
    expect([...new Set(after.insert.map((t) => t.source))]).toEqual([
      "job_scope:water_extraction",
      "job_scope:water_monitoring",
      "job_scope:water_pickup",
    ]);
  });

  it("the reconcile reads the picked option when the legacy value does not map", () => {
    const src = readFileSync("src/lib/automatic-job-tasks.ts", "utf8").replace(/\r\n/g, "\n");
    const sync = src.match(/export async function syncAutomaticJobTasksForJob[\s\S]*?\n}\n/)![0];
    expect(sync).toContain("loss_type, loss_type_id,");
    expect(sync).toContain("const lossTypeKey = await readScopeKey(job);");
    expect(sync).toMatch(/\n\s+lossTypeKey,\n/);
    const read = src.match(/async function readScopeKey[\s\S]*?\n}\n/)![0];
    expect(read).toContain('.from("option_list_values")');
    // A failed read must not look like "no type": that would retire the list.
    expect(read).toContain("if (error) throw error;");
  });

  it("the legacy value wins when it maps; an unmappable job stays unmapped", () => {
    expect(resolveScopeKey("water", { key: "mold_remediation", label: "Mold" })).toBe("water");
    expect(resolveScopeKey("sewer", { key: "sewer_cat3", label: "Sewer / Category 3" })).toBe(
      "sewer",
    );
    expect(resolveScopeKey(null, null)).toBeNull();
  });
});

describe('Mark, 13 Oct: "also let him make a new section if he wants"', () => {
  const section = (over: Partial<CustomSection> = {}): CustomSection => ({
    key: "s_contents",
    label: "Contents",
    addedWhen: "job_type",
    due: "sync",
    jobScopes: ["water"],
    active: true,
    sortOrder: 10,
    tasks: [
      { key: "t_aaaaaaaaaaaa", title: "Photograph contents", active: true },
      { key: "t_bbbbbbbbbbbb", title: "Pack-out list", active: true },
      { key: "t_cccccccccccc", title: "Old line", active: false },
    ],
    ...over,
  });
  const withSections = (...sections: CustomSection[]): TaskCatalog => ({
    ...BUILT_IN_TASK_CATALOG,
    sections,
  });
  const sourcesOf = (plan: ReturnType<typeof buildAutomaticTaskSyncPlan>) => [
    ...new Set(plan.insert.map((t) => t.source)),
  ];

  it("a job-type section goes on every job of its types, its active lines only, labeled by name", () => {
    const catalog = withSections(section());
    const plan = buildAutomaticTaskSyncPlan(context(), [], { catalog });
    const mine = plan.insert.filter((t) => t.source === "job_scope:s_contents");
    expect(mine.map((t) => t.title)).toEqual(["Photograph contents", "Pack-out list"]);
    expect(mine[0]!.cadenceKey).toBe(automaticCadenceKey(JOB, "s_contents", "t_aaaaaaaaaaaa"));
    expect(mine[0]!.description).toBe("Automatically generated from the Contents checklist.");
    expect(mine[0]!.dueDate).toBe(TODAY);
    const mold = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "mold" }), [], { catalog });
    expect(sourcesOf(mold)).not.toContain("job_scope:s_contents");
  });

  it("an equipment section waits for a unit on site and takes the chosen due rule", () => {
    const catalog = withSections(
      section({ addedWhen: "equipment", due: "retrieval", jobScopes: ["mold", "water"] }),
    );
    const none = buildAutomaticTaskSyncPlan(context({ lossTypeKey: "mold" }), [], { catalog });
    expect(sourcesOf(none)).toEqual(["job_scope:mold_remediation"]);
    const gear = buildAutomaticTaskSyncPlan(
      context({
        lossTypeKey: "mold",
        equipmentAdded: true,
        equipmentOnSite: true,
        dryingWindowEndsOn: "2026-09-07",
        retrievalDueOn: "2026-09-09",
      }),
      [],
      { catalog },
    );
    const mine = gear.insert.filter((t) => t.source === "job_scope:s_contents");
    expect(mine).toHaveLength(2);
    expect(mine.every((t) => t.dueDate === "2026-09-09")).toBe(true);
  });

  it("an additional-work section waits for the remediation flag", () => {
    const catalog = withSections(section({ addedWhen: "additional_work" }));
    expect(sourcesOf(buildAutomaticTaskSyncPlan(context(), [], { catalog }))).not.toContain(
      "job_scope:s_contents",
    );
    expect(
      sourcesOf(
        buildAutomaticTaskSyncPlan(context({ additionalRemediationRequired: true }), [], {
          catalog,
        }),
      ),
    ).toContain("job_scope:s_contents");
  });

  it("switched off: adds nothing new, retires nothing, still renames", () => {
    const first = buildAutomaticTaskSyncPlan(context(), [], { catalog: withSections(section()) });
    const rows = rowsFromPlan(first);
    const off = section({
      active: false,
      tasks: [{ key: "t_aaaaaaaaaaaa", title: "Photograph every room's contents", active: true }],
    });
    const plan = buildAutomaticTaskSyncPlan(context(), rows, { catalog: withSections(off) });
    expect(plan.insert).toEqual([]);
    expect(plan.cancelIds).toEqual([]);
    expect(plan.titleUpdates.map((u) => u.title)).toEqual(["Photograph every room's contents"]);
    const elsewhere = buildAutomaticTaskSyncPlan(context({ jobId: "another" }), [], {
      catalog: withSections(off),
    });
    expect(sourcesOf(elsewhere)).toEqual(["job_scope:water_extraction"]);
  });

  it("never twice: a second reconcile, or a deleted line, adds nothing", () => {
    const catalog = withSections(section());
    const first = buildAutomaticTaskSyncPlan(context(), [], { catalog });
    expect(buildAutomaticTaskSyncPlan(context(), rowsFromPlan(first), { catalog }).insert).toEqual(
      [],
    );
    const rows = rowsFromPlan(first).filter((r) => !r.cadenceKey!.endsWith(":t_aaaaaaaaaaaa"));
    const seededKeys = new Set(first.insert.map((t) => t.cadenceKey));
    expect(buildAutomaticTaskSyncPlan(context(), rows, { catalog, seededKeys }).insert).toEqual([]);
  });

  it("built-in sections plan exactly as before when David has sections of his own", () => {
    const full = context({ additionalRemediationRequired: true, equipmentAdded: true });
    const catalog = withSections(section({ jobScopes: ["fire_smoke"] }));
    for (const loss of ["water_mitigation", "mold_remediation"]) {
      const c = { ...full, lossTypeKey: loss };
      expect(buildAutomaticTaskSyncPlan(c, [], { catalog })).toEqual(
        buildAutomaticTaskSyncPlan(c, []),
      );
    }
  });

  it("rows become sections: built-in and malformed rows skipped, in David's order, lines attached", () => {
    const base = { builtin: false, added_when: "job_type", due_rule: "sync", active: true };
    const sections = sectionsFromRows(
      [
        { ...base, key: "s_b", label: "Second", job_scopes: ["mold"], sort_order: 20 },
        { ...base, key: "s_a", label: "First", job_scopes: ["water", "roofing"], sort_order: 10 },
        {
          ...base,
          key: "water_extraction",
          label: "Water",
          builtin: true,
          job_scopes: ["water"],
          sort_order: 1,
        },
        {
          ...base,
          key: "s_bad",
          label: "Bad",
          added_when: "status",
          job_scopes: ["water"],
          sort_order: 5,
        },
      ],
      [
        {
          id: "1",
          group_key: "s_a",
          task_key: "y",
          title: "Y",
          description: null,
          sort_order: 20,
          active: true,
        },
        {
          id: "2",
          group_key: "s_a",
          task_key: "x",
          title: "X",
          description: null,
          sort_order: 10,
          active: false,
        },
        {
          id: "3",
          group_key: "fire_smoke",
          task_key: "z",
          title: "Z",
          description: null,
          sort_order: 10,
          active: true,
        },
      ],
    );
    expect(sections.map((s) => s.key)).toEqual(["s_a", "s_b"]);
    expect(sections[0]!.jobScopes).toEqual(["water"]);
    expect(sections[0]!.tasks.map((t) => [t.title, t.active])).toEqual([
      ["X", false],
      ["Y", true],
    ]);
  });

  it("the Tasks tab badge names the section, and lists it after the built-in ones", () => {
    const catalog = withSections(section());
    expect(automaticTaskGroupLabel("job_scope:s_contents", catalog)).toBe("Contents");
    expect(automaticTaskGroupLabel("job_scope:water_pickup", catalog)).toBe("Pick up equipment");
    expect(automaticTaskGroupLabel("job_scope:s_gone")).toBe("Automatic scope");
    const row = (id: string, group: string, task: string) => ({
      id,
      due_date: TODAY,
      source: `job_scope:${group}`,
      cadence_key: automaticCadenceKey(JOB, group, task),
    });
    const sorted = sortTasksByChecklist(
      [
        row("pack", "s_contents", "t_bbbbbbbbbbbb"),
        row("photo", "s_contents", "t_aaaaaaaaaaaa"),
        row("fire", "fire_smoke", "inspection"),
      ],
      catalog,
    );
    expect(sorted.map((r) => r.id)).toEqual(["fire", "photo", "pack"]);
  });
});

describe("editing a line later", () => {
  const water = () => buildAutomaticTaskSyncPlan(context(), []);

  it("a rename renames open tasks and leaves ticked ones in the words they were ticked under", () => {
    const rows = rowsFromPlan(water());
    const pictures = rows.find((r) => r.cadenceKey!.endsWith(":water_extraction:pictures"))!;
    const readings = rows.find((r) => r.cadenceKey!.endsWith(":water_extraction:readings"))!;
    readings.status = "done";
    const catalog = edit((t) => {
      t.water_extraction.find((x) => x.key === "pictures")!.title = "Photos – every room";
      t.water_extraction.find((x) => x.key === "readings")!.title = "Moisture readings";
    });
    const plan = buildAutomaticTaskSyncPlan(context(), rows, { catalog });
    expect(plan.titleUpdates).toEqual([{ id: pictures.id, title: "Photos – every room" }]);
    expect(plan.insert).toEqual([]);
  });

  it("a new line is added to a job that already has the list, after the others", () => {
    const rows = rowsFromPlan(water());
    const catalog = edit((t) => {
      t.water_extraction.push({ key: "t_moisturemap", title: "Moisture map", active: true });
    });
    const plan = buildAutomaticTaskSyncPlan(context(), rows, { catalog });
    expect(plan.insert.map((t) => t.cadenceKey)).toEqual([
      automaticCadenceKey(JOB, "water_extraction", "t_moisturemap"),
    ]);
    expect(plan.insert[0]!.dueDate).toBe(TODAY);
  });

  it("a deactivated line stops seeding, and the task already on the job stays open", () => {
    const rows = rowsFromPlan(water());
    const catalog = edit((t) => {
      t.water_extraction.find((x) => x.key === "scope_if_needed")!.active = false;
    });
    const fresh = buildAutomaticTaskSyncPlan(context({ jobId: "other-job" }), [], { catalog });
    expect(fresh.insert.map((t) => t.title)).not.toContain("Scope of work – if needed");
    const existing = buildAutomaticTaskSyncPlan(context(), rows, { catalog });
    expect(existing.cancelIds).toEqual([]);
    expect(existing.insert).toEqual([]);
  });

  it("a switched-off line is not reopened when a type flip comes back round", () => {
    const rows = rowsFromPlan(water(), "cancelled");
    const catalog = edit((t) => {
      t.water_extraction.find((x) => x.key === "pictures")!.active = false;
    });
    const plan = buildAutomaticTaskSyncPlan(context(), rows, { catalog });
    expect(plan.reopenIds).toHaveLength(5);
  });
});

describe("a deleted task stays deleted", () => {
  it("a key the job once carried is not re-inserted", () => {
    const first = water();
    const rows = rowsFromPlan(first);
    const gone = rows.splice(
      rows.findIndex((r) => r.cadenceKey!.endsWith(":scope_if_needed")),
      1,
    )[0]!;
    const seededKeys = new Set(first.insert.map((t) => t.cadenceKey));
    expect(buildAutomaticTaskSyncPlan(context(), rows).insert).toHaveLength(1);
    const plan = buildAutomaticTaskSyncPlan(context(), rows, { seededKeys });
    expect(plan.insert).toEqual([]);
    expect(gone.title).toBe("Scope of work – if needed");
  });

  function water() {
    return buildAutomaticTaskSyncPlan(context(), []);
  }
});

describe("retroactive reconcile rules", () => {
  it("equipment groups are only added while a unit is on site, and kept after pickup", () => {
    const dates = { equipmentAdded: true, dryingWindowEndsOn: "2026-09-07", retrievalDueOn: null };
    const back = buildAutomaticTaskSyncPlan(context({ ...dates, equipmentOnSite: false }), []);
    expect(back.insert.every((t) => t.source === "job_scope:water_extraction")).toBe(true);

    const seeded = buildAutomaticTaskSyncPlan(context({ ...dates, equipmentOnSite: true }), []);
    const later = buildAutomaticTaskSyncPlan(
      context({ ...dates, equipmentOnSite: false, dryingWindowEndsOn: "2026-09-12" }),
      rowsFromPlan(seeded),
    );
    expect(later.cancelIds).toEqual([]);
    expect(later.insert).toEqual([]);
    expect(later.dueDateUpdates.length).toBeGreaterThan(0);
  });

  it("a closed job changes nothing at all", () => {
    const plan = buildAutomaticTaskSyncPlan(
      context({ jobClosed: true, additionalRemediationRequired: true, equipmentAdded: true }),
      [],
    );
    expect(plan).toEqual({
      insert: [],
      reopenIds: [],
      cancelIds: [],
      dueDateUpdates: [],
      titleUpdates: [],
    });
  });
});

describe("the catalog read falls back only when the table is missing", () => {
  const client = (error: { code?: string; message: string } | null) =>
    ({
      from: () => ({
        select: () => Promise.resolve(error ? { data: null, error } : { data: [], error: null }),
      }),
    }) as never;

  it("migration not applied: the compiled lists", async () => {
    const catalog = await loadTaskCatalog(
      client({ code: "PGRST205", message: "Could not find the table in the schema cache" }),
    );
    expect(catalog.fromDatabase).toBe(false);
    expect(catalog.tasks).toEqual(BUILT_IN_TASK_CATALOG.tasks);
  });

  it("any other failure throws, so a blip never renames tasks back over David's edits", async () => {
    await expect(
      loadTaskCatalog(client({ code: "08006", message: "connection lost" })),
    ).rejects.toMatchObject({ code: "08006" });
  });

  it("an applied, empty table is an empty checklist, not the fallback", async () => {
    const catalog = await loadTaskCatalog(client(null));
    expect(catalog.fromDatabase).toBe(true);
    expect(catalog.tasks.water_extraction).toEqual([]);
  });
});

describe("the SQL backfill mirrors the planner (newest definition, 20261013122000)", () => {
  const definitions = [MIGRATION, SECTIONS_MIGRATION].flatMap((sql) => [
    ...sql.matchAll(
      /CREATE OR REPLACE FUNCTION public\.job_automatic_task_candidates[\s\S]*?\n\$\$;/g,
    ),
  ]);
  const candidates = definitions.at(-1)![0];
  const scopeOf = SECTIONS_MIGRATION.match(
    /CREATE OR REPLACE FUNCTION public\.job_checklist_scope_of[\s\S]*?\n\$\$;/,
  )![0];

  it("the newest migration carries the definition the app is mirrored against", () => {
    expect(definitions).toHaveLength(2);
    expect(SECTIONS_MIGRATION).toContain(candidates);
  });

  it("open means OPEN_JOB_STATUSES", () => {
    const statuses = candidates.match(/j\.status::text IN \(([^)]*)\)/)![1]!;
    expect(statuses.match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1))).toEqual(OPEN_JOB_STATUSES);
  });

  it("reads the type from loss_type, then the picked option's key, then its label", () => {
    expect(candidates).toContain(
      "public.job_checklist_scope(j.loss_type, v.key, v.label) AS scope",
    );
    expect(candidates).toContain("LEFT JOIN public.option_list_values v ON v.id = j.loss_type_id");
  });

  it("maps service categories the way automaticScopeTypeFor does, after the same normalizing", () => {
    const pairs = [...scopeOf.matchAll(/WHEN '([a-z_]+)' THEN '(water|mold|fire_smoke)'/g)];
    expect(pairs.length).toBe(7);
    for (const [, key, scope] of pairs) expect(automaticScopeTypeFor(key)).toBe(scope);
    expect(scopeOf).toContain(
      "btrim(regexp_replace(lower(coalesce(_value, '')), '[^a-z0-9]+', '_', 'g'), '_')",
    );
  });

  it("labels each built-in group as TASK_GROUPS does, and a custom one by its label", () => {
    for (const group of TASK_GROUPS) {
      expect(candidates).toContain(`WHEN '${group.key}' THEN '${group.label}'`);
    }
    expect(candidates).toContain("END, sec.label, s.group_key)");
  });

  it("dates by due rule: the drying clock's window, then expected retrieval", () => {
    expect(candidates).toContain(`interval '${DRYING_WINDOW_HOURS} hours'`);
    expect(candidates).toContain("CASE g.due_rule");
    for (const g of TASK_GROUPS) {
      if (g.due === "sync") continue;
      expect(candidates).toContain(`('${g.key}', '${g.due}')`);
    }
  });

  it("seeds equipment groups only with a unit on site and only where the switch allows — Water included", () => {
    const lateral = candidates.match(/CROSS JOIN LATERAL \([\s\S]*?\) g/)![0];
    expect(lateral).toContain("coalesce(e.on_site, false)");
    expect(lateral).toMatch(/o\.scope = 'water' AND sw\.water/);
    expect(lateral).toMatch(/o\.scope = 'mold' AND sw\.mold/);
    expect(lateral).toMatch(/o\.scope = 'fire_smoke' AND sw\.fire_smoke/);
    expect(lateral).toMatch(
      /'water_remediation', 'sync' WHERE o\.scope = 'water' AND o\.additional_work_pending/,
    );
  });

  it("adds David's active sections by their own types and trigger, like sectionTriggered", () => {
    const lateral = candidates.match(/CROSS JOIN LATERAL \([\s\S]*?\) g/)![0];
    expect(lateral).toContain("WHERE NOT c.builtin AND c.active");
    expect(lateral).toContain("o.scope = ANY (c.job_scopes)");
    expect(lateral).toContain("c.added_when = 'job_type'");
    expect(lateral).toContain("(c.added_when = 'additional_work' AND o.additional_work_pending)");
    expect(lateral).toContain("(c.added_when = 'equipment' AND coalesce(e.on_site, false))");
  });

  it("the built-in section rows say what TASK_GROUPS says", () => {
    for (const g of TASK_GROUPS) {
      const row = new RegExp(
        `\\('${g.key}', '${g.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}', true, '${g.trigger}', '${g.due}'`,
      );
      expect(SECTIONS_MIGRATION, g.key).toMatch(row);
    }
  });

  it("dry run is the default", () => {
    expect(MIGRATION).toMatch(/sync_job_automatic_tasks\(\n\s+_dry_run boolean DEFAULT true,/);
  });
});
