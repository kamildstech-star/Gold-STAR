/**
 * The admin side of the job checklists: Settings › Operations › Job
 * checklists.
 *
 * Mark, sending a screenshot of the Supply catalog: "like this for tasks". So
 * this is the Supply catalog's shape — rows edited in place, each box saving
 * when you leave it, an Active switch per row — over `job_task_templates`,
 * the table the seeding reads (`loadTaskCatalog` in automatic-job-tasks.ts).
 * Same writers too: is_privileged, the catalog's own rule, enforced by RLS.
 *
 * WHAT AN EDIT DOES TO JOBS ALREADY CARRYING THE LIST. After a rename, a new
 * line or a line switched back on, the screen runs
 * `sync_job_automatic_tasks(_dry_run => false, _only_seeded_groups => true)`:
 *   - open, unfinished tasks on open jobs take the new title; done ones keep
 *     the words they were ticked under;
 *   - a new or re-activated line is added to open jobs that already have its
 *     checklist — never to a job that does not, and never where somebody
 *     deleted that task;
 *   - switching a line off only stops it being added. Nothing on a job is
 *     cancelled or deleted.
 * Reordering moves nothing on existing jobs; the Tasks tab lists each
 * checklist in this order.
 *
 * THE FULL PASS. Mark, 13 Oct: "these dont show up in the job". The screen's
 * "Check open jobs" counted the checklists open jobs were missing — gear put
 * on site before Monitoring existed, jobs nobody had opened since — and could
 * not add them. It now can, as a second, deliberate press after the count:
 * `sync_job_automatic_tasks(false, false)`, the same insert-what-is-missing
 * pass, which never duplicates a line and never puts back a deleted task.
 *
 * SECTIONS. Mark, 13 Oct: "also let him make a new section if he wants".
 * `job_task_sections` (migration 20261013122000) holds David's own sections:
 * a name, which job types, what puts it on and when it is due — each picked
 * from what the built-in sections already do. Rename, reorder and switch off
 * like a line; delete only while nothing was ever made from it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import {
  JOB_TASK_SECTION_COLUMNS,
  JOB_TASK_TEMPLATE_COLUMNS,
  TASK_GROUPS,
  catalogFromRows,
  type AutomaticScopeType,
  type CustomSection,
  type DueRule,
  type EquipmentSeeding,
  type GroupTrigger,
  type JobTaskSectionRow,
  type JobTaskSeedingRow,
  type JobTaskTemplateRow,
  type TaskGroupKey,
} from "@/lib/automatic-job-tasks";
import { isMissingSchema } from "@/lib/schema-fallback";

/* Not in the generated types until Lovable regenerates them after
   migrations 20261006174500 and 20261013122000 are applied. */
const db = () => supabase as unknown as SupabaseClient;

/**
 * When each checklist goes on a job, in the words a crew lead would use. The
 * events themselves are code (TASK_GROUPS' trigger and due rule), which is why
 * the screen explains them rather than offering them as settings.
 */
export const GROUP_WHEN: Readonly<Record<TaskGroupKey, string>> = {
  water_extraction:
    "On every Water Mitigation job, from the moment it is created or changed to water. Due the day it goes on.",
  water_remediation:
    "If additional work is needed: the Tasks tab's Add remediation tasks button, or a field ticket that says so. The first six lines are Mark's “Same as above”.",
  water_monitoring:
    "Whenever equipment is placed, on the job types switched on above. Due when the 72-hour drying window ends; a drying reset moves it.",
  water_pickup: "Alongside Monitoring, due on the date the equipment is expected back.",
  mold_remediation: "On every Mold Remediation job. Due the day it goes on.",
  fire_smoke: "On every Fire & Smoke Cleaning job. Due the day it goes on.",
};

/** The three things a section can choose from, in the screen's words. */
export const SECTION_JOB_TYPES: readonly { value: AutomaticScopeType; label: string }[] = [
  { value: "water", label: "Water Mitigation" },
  { value: "mold", label: "Mold Remediation" },
  { value: "fire_smoke", label: "Fire & Smoke Cleaning" },
];

export const SECTION_ADDED_WHEN: readonly { value: GroupTrigger; label: string }[] = [
  { value: "job_type", label: "When the job is created (or changed to that type)" },
  { value: "equipment", label: "When equipment is placed" },
  { value: "additional_work", label: "When additional work is needed" },
];

export const SECTION_DUE: readonly { value: DueRule; label: string }[] = [
  { value: "sync", label: "The day it goes on the job" },
  { value: "drying_window", label: "When the 72-hour drying window ends" },
  { value: "retrieval", label: "On the equipment's expected-back date" },
];

/** One sentence for a section's card: which jobs, when it goes on, when it is due. */
export function describeSectionWhen(
  section: Pick<CustomSection, "jobScopes" | "addedWhen" | "due">,
): string {
  const types = SECTION_JOB_TYPES.filter((t) => section.jobScopes.includes(t.value)).map(
    (t) => t.label,
  );
  const jobs = types.length ? types.join(", ") : "no job types";
  const when =
    section.addedWhen === "equipment"
      ? `Whenever equipment is placed on ${jobs} jobs.`
      : section.addedWhen === "additional_work"
        ? `When additional work is needed on ${jobs} jobs.`
        : `On every ${jobs} job, from the moment it is created or changed to that type.`;
  const due =
    section.due === "drying_window"
      ? "Due when the 72-hour drying window ends."
      : section.due === "retrieval"
        ? "Due on the date the equipment is expected back."
        : "Due the day it goes on.";
  return `${when} ${due}`;
}

export type TemplateScreen = {
  /** False until the migration is applied: the screen says so instead of erroring. */
  available: boolean;
  /** False until 20261013122000 is applied: no Water switch, no new sections yet. */
  sectionsAvailable: boolean;
  rows: JobTaskTemplateRow[];
  seeding: EquipmentSeeding;
  /** David's own sections, in his order, their lines included. */
  sections: CustomSection[];
};

export async function loadTemplateScreen(): Promise<TemplateScreen> {
  const [rows, settings, sections] = await Promise.all([
    db()
      .from("job_task_templates")
      .select(JOB_TASK_TEMPLATE_COLUMNS)
      .order("sort_order", { ascending: true }),
    db().from("job_task_seeding_settings").select("job_scope, seed_equipment_tasks"),
    db().from("job_task_sections").select(JOB_TASK_SECTION_COLUMNS),
  ]);
  if (rows.error) {
    if (isMissingSchema(rows.error)) {
      return {
        available: false,
        sectionsAvailable: false,
        rows: [],
        seeding: { water: true, mold: true, fire_smoke: true },
        sections: [],
      };
    }
    throw rows.error;
  }
  if (settings.error && !isMissingSchema(settings.error)) throw settings.error;
  if (sections.error && !isMissingSchema(sections.error)) throw sections.error;
  const list = (rows.data ?? []) as JobTaskTemplateRow[];
  const catalog = catalogFromRows(
    list,
    (settings.data ?? []) as JobTaskSeedingRow[],
    (sections.error ? [] : (sections.data ?? [])) as JobTaskSectionRow[],
  );
  return {
    available: true,
    sectionsAvailable: !sections.error,
    rows: list,
    seeding: catalog.equipmentSeeding,
    sections: [...(catalog.sections ?? [])],
  };
}

/** One group's rows in the order the seeding uses — sort order, then key. */
export function rowsForGroup(
  rows: readonly JobTaskTemplateRow[],
  group: string,
): JobTaskTemplateRow[] {
  return rows
    .filter((r) => r.group_key === group)
    .sort((a, b) => a.sort_order - b.sort_order || a.task_key.localeCompare(b.task_key));
}

/** A new line goes to the bottom of its checklist. */
export function nextSortOrder(groupRows: readonly { sort_order: number }[]): number {
  return groupRows.reduce((max, r) => Math.max(max, r.sort_order), 0) + 10;
}

/**
 * The writes that move one line up or down. Renumbers the whole checklist in
 * tens and returns only the rows whose number changed — usually two — so a
 * list where two lines share a number (added by hand in SQL, say) still moves.
 */
export function reorderPatches<T extends { id: string; sort_order: number }>(
  groupRows: readonly T[],
  id: string,
  direction: "up" | "down",
): { id: string; sort_order: number }[] {
  const order = [...groupRows];
  const from = order.findIndex((r) => r.id === id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= order.length) return [];
  [order[from], order[to]] = [order[to]!, order[from]!];
  return order
    .map((r, i) => ({ id: r.id, sort_order: (i + 1) * 10, was: r.sort_order }))
    .filter((p) => p.sort_order !== p.was)
    .map(({ id: rowId, sort_order }) => ({ id: rowId, sort_order }));
}

/** An update RLS refuses touches zero rows and returns no error; say so. */
async function updateRow(id: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await db()
    .from("job_task_templates")
    .update(patch)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  if (!data?.length)
    throw new Error(
      "This checklist line could not be saved — only an owner or admin can edit checklists.",
    );
}

export async function renameTemplate(id: string, title: string): Promise<void> {
  const next = title.trim();
  if (!next)
    throw new Error("A checklist line needs a name. Switch it off instead of clearing it.");
  await updateRow(id, { title: next });
}

export async function setTemplateNote(id: string, description: string): Promise<void> {
  await updateRow(id, { description: description.trim() || null });
}

export async function setTemplateActive(id: string, active: boolean): Promise<void> {
  await updateRow(id, { active });
}

export async function moveTemplate(
  groupRows: readonly JobTaskTemplateRow[],
  id: string,
  direction: "up" | "down",
): Promise<void> {
  for (const patch of reorderPatches(groupRows, id, direction)) {
    await updateRow(patch.id, { sort_order: patch.sort_order });
  }
}

export async function addTemplate(group: string, title: string, sortOrder: number): Promise<void> {
  const next = title.trim();
  if (!next) throw new Error("Type the line first.");
  const { error } = await db()
    .from("job_task_templates")
    .insert({ group_key: group, title: next, sort_order: sortOrder });
  if (error) throw error;
}

export async function setEquipmentSeeding(
  scope: keyof EquipmentSeeding,
  enabled: boolean,
): Promise<void> {
  const { data, error } = await db()
    .from("job_task_seeding_settings")
    .upsert({ job_scope: scope, seed_equipment_tasks: enabled }, { onConflict: "job_scope" })
    .select("job_scope");
  if (error) throw error;
  if (!data?.length) throw new Error("Only an owner or admin can change this.");
}

/* ---- Sections ---------------------------------------------------------- */

export type NewSection = {
  label: string;
  jobScopes: readonly AutomaticScopeType[];
  addedWhen: GroupTrigger;
  due: DueRule;
};

/** Why a new section cannot be saved yet, in words; null when it can. */
export function newSectionProblem(section: NewSection): string | null {
  if (!section.label.trim()) return "Give the section a name.";
  if (section.label.trim().length > 80) return "Keep the name under 80 characters.";
  if (!section.jobScopes.length) return "Pick at least one job type.";
  return null;
}

/** A new section goes after the others. Its key is generated by the database. */
export async function addSection(section: NewSection, sortOrder: number): Promise<string> {
  const problem = newSectionProblem(section);
  if (problem) throw new Error(problem);
  const { data, error } = await db()
    .from("job_task_sections")
    .insert({
      label: section.label.trim(),
      job_scopes: [...section.jobScopes],
      added_when: section.addedWhen,
      due_rule: section.due,
      sort_order: sortOrder,
    })
    .select("key")
    .single();
  if (error) throw error;
  return (data as { key: string }).key;
}

async function updateSection(key: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await db()
    .from("job_task_sections")
    .update(patch)
    .eq("key", key)
    .select("key");
  if (error) throw error;
  if (!data?.length)
    throw new Error(
      "This section could not be saved — only an owner or admin can edit checklists.",
    );
}

export async function renameSection(key: string, label: string): Promise<void> {
  const next = label.trim();
  if (!next) throw new Error("A section needs a name. Switch it off instead of clearing it.");
  await updateSection(key, { label: next });
}

export async function setSectionActive(key: string, active: boolean): Promise<void> {
  await updateSection(key, { active });
}

/** Sections as reorderable rows: their key is their id. Same renumbering as lines. */
export function sectionOrderRows(
  sections: readonly Pick<CustomSection, "key" | "sortOrder">[],
): { id: string; sort_order: number }[] {
  return sections.map((s) => ({ id: s.key, sort_order: s.sortOrder }));
}

export async function moveSection(
  sections: readonly CustomSection[],
  key: string,
  direction: "up" | "down",
): Promise<void> {
  for (const patch of reorderPatches(sectionOrderRows(sections), key, direction)) {
    await updateSection(patch.id, { sort_order: patch.sort_order });
  }
}

/**
 * Delete a section and its lines. The database refuses once any task was made
 * from it (tg_job_task_sections_guard_delete); that refusal is turned into
 * the sentence the screen shows, which says what to do instead.
 */
export async function deleteSection(key: string): Promise<void> {
  const { data, error } = await db()
    .from("job_task_sections")
    .delete()
    .eq("key", key)
    .select("key");
  if (error) {
    if (error.code === "23503" || /switch it off/i.test(error.message ?? "")) {
      throw new Error(
        "Tasks were already made from this section, so it cannot be deleted. Switch it off instead — nothing already on a job changes.",
      );
    }
    throw error;
  }
  if (!data?.length) throw new Error("Only an owner or admin can delete a section.");
}

/* ---- The retroactive pass ---------------------------------------------- */

export type SyncReport = {
  dry_run: boolean;
  only_seeded_groups: boolean;
  open_jobs: number;
  jobs_gaining_tasks: number;
  tasks_added: number;
  tasks_renamed: number;
  added_by_group: Partial<Record<string, number>>;
  added_already_overdue: number;
  skipped_previously_deleted: number;
};

/** The retroactive pass (migration 20261006174500). Dry unless told otherwise. */
export async function syncOpenJobs(opts: {
  dryRun: boolean;
  onlySeededGroups: boolean;
}): Promise<SyncReport> {
  const { data, error } = await db().rpc("sync_job_automatic_tasks", {
    _dry_run: opts.dryRun,
    _only_seeded_groups: opts.onlySeededGroups,
  });
  if (error) throw error;
  return data as SyncReport;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What an edit just did to open jobs, for the toast. Null when it did nothing. */
export function describeEditSync(report: SyncReport): string | null {
  const parts: string[] = [];
  if (report.tasks_renamed) parts.push(`renamed ${plural(report.tasks_renamed, "open task")}`);
  if (report.tasks_added) {
    parts.push(
      `added ${plural(report.tasks_added, "task")} to ${plural(report.jobs_gaining_tasks, "open job")}`,
    );
  }
  if (!parts.length) return null;
  const text = parts.join(" and ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/** The dry run, read out: what the full pass would do. */
export function describeDryRun(
  report: SyncReport,
  sections: readonly Pick<CustomSection, "key" | "label">[] = [],
): string {
  if (!report.tasks_added && !report.tasks_renamed) {
    return `All ${plural(report.open_jobs, "open job")} already have their checklists.`;
  }
  const labels = [
    ...TASK_GROUPS.map((g) => ({ key: g.key as string, label: g.label })),
    ...sections.map((s) => ({ key: s.key, label: s.label })),
  ];
  const groups = labels
    .filter((g) => report.added_by_group[g.key])
    .map((g) => `${g.label} ${report.added_by_group[g.key]}`)
    .join(" · ");
  const lines = [
    `${plural(report.tasks_added, "task")} missing on ${plural(report.jobs_gaining_tasks, "open job")} (of ${report.open_jobs})${groups ? `: ${groups}` : ""}.`,
  ];
  if (report.added_already_overdue) {
    lines.push(`${report.added_already_overdue} would arrive already overdue.`);
  }
  if (report.tasks_renamed) lines.push(`${plural(report.tasks_renamed, "open task")} to rename.`);
  if (report.skipped_previously_deleted) {
    lines.push(`${plural(report.skipped_previously_deleted, "deleted task")} left deleted.`);
  }
  return lines.join(" ");
}

/** What the full pass just did, for the card once it has run. */
export function describeFullSync(report: SyncReport): string {
  if (!report.tasks_added && !report.tasks_renamed) {
    return "Nothing was missing — every open job already had its checklists.";
  }
  return describeEditSync(report) ?? "";
}
