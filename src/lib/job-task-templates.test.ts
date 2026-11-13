/**
 * Settings › Operations › Job checklists. Mark, with a screenshot of the
 * Supply catalog: "like this for tasks". Pure helpers first, then the wiring,
 * read from source (there is no DOM testing library here, by choice).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BUILT_IN_TASK_CATALOG,
  TASK_GROUPS,
  sortTasksByChecklist,
  type JobTaskTemplateRow,
} from "./automatic-job-tasks";
import { SETTINGS_PAGES, SETTINGS_SECTION_LAYOUT } from "./admin-settings";
import { pageForPath } from "./page-access";
import {
  GROUP_WHEN,
  SECTION_ADDED_WHEN,
  SECTION_DUE,
  describeDryRun,
  describeEditSync,
  describeFullSync,
  describeSectionWhen,
  newSectionProblem,
  nextSortOrder,
  reorderPatches,
  rowsForGroup,
  sectionOrderRows,
  type NewSection,
  type SyncReport,
} from "./job-task-templates";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const row = (id: string, sort: number, extra: Partial<JobTaskTemplateRow> = {}) =>
  ({
    id,
    group_key: "fire_smoke",
    task_key: id,
    title: id,
    description: null,
    sort_order: sort,
    active: true,
    ...extra,
  }) satisfies JobTaskTemplateRow;

const report = (over: Partial<SyncReport> = {}): SyncReport => ({
  dry_run: true,
  only_seeded_groups: false,
  open_jobs: 40,
  jobs_gaining_tasks: 0,
  tasks_added: 0,
  tasks_renamed: 0,
  added_by_group: {},
  added_already_overdue: 0,
  skipped_previously_deleted: 0,
  ...over,
});

describe("reordering, on a phone as on a desk", () => {
  const list = [row("a", 10), row("b", 20), row("c", 30)];

  it("moving a line up swaps it with the one above — two writes", () => {
    expect(reorderPatches(list, "c", "up")).toEqual([
      { id: "c", sort_order: 20 },
      { id: "b", sort_order: 30 },
    ]);
  });

  it("the ends do nothing", () => {
    expect(reorderPatches(list, "a", "up")).toEqual([]);
    expect(reorderPatches(list, "c", "down")).toEqual([]);
    expect(reorderPatches(list, "nope", "down")).toEqual([]);
  });

  it("still moves when two lines share a number", () => {
    const tied = [row("a", 10), row("b", 10), row("c", 10)];
    const patches = reorderPatches(tied, "a", "down");
    const after = tied
      .map((r) => ({
        ...r,
        sort_order: patches.find((p) => p.id === r.id)?.sort_order ?? r.sort_order,
      }))
      .sort((x, y) => x.sort_order - y.sort_order);
    expect(after.map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("a new line goes to the bottom; a group lists in seeding order", () => {
    expect(nextSortOrder(list)).toBe(40);
    expect(nextSortOrder([])).toBe(10);
    const mixed = [row("z", 20), row("y", 10), row("x", 10, { group_key: "mold_remediation" })];
    expect(rowsForGroup(mixed, "fire_smoke").map((r) => r.id)).toEqual(["y", "z"]);
  });
});

describe("what the screen tells David", () => {
  it("an edit that touched open jobs says how many", () => {
    expect(describeEditSync(report({ tasks_renamed: 1 }))).toBe("Renamed 1 open task.");
    expect(
      describeEditSync(report({ tasks_renamed: 3, tasks_added: 4, jobs_gaining_tasks: 4 })),
    ).toBe("Renamed 3 open tasks and added 4 tasks to 4 open jobs.");
    expect(describeEditSync(report())).toBeNull();
  });

  it("the dry run reads out the full backfill without running it", () => {
    expect(describeDryRun(report())).toBe("All 40 open jobs already have their checklists.");
    const text = describeDryRun(
      report({
        tasks_added: 91,
        jobs_gaining_tasks: 6,
        added_by_group: { water_extraction: 18, water_monitoring: 9 },
        added_already_overdue: 24,
        skipped_previously_deleted: 1,
      }),
    );
    expect(text).toContain(
      "91 tasks missing on 6 open jobs (of 40): Water · Extraction 18 · Monitoring 9.",
    );
    expect(text).toContain("24 would arrive already overdue.");
    expect(text).toContain("1 deleted task left deleted.");
  });

  it("every group explains when it goes on a job", () => {
    for (const g of TASK_GROUPS) expect(GROUP_WHEN[g.key].length).toBeGreaterThan(20);
  });
});

describe("new sections, in the screen's words", () => {
  it("a section's card says which jobs, when it goes on and when it is due", () => {
    expect(
      describeSectionWhen({
        jobScopes: ["water", "mold"],
        addedWhen: "equipment",
        due: "retrieval",
      }),
    ).toBe(
      "Whenever equipment is placed on Water Mitigation, Mold Remediation jobs. Due on the date the equipment is expected back.",
    );
    expect(
      describeSectionWhen({ jobScopes: ["fire_smoke"], addedWhen: "job_type", due: "sync" }),
    ).toBe(
      "On every Fire & Smoke Cleaning job, from the moment it is created or changed to that type. Due the day it goes on.",
    );
  });

  it("offers only the triggers and due rules the built-in sections already have", () => {
    expect(SECTION_ADDED_WHEN.map((o) => o.value).sort()).toEqual(
      [...new Set(TASK_GROUPS.map((g) => g.trigger))].sort(),
    );
    expect(SECTION_DUE.map((o) => o.value).sort()).toEqual(
      [...new Set(TASK_GROUPS.map((g) => g.due))].sort(),
    );
  });

  it("a section needs a name and a job type", () => {
    const ok: NewSection = {
      label: "Contents",
      jobScopes: ["water"],
      addedWhen: "job_type",
      due: "sync",
    };
    expect(newSectionProblem(ok)).toBeNull();
    expect(newSectionProblem({ ...ok, label: "  " })).toMatch(/name/);
    expect(newSectionProblem({ ...ok, jobScopes: [] })).toMatch(/job type/);
  });

  it("sections reorder like lines", () => {
    const rows = sectionOrderRows([
      { key: "s_a", sortOrder: 10 },
      { key: "s_b", sortOrder: 20 },
    ]);
    expect(reorderPatches(rows, "s_b", "up")).toEqual([
      { id: "s_b", sort_order: 10 },
      { id: "s_a", sort_order: 20 },
    ]);
  });

  it("the count names David's sections, and the full pass says what it did", () => {
    expect(
      describeDryRun(
        report({ tasks_added: 4, jobs_gaining_tasks: 2, added_by_group: { s_a: 4 } }),
        [{ key: "s_a", label: "Contents" }],
      ),
    ).toBe("4 tasks missing on 2 open jobs (of 40): Contents 4.");
    expect(describeFullSync(report({ dry_run: false }))).toMatch(/Nothing was missing/);
    expect(
      describeFullSync(report({ dry_run: false, tasks_added: 8, jobs_gaining_tasks: 3 })),
    ).toBe("Added 8 tasks to 3 open jobs.");
  });
});

describe("the Tasks tab lists each checklist in the order set here", () => {
  const JOB = "00000000-0000-4000-8000-000000000001";
  const t = (id: string, due: string | null, source: string, taskKey: string | null) => ({
    id,
    due_date: due,
    source,
    cadence_key: taskKey ? `job-scope:${JOB}:${source.slice(10)}:${taskKey}` : null,
  });

  it("same day: checklist order, groups in their order, manual tasks after; dates still lead", () => {
    const rows = [
      t("manual", "2026-09-04", "manual", null),
      t("pictures", "2026-09-04", "job_scope:water_extraction", "pictures"),
      t("readings", "2026-09-04", "job_scope:water_extraction", "readings"),
      t("monitor", "2026-09-07", "job_scope:water_monitoring", "readings"),
      t("inspection", "2026-09-04", "job_scope:water_extraction", "inspection"),
      t("undated", null, "manual", null),
      t("earlier", "2026-09-01", "manual", null),
    ];
    expect(sortTasksByChecklist(rows, BUILT_IN_TASK_CATALOG).map((r) => r.id)).toEqual([
      "earlier",
      "inspection",
      "readings",
      "pictures",
      "manual",
      "monitor",
      "undated",
    ]);
  });

  it("follows a reorder", () => {
    const catalog = {
      ...BUILT_IN_TASK_CATALOG,
      tasks: {
        ...BUILT_IN_TASK_CATALOG.tasks,
        water_extraction: [...BUILT_IN_TASK_CATALOG.tasks.water_extraction].reverse(),
      },
    };
    const rows = [
      t("inspection", "2026-09-04", "job_scope:water_extraction", "inspection"),
      t("pictures", "2026-09-04", "job_scope:water_extraction", "pictures"),
    ];
    expect(sortTasksByChecklist(rows, catalog).map((r) => r.id)).toEqual([
      "pictures",
      "inspection",
    ]);
  });
});

describe("wiring", () => {
  const ADMIN = read("src/components/job-task-templates-admin.tsx");
  const ROUTE = read("src/routes/_authenticated/admin.job-checklists.tsx");
  const TAB = read("src/components/job-tasks-tab.tsx");

  it("sits in Settings › Operations right under the Supply catalog, behind the same gate", () => {
    expect(SETTINGS_SECTION_LAYOUT.operations.slice(0, 2)).toEqual([
      "/admin/supply-catalog",
      "/admin/job-checklists",
    ]);
    const page = SETTINGS_PAGES.find((p) => p.path === "/admin/job-checklists")!;
    expect(page.label).toBe("Job checklists");
    expect(page.keywords).toContain("tasks");
    // The catalog has no entry of its own in page-access; both fall to /admin.
    expect(pageForPath("/admin/job-checklists")?.id).toBe(pageForPath("/admin/supply-catalog")?.id);
    expect(ROUTE).toMatch(/component: JobTaskTemplatesAdmin,/);
  });

  it("is built from the Supply catalog's parts: CommitInput boxes and an Active switch per row", () => {
    const rowBlock = ADMIN.match(/data-checklist-row[\s\S]*?<\/form>/)![0];
    expect(rowBlock).toMatch(/<CommitInput\s+value=\{row\.title\}/);
    expect(rowBlock).toMatch(/<Switch\s+checked=\{row\.active\}/);
    expect(rowBlock).toMatch(/<CommitInput\s+value=\{row\.description\}/);
  });

  it("up and down buttons are 44px under a thumb", () => {
    const up = ADMIN.match(/<Button[^>]*?aria-label=\{`Move \$\{row\.title\} up`\}/)![0];
    const down = ADMIN.match(/<Button[^>]*?aria-label=\{`Move \$\{row\.title\} down`\}/)![0];
    for (const b of [up, down]) expect(b).toContain(`className="size-11 md:size-8"`);
  });

  it("a rename and a new line follow through to open jobs; a move and a note do not", () => {
    expect(ADMIN).toMatch(/syncOpenJobs\(\{ dryRun: false, onlySeededGroups: true \}\)/);
    expect(ADMIN).toMatch(/run\(\(\) => renameTemplate\(row\.id, next\), "[^"]+", true\)/);
    expect(ADMIN).toMatch(/addTemplate\(group, draft, nextSortOrder\(rows\)\),\s*"[^"]+",\s*true,/);
    expect(ADMIN).toMatch(/moveTemplate\(rows, row\.id, "up"\), "[^"]+", false\)/);
    expect(ADMIN).toMatch(/setTemplateNote\(row\.id, next\), "[^"]+", false\)/);
  });

  it('"these dont show up in the job": the check counts, and a confirmed second press adds them', () => {
    const card = ADMIN.match(/function OpenJobsCard[\s\S]*$/)![0];
    expect(card).toMatch(/syncOpenJobs\(\{ dryRun: true, onlySeededGroups: false \}\)/);
    expect(card).toMatch(/syncOpenJobs\(\{ dryRun: false, onlySeededGroups: false \}\)/);
    // Only offered once the count found something, and only through a confirm.
    expect(card).toMatch(/\{missing > 0 && \(\s*<AlertDialog>/);
    expect(card).toMatch(/<AlertDialogAction onClick=\{\(\) => apply\.mutate\(\)\}>/);
    expect(card).toContain('queryKey: ["job-tasks"]');
  });

  it('Water\'s switch flips like the others — Mark: "let him turn off drying log"', () => {
    const sw = ADMIN.match(/<Switch\s+checked=\{r\.on\}[\s\S]*?\/>/)![0];
    expect(sw).toContain("disabled={locked || flip.isPending}");
    expect(sw).toContain("flip.mutate({ scope: r.scope, enabled })");
    expect(ADMIN).toContain('scope: "water",');
    expect(ADMIN).not.toContain("Always on — checking drying progress");
    // Before the migration adds the row, the switch would only be refused.
    expect(ADMIN).toContain('const locked = r.scope === "water" && !waterSwitchable;');
  });

  it("David's sections: name, switch, order and delete in the header; lines like any list", () => {
    const controls = ADMIN.match(/function SectionControls[\s\S]*?\n}\n/)![0];
    expect(controls).toMatch(/renameSection\(section\.key, next\)/);
    expect(controls).toMatch(/setSectionActive\(section\.key, v\), "[^"]+", v\)/);
    expect(controls).toMatch(/moveSection\(sections, section\.key, "up"\)/);
    expect(controls).toMatch(/deleteSection\(section\.key\)/);
    expect(controls).toContain("<AlertDialogAction");
    expect(ADMIN).toMatch(/\{sections\.map\(\(section, i\) => \(\s*<ChecklistCard/);
    const form = ADMIN.match(/function NewSectionCard[\s\S]*?\n}\n/)![0];
    expect(form).toContain("SECTION_JOB_TYPES.map");
    expect(form).toContain("SECTION_ADDED_WHEN.map");
    expect(form).toContain("SECTION_DUE.map");
    expect(form).toMatch(/addSection\(draft, nextOrder\)/);
  });

  it("the Tasks tab badge names David's sections", () => {
    expect(TAB).toContain("automaticTaskGroupLabel(t.source, catalog.data)");
  });

  it("the Tasks tab sorts by the checklist", () => {
    expect(TAB).toMatch(
      /sortTasksByChecklist\(q\.data \?\? \[\], catalog\.data \?\? BUILT_IN_TASK_CATALOG\)/,
    );
    expect(TAB).toMatch(
      /\.select\("id, title, status, priority, due_date, assignee, source, cadence_key"\)/,
    );
  });
});
