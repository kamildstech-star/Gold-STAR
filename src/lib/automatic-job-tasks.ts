/**
 * The checklist a crew follows on each kind of job, put on the job for them.
 *
 * Mark, sending the list Gold Star's crews actually work from: "these
 * are the tasks that should auto populate for each job type". That list is the
 * spec, so the titles below are his words — his order, his "if needed" and "as
 * needed" — with only the spelling fixed ("withing", "its"). Dashes are evened
 * out to one en dash; nothing else about the wording is ours.
 *
 * "Job type" in his sense is the service category (`jobs.loss_type`, kept in
 * step with `loss_type_id`): Water Mitigation, Mold Remediation, Fire & Smoke
 * Cleaning. `jobs.job_type` is the payment type (insurance / retail) and plays
 * no part here.
 *
 * The list is not one flat checklist per type. Each part has its own moment:
 *
 *   - Water · Extraction, Mold, Fire — seeded when the job is that type (at
 *     creation, and again if the type changes).
 *   - Water · Remediation — "If additional work needed". Seeded when
 *     `jobs.additional_work_pending` goes true: the Tasks tab's one-tap button,
 *     or a field ticket that says more work is needed (a database trigger
 *     raises the flag). "Same as above" means the extraction checks repeat.
 *   - Monitoring — "Whenever equipment is added". Seeded by the placement
 *     write itself (`placeUnit` and the offline queue call
 *     `scheduleAutomaticTaskSync`). Once per job, not per machine: six units
 *     dropped one at a time are one drying window.
 *   - Pick up equipment — seeded alongside Monitoring, due on the day the gear
 *     is expected back. See PICKUP below for why it is not seeded later.
 *
 * HOW IT NEVER SEEDS TWICE. Every row carries a cadence key built from the job
 * id, the group and the task (`job-scope:<job>:<group>:<task>`), and
 * `tasks_cadence_uniq` is a unique index on that column. Reconciling a job is
 * therefore safe to run as often as anything likes — a second run finds every
 * key present and inserts nothing, and two runs racing each other lose to the
 * index rather than doubling the list.
 *
 * Group keys are storage, not labels: `water_monitoring` and `water_pickup`
 * kept their names when those groups stopped being water-only, because
 * renaming a key would retire every live row and seed a fresh copy.
 *
 * WHERE THE WORDS LIVE, since 6 Oct. Mark, shown the Supply catalog: "like
 * this for tasks". The lines are rows in `job_task_templates`, edited at
 * Settings › Operations › Job checklists, and `loadTaskCatalog` reads them on
 * every reconcile. The lists below are the seed that table was filled from and
 * the fallback while the migration is unapplied — never a second source of
 * truth once it is. What stays in code is the shape of each group: which
 * event seeds it and which date it is due on (TASK_GROUPS), because those are
 * wired into the placement write, the remediation flag and the drying clock.
 *
 * A DELETED TASK STAYS DELETED. "Insert what is missing" cannot tell a task
 * never seeded from one somebody removed, so `job_task_seed_keys` remembers
 * every key ever put on a job and the plan never re-inserts one of those.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { TablesInsert } from "@/integrations/supabase/types";
import { DRYING_WINDOW_HOURS, dryingClockStart, type DryingReset } from "@/lib/drying-clock";
import { isMissingSchema } from "@/lib/schema-fallback";

export type AutomaticScopeType = "water" | "mold" | "fire_smoke";

type ScopeTaskTemplate = {
  key: string;
  title: string;
  /** Said once on the task itself, for the one line that is also a button. */
  description?: string;
};

/**
 * Which date a group's tasks are due on.
 *
 *   - `sync`: the day it was put on the job — the work starts now.
 *   - `drying_window`: the end of the current 72-hour drying window, the same
 *     window the drying clock shows (first placement, or the newest reset).
 *   - `retrieval`: the earliest expected-retrieval date among the units still
 *     on the job — the date the overdue-equipment alerts read.
 */
export type DueRule = "sync" | "drying_window" | "retrieval";

type ScopeGroup = {
  key: string;
  label: string;
  due: DueRule;
  tasks: readonly ScopeTaskTemplate[];
};

export type ExistingAutomaticTask = {
  id: string;
  status: string;
  source: string;
  cadenceKey: string | null;
  dueDate: string | null;
  /** When present, unfinished rows are brought to the current wording. */
  title?: string;
};

export type AutomaticTaskDraft = {
  title: string;
  description: string;
  source: string;
  cadenceKey: string;
  dueDate: string;
};

export type AutomaticTaskSyncPlan = {
  insert: AutomaticTaskDraft[];
  reopenIds: string[];
  cancelIds: string[];
  dueDateUpdates: { id: string; dueDate: string }[];
  titleUpdates: { id: string; title: string }[];
};

export type AutomaticTaskContext = {
  jobId: string;
  lossTypeKey: string | null | undefined;
  additionalRemediationRequired: boolean;
  /** Any unit ever placed: the equipment groups are part of this job's scope. */
  equipmentAdded: boolean;
  /**
   * A unit is on site right now. Missing equipment-group lines are only added
   * while one is — a pickup list for gear already back in the warehouse is
   * noise. Defaults to `equipmentAdded`.
   */
  equipmentOnSite?: boolean;
  /** Complete, invoiced, paid or cancelled: the checklist is history and nothing changes. */
  jobClosed?: boolean;
  /** Today, as a calendar date. Always passed in — this module never reads the clock for it. */
  syncDate: string;
  /** Calendar date the current 72-hour drying window ends. */
  dryingWindowEndsOn?: string | null;
  /** Earliest expected-retrieval date among units still on the job. */
  retrievalDueOn?: string | null;
};

const SOURCE_PREFIX = "job_scope:";

const WATER_EXTRACTION = {
  key: "water_extraction",
  label: "Water · Extraction",
  due: "sync",
  tasks: [
    { key: "inspection", title: "Inspection" },
    { key: "extraction", title: "Extraction" },
    { key: "readings", title: "Readings" },
    { key: "setup_equipment_scan", title: "Set up equipment – Scan" },
    { key: "scope_if_needed", title: "Scope of work – if needed" },
    { key: "pictures", title: "Pictures" },
  ],
} as const satisfies ScopeGroup;

/* "Same as above" means the extraction checks repeat before the
   remediation-only work. They get cadence keys of their own (the group is
   part of the key) so completing Extraction · Readings does not complete
   Remediation · Readings — the second visit takes its own readings. */
const WATER_REMEDIATION = {
  key: "water_remediation",
  label: "Water · Remediation",
  due: "sync",
  tasks: [
    ...WATER_EXTRACTION.tasks,
    { key: "containment_if_needed", title: "Containment if needed" },
    { key: "cover_contents_if_needed", title: "Cover contents if needed" },
    { key: "remove_equipment", title: "Remove equipment" },
    { key: "remediate_surfaces", title: "Remediate walls/ceiling as needed" },
    { key: "treat_clean", title: "Treat and clean" },
    { key: "reset_equipment", title: "Set back up equipment" },
    {
      key: "reset_drying",
      title: "Reset 3 days of drying time",
      // Mark's line goes on: "(new button linked to scanning and alerts)". That
      // half is the button, not the task name; the task says where it is.
      description:
        "Press Reset 3-day drying (Tasks, Drying or Work ticket tab). It restarts the 72 hours and moves every unit's expected retrieval date out to match, so the equipment alerts and the Monitoring and Pick up equipment tasks follow.",
    },
    { key: "remediation_pictures", title: "Pictures" },
    { key: "sketch", title: "Sketch" },
    { key: "write_up", title: "Write up" },
    { key: "clean_property", title: "Make sure property is clean" },
  ],
} as const satisfies ScopeGroup;

/* "Check drying progress within first 3 days" is the whole point of this
   group, so it is due when the 72 hours run out — and a reset, which starts a
   fresh 72 hours, moves it with the window while it is still open. */
const MONITORING = {
  key: "water_monitoring",
  label: "Monitoring",
  due: "drying_window",
  tasks: [
    {
      key: "check_drying_progress",
      title: "Check drying progress within first 3 days to make sure it's drying",
    },
    { key: "readings", title: "Readings" },
    { key: "pictures", title: "Pictures" },
  ],
} as const satisfies ScopeGroup;

/* PICKUP. Seeded with Monitoring at the first placement and due on the
   expected-retrieval date, rather than seeded when that date comes round.
   Seeding on a date needs something to run on that date, and this checklist
   is reconciled by the app, not a scheduler: a job nobody opened that week —
   exactly the job whose gear gets forgotten — would never get its pickup list.
   A due date is the clock the task list already has: the five tasks wait
   until the day, then land in Needs you today and go overdue beside the
   equipment alert that reads the same date. */
const PICKUP = {
  key: "water_pickup",
  label: "Pick up equipment",
  due: "retrieval",
  tasks: [
    { key: "confirm_dry", title: "Confirm everything is dry (readings)" },
    { key: "dry_pictures", title: "Pictures to confirm dry" },
    { key: "purge_dehu", title: "Purge Dehu" },
    { key: "scan_all_equipment", title: "Scan all equipment" },
    { key: "clean_property", title: "Make sure property is clean" },
  ],
} as const satisfies ScopeGroup;

const MOLD = {
  key: "mold_remediation",
  label: "Mold",
  due: "sync",
  tasks: [
    { key: "inspection", title: "Inspection" },
    { key: "containment", title: "Set up containment" },
    { key: "negative_air", title: "Set up Negative air – Scan scrubber" },
    { key: "remediate", title: "Remediate as needed" },
    {
      key: "hepa_process",
      title: "Wipe/HEPA/Wipe (must use HEPA vac) or HEPA/Wipe/HEPA – as needed",
    },
    { key: "treat_clean", title: "Treat and clean" },
    { key: "dehu_if_needed", title: "Set up Dehu if needed" },
    { key: "leave_scrubber", title: "Leave scrubber" },
    { key: "encapsulate_if_needed", title: "Encapsulate – as needed" },
    { key: "pictures", title: "Pictures" },
  ],
} as const satisfies ScopeGroup;

const FIRE = {
  key: "fire_smoke",
  label: "Fire",
  due: "sync",
  tasks: [
    { key: "inspection", title: "Inspection" },
    { key: "board_up", title: "Board up" },
    { key: "extraction", title: "Extraction" },
    { key: "readings", title: "Readings" },
    { key: "seal_scene", title: "Seal off fire scene" },
    { key: "secure_property", title: "Secure property" },
    { key: "winterize", title: "Winterize areas that will not have heat" },
    { key: "release_form", title: "Release form" },
    { key: "setup_equipment_scan", title: "Set up equipment – Scan" },
    { key: "scope_if_needed", title: "Scope of work – if needed" },
    { key: "pictures", title: "Pictures" },
    { key: "remediate_if_needed", title: "Remediate – as needed" },
  ],
} as const satisfies ScopeGroup;

const GROUPS: readonly ScopeGroup[] = [
  WATER_EXTRACTION,
  WATER_REMEDIATION,
  MONITORING,
  PICKUP,
  MOLD,
  FIRE,
];

export type TaskGroupKey =
  | "water_extraction"
  | "water_remediation"
  | "water_monitoring"
  | "water_pickup"
  | "mold_remediation"
  | "fire_smoke";

/** What seeds a group. Code, not data: each one is a code path. */
export type GroupTrigger = "job_type" | "additional_work" | "equipment";

export type TaskGroupInfo = {
  key: TaskGroupKey;
  label: string;
  due: DueRule;
  trigger: GroupTrigger;
};

/**
 * The six groups, in the order a job lists them. The SQL backfill
 * (`job_automatic_task_candidates`, migration 20261006174500) mirrors this
 * table; `automatic-job-task-templates.test.ts` holds the two together.
 */
export const TASK_GROUPS: readonly TaskGroupInfo[] = [
  { key: "water_extraction", label: WATER_EXTRACTION.label, due: "sync", trigger: "job_type" },
  {
    key: "water_remediation",
    label: WATER_REMEDIATION.label,
    due: "sync",
    trigger: "additional_work",
  },
  { key: "water_monitoring", label: MONITORING.label, due: "drying_window", trigger: "equipment" },
  { key: "water_pickup", label: PICKUP.label, due: "retrieval", trigger: "equipment" },
  { key: "mold_remediation", label: MOLD.label, due: "sync", trigger: "job_type" },
  { key: "fire_smoke", label: FIRE.label, due: "sync", trigger: "job_type" },
];

const GROUP_BY_KEY = new Map(GROUPS.map((group) => [group.key, group]));
const GROUP_INFO = new Map(TASK_GROUPS.map((group) => [group.key as string, group]));

/** One line of a checklist, as the templates table holds it. */
export type CatalogTask = {
  key: string;
  title: string;
  description?: string | null;
  active: boolean;
};

/**
 * Mark: "for now yes, but make a way for him to disable it in the admin".
 * Whether placing equipment seeds Monitoring and Pick up equipment on each
 * type of job. Mold and Fire had a switch from 6 Oct; Water joined them on
 * 13 Oct — Mark: "let him turn off drying log". All default on.
 */
export type EquipmentSeeding = { water: boolean; mold: boolean; fire_smoke: boolean };

/**
 * A checklist section David made himself (Mark, 13 Oct: "also let him make a
 * new section if he wants"). It picks, once, from what the built-in sections
 * already do: which jobs (by type), what puts it on (`addedWhen`, the same
 * three events as TASK_GROUPS' triggers) and which date it is due on (the
 * same three due rules). Rows in `job_task_sections` (migration
 * 20261013122000); its lines are ordinary template rows under its key.
 */
export type CustomSection = {
  key: string;
  label: string;
  addedWhen: GroupTrigger;
  due: DueRule;
  jobScopes: readonly AutomaticScopeType[];
  /** Switched off: adds nothing new, and what it already put on jobs stays. */
  active: boolean;
  sortOrder: number;
  /** Its lines in display order, inactive ones included. */
  tasks: readonly CatalogTask[];
};

export type TaskCatalog = {
  /** Each built-in group's lines in display order, inactive ones included. */
  tasks: Readonly<Record<TaskGroupKey, readonly CatalogTask[]>>;
  equipmentSeeding: EquipmentSeeding;
  /** David's own sections, in his order. Absent means none. */
  sections?: readonly CustomSection[];
};

/** Mark's lists as compiled in — the table's seed, and the fallback before it exists. */
export const BUILT_IN_TASK_CATALOG: TaskCatalog = {
  tasks: Object.fromEntries(
    GROUPS.map((group) => [
      group.key,
      group.tasks.map((task) => ({
        key: task.key,
        title: task.title,
        description: task.description ?? null,
        active: true,
      })),
    ]),
  ) as Record<TaskGroupKey, CatalogTask[]>,
  equipmentSeeding: { water: true, mold: true, fire_smoke: true },
  sections: [],
};

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The device's own calendar date for a moment — a 9pm drop is that day, not tomorrow's UTC. */
export function localCalendarDate(at: Date): string {
  return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/**
 * The checklist type for a service category, however it is spelled: the
 * legacy `jobs.loss_type` value ("water"), the option key
 * ("water_mitigation") or the label the office picked ("Water Mitigation").
 * Mirrors `job_checklist_scope_of` (migration 20261013122000).
 */
export function automaticScopeTypeFor(
  lossTypeKey: string | null | undefined,
): AutomaticScopeType | null {
  const key = (lossTypeKey ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (key === "water" || key === "water_mitigation") return "water";
  if (key === "mold" || key === "mold_remediation") return "mold";
  if (key === "fire" || key === "smoke" || key === "fire_smoke_cleaning") {
    return "fire_smoke";
  }
  return null;
}

/**
 * Which spelling of the job's service category to read the checklist type
 * from. `jobs.loss_type` is a legacy copy that `trg_sync_loss_type` only
 * fills when the picked option's key is one it knows; otherwise it is left
 * NULL (or stale) and the job looked typeless — no checklists at all. The
 * option the office picked is the truth, so its key and then its label are
 * read when the legacy value does not map.
 */
export function resolveScopeKey(
  lossType: string | null | undefined,
  option?: { key?: string | null; label?: string | null } | null,
): string | null {
  for (const value of [lossType, option?.key, option?.label]) {
    if (value && automaticScopeTypeFor(value)) return value;
  }
  return lossType ?? null;
}

export function automaticTaskGroupLabel(source: string, catalog?: TaskCatalog): string | null {
  if (!source.startsWith(SOURCE_PREFIX)) return null;
  const key = source.slice(SOURCE_PREFIX.length);
  return (
    GROUP_BY_KEY.get(key)?.label ??
    catalog?.sections?.find((s) => s.key === key)?.label ??
    "Automatic scope"
  );
}

/** A group's label, due rule and trigger — built in, or one of David's sections. */
function groupInfoFor(
  key: string,
  catalog: TaskCatalog,
): { label: string; due: DueRule; trigger: GroupTrigger } | null {
  const builtIn = GROUP_INFO.get(key);
  if (builtIn) return builtIn;
  const section = catalog.sections?.find((s) => s.key === key);
  return section ? { label: section.label, due: section.due, trigger: section.addedWhen } : null;
}

/** A group's lines — built in, or one of David's sections. */
function tasksFor(key: string, catalog: TaskCatalog): readonly CatalogTask[] {
  if (GROUP_INFO.has(key)) return catalog.tasks[key as TaskGroupKey] ?? [];
  return catalog.sections?.find((s) => s.key === key)?.tasks ?? [];
}

/** Does a section's event apply to this job right now? */
function sectionTriggered(
  section: CustomSection,
  type: AutomaticScopeType,
  context: AutomaticTaskContext,
): boolean {
  if (!section.jobScopes.includes(type)) return false;
  if (section.addedWhen === "additional_work") return context.additionalRemediationRequired;
  if (section.addedWhen === "equipment") return context.equipmentAdded;
  return true;
}

/**
 * The groups this job's state calls for — type, remediation flag, equipment —
 * regardless of switches and inactive lines. A group outside this list is the
 * only thing ever cancelled; a group inside it is never retired from under a
 * crew, even when David has switched it off for new jobs.
 */
function scopeGroupKeys(context: AutomaticTaskContext, catalog: TaskCatalog): string[] {
  const type = automaticScopeTypeFor(context.lossTypeKey);
  if (!type) return [];

  const groups: string[] = [
    type === "mold"
      ? "mold_remediation"
      : type === "fire_smoke"
        ? "fire_smoke"
        : "water_extraction",
  ];
  if (type === "water" && context.additionalRemediationRequired) groups.push("water_remediation");
  // "Whenever equipment is added" stands on its own in Mark's list, not under
  // Water: a mold job leaves a scrubber and maybe a dehu, a fire job has its
  // own "Set up equipment – Scan", and that gear is checked on and collected
  // the same way.
  if (context.equipmentAdded) groups.push("water_monitoring", "water_pickup");
  // David's sections, switched off or not: switching one off stops it adding
  // lines (seedingGroupKeys), and must never retire what it already put on.
  for (const section of catalog.sections ?? []) {
    if (sectionTriggered(section, type, context)) groups.push(section.key);
  }
  return groups;
}

/** Does placing equipment seed Monitoring and Pick up equipment on this type of job? */
export function equipmentTasksSeedOn(
  type: AutomaticScopeType | null,
  seeding: EquipmentSeeding,
): boolean {
  if (type === "water") return seeding.water;
  if (type === "mold") return seeding.mold;
  if (type === "fire_smoke") return seeding.fire_smoke;
  return false;
}

/** The groups that may gain lines now: the scope, less the switches and an empty site. */
function seedingGroupKeys(context: AutomaticTaskContext, catalog: TaskCatalog): string[] {
  const type = automaticScopeTypeFor(context.lossTypeKey);
  const onSite = context.equipmentOnSite ?? context.equipmentAdded;
  return scopeGroupKeys(context, catalog).filter((key) => {
    const builtIn = GROUP_INFO.get(key);
    if (builtIn) {
      return (
        builtIn.trigger !== "equipment" ||
        (onSite && equipmentTasksSeedOn(type, catalog.equipmentSeeding))
      );
    }
    // A section of David's has no type switch: its job types are the switch.
    const section = catalog.sections?.find((s) => s.key === key);
    return !!section?.active && (section.addedWhen !== "equipment" || onSite);
  });
}

function dueDateFor(due: DueRule, context: AutomaticTaskContext): string {
  const fallback = addDays(context.syncDate, 3);
  if (due === "drying_window") return context.dryingWindowEndsOn ?? fallback;
  if (due === "retrieval") {
    return context.retrievalDueOn ?? context.dryingWindowEndsOn ?? fallback;
  }
  return context.syncDate;
}

const isOpen = (status: string) => status === "open" || status === "in_progress";

/** `job-scope:<job>:<group>:<task>` — the one spelling, shared with the SQL backfill. */
export function automaticCadenceKey(jobId: string, group: string, task: string): string {
  return `job-scope:${jobId}:${group}:${task}`;
}

const EMPTY_PLAN: AutomaticTaskSyncPlan = {
  insert: [],
  reopenIds: [],
  cancelIds: [],
  dueDateUpdates: [],
  titleUpdates: [],
};

export type AutomaticTaskPlanOptions = {
  /** The lines to seed from. Defaults to Mark's lists as compiled in. */
  catalog?: TaskCatalog;
  /**
   * Every key ever seeded on this job (`job_task_seed_keys`). A key in here
   * with no task is one somebody deleted, and it is not put back.
   */
  seededKeys?: ReadonlySet<string>;
};

/**
 * Pure reconciliation plan. Automatic rows outside the job's scope are
 * cancelled, never deleted. Completed rows are history — never reopened,
 * retitled or re-dated. Manual rows never enter this function because they do
 * not carry the job_scope source.
 *
 * What an edit in the admin screen does to a job already carrying the list:
 *   - a renamed line renames the job's unfinished task (done ones keep the
 *     words they were ticked under);
 *   - a new or re-activated line is added, unless the job once had it and
 *     somebody deleted it;
 *   - a deactivated line, or a group switched off for Mold / Fire, stops
 *     being added — and the tasks already on jobs stay exactly as they are.
 */
export function buildAutomaticTaskSyncPlan(
  context: AutomaticTaskContext,
  existing: ExistingAutomaticTask[],
  options: AutomaticTaskPlanOptions = {},
): AutomaticTaskSyncPlan {
  if (context.jobClosed) return EMPTY_PLAN;
  const catalog = options.catalog ?? BUILT_IN_TASK_CATALOG;
  const seeded = options.seededKeys ?? new Set<string>();
  const scope = new Set<string>(scopeGroupKeys(context, catalog));

  const desired = seedingGroupKeys(context, catalog).flatMap((groupKey) => {
    const info = groupInfoFor(groupKey, catalog)!;
    const dueDate = dueDateFor(info.due, context);
    return tasksFor(groupKey, catalog)
      .filter((task) => task.active)
      .map((task) => ({
        title: task.title,
        description: [`Automatically generated from the ${info.label} checklist.`, task.description]
          .filter(Boolean)
          .join(" "),
        source: `${SOURCE_PREFIX}${groupKey}`,
        cadenceKey: automaticCadenceKey(context.jobId, groupKey, task.key),
        dueDate,
      }));
  });
  const byKey = new Map(
    existing.filter((task) => task.cadenceKey).map((task) => [task.cadenceKey!, task]),
  );
  const groupOf = (task: ExistingAutomaticTask) => task.source.slice(SOURCE_PREFIX.length);
  const inScope = (task: ExistingAutomaticTask) =>
    task.source.startsWith(SOURCE_PREFIX) && scope.has(groupOf(task));

  const insert = desired.filter(
    (task) => !byKey.has(task.cadenceKey) && !seeded.has(task.cadenceKey),
  );
  const reopenIds = desired
    .map((task) => byKey.get(task.cadenceKey))
    .filter((task): task is ExistingAutomaticTask => task?.status === "cancelled")
    .map((task) => task.id);
  const cancelIds = existing
    .filter(
      (task) => task.source.startsWith(SOURCE_PREFIX) && !inScope(task) && isOpen(task.status),
    )
    .map((task) => task.id);
  const dueDateUpdates = existing
    .filter((task) => inScope(task) && isOpen(task.status))
    .map((task) => ({ task, due: groupInfoFor(groupOf(task), catalog)?.due ?? "sync" }))
    .filter(({ due }) => due !== "sync")
    .map(({ task, due }) => ({ task, dueDate: dueDateFor(due, context) }))
    .filter(({ task, dueDate }) => task.dueDate !== dueDate)
    .map(({ task, dueDate }) => ({ id: task.id, dueDate }));
  // Jobs seeded before an edit carry the earlier wording — Mark's own list
  // replacing the first draft ("Purge dehumidifier" → "Purge Dehu"), or David
  // renaming a line in Settings. Unfinished rows take the current title so a
  // crew is not reading two versions of one checklist; ticked rows keep the
  // words they were ticked under. An inactive line still renames: the task is
  // on the job either way.
  const currentTitle = new Map(
    [...scope].flatMap((groupKey) =>
      tasksFor(groupKey, catalog).map(
        (task) => [automaticCadenceKey(context.jobId, groupKey, task.key), task.title] as const,
      ),
    ),
  );
  const titleUpdates = existing
    .filter((task) => task.cadenceKey && task.title !== undefined && task.status !== "done")
    .map((task) => ({ task, title: currentTitle.get(task.cadenceKey!) }))
    .filter(
      (row): row is { task: ExistingAutomaticTask; title: string } =>
        row.title !== undefined && row.task.title !== row.title,
    )
    .map(({ task, title }) => ({ id: task.id, title }));

  return { insert, reopenIds, cancelIds, dueDateUpdates, titleUpdates };
}

export type PlacementDates = {
  placed_at: string;
  expected_retrieval_date: string | null;
  retrieved_at: string | null;
};

/**
 * The two dates the equipment groups are due on, from the placements and the
 * drying resets on the job. Pure; `toLocalDate` is passed so a test is not at
 * the mercy of the machine's time zone.
 *
 *   - The drying window is the drying clock's own (`dryingClockStart`): it
 *     starts at the newest reset, else the first placement — retrieved units
 *     included, the job started drying when its first machine arrived — and
 *     ends 72 hours on.
 *   - Retrieval is the earliest expected date among units still on site; once
 *     everything is back, among all of them. A unit already collected must not
 *     hold the pickup list to a date a reset has since moved past.
 */
export function equipmentFollowUpDates(
  placements: PlacementDates[],
  resets: DryingReset[],
  toLocalDate: (at: Date) => string = localCalendarDate,
): { equipmentAdded: boolean; dryingWindowEndsOn: string | null; retrievalDueOn: string | null } {
  const firstPlacedAt =
    placements
      .map((p) => p.placed_at)
      .filter((at) => Number.isFinite(Date.parse(at)))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  const { startedAt } = dryingClockStart({ firstPlacedAt, resets });
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  const dryingWindowEndsOn = Number.isFinite(startMs)
    ? toLocalDate(new Date(startMs + DRYING_WINDOW_HOURS * 3600000))
    : null;

  const onSite = placements.filter((p) => !p.retrieved_at);
  const pool = onSite.length ? onSite : placements;
  const retrievalDueOn =
    pool
      .map((p) => p.expected_retrieval_date)
      .filter((date): date is string => !!date)
      .sort()[0] ?? null;

  return { equipmentAdded: placements.length > 0, dryingWindowEndsOn, retrievalDueOn };
}

type JobScopeRow = {
  id: string;
  status: string;
  loss_type: string | null;
  loss_type_id?: string | null;
  location_id: string;
  account_id: string | null;
  crew_chief: string | null;
  additional_work_pending: boolean;
};

/** OPEN_JOB_STATUSES' complement (src/lib/jobs.ts), spelled out to keep this module light. */
const CLOSED_JOB_STATUSES = new Set(["complete", "invoiced", "paid", "cancelled"]);

/** A `job_task_templates` row, as the admin screen and the seeding read it. */
export type JobTaskTemplateRow = {
  id: string;
  group_key: string;
  task_key: string;
  title: string;
  description: string | null;
  sort_order: number;
  active: boolean;
};

export type JobTaskSeedingRow = { job_scope: string; seed_equipment_tasks: boolean };

export const JOB_TASK_TEMPLATE_COLUMNS =
  "id, group_key, task_key, title, description, sort_order, active";

/** A `job_task_sections` row (migration 20261013122000). */
export type JobTaskSectionRow = {
  key: string;
  label: string;
  builtin: boolean;
  added_when: string;
  due_rule: string;
  job_scopes: string[];
  sort_order: number;
  active: boolean;
};

export const JOB_TASK_SECTION_COLUMNS =
  "key, label, builtin, added_when, due_rule, job_scopes, sort_order, active";

const TRIGGERS: readonly GroupTrigger[] = ["job_type", "additional_work", "equipment"];
const DUE_RULES: readonly DueRule[] = ["sync", "drying_window", "retrieval"];
const SCOPES: readonly AutomaticScopeType[] = ["water", "mold", "fire_smoke"];

/** David's sections from their rows, in his order. Built-in rows and malformed ones are skipped. */
export function sectionsFromRows(
  sectionRows: readonly JobTaskSectionRow[],
  rows: readonly JobTaskTemplateRow[],
): CustomSection[] {
  const ordered = [...rows].sort(
    (a, b) => a.sort_order - b.sort_order || a.task_key.localeCompare(b.task_key),
  );
  return [...sectionRows]
    .filter(
      (s) =>
        !s.builtin &&
        !GROUP_INFO.has(s.key) &&
        TRIGGERS.includes(s.added_when as GroupTrigger) &&
        DUE_RULES.includes(s.due_rule as DueRule),
    )
    .sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
    .map((s) => ({
      key: s.key,
      label: s.label,
      addedWhen: s.added_when as GroupTrigger,
      due: s.due_rule as DueRule,
      jobScopes: (s.job_scopes ?? []).filter((x): x is AutomaticScopeType =>
        SCOPES.includes(x as AutomaticScopeType),
      ),
      active: s.active,
      sortOrder: s.sort_order,
      tasks: ordered
        .filter((r) => r.group_key === s.key)
        .map((r) => ({
          key: r.task_key,
          title: r.title,
          description: r.description,
          active: r.active,
        })),
    }));
}

/**
 * The table's rows as a catalog. Pure. A group with no rows is an empty
 * checklist — David switched every line off — not a reason to fall back to the
 * compiled lists; a missing switch row reads as on, Mark's "for now yes".
 */
export function catalogFromRows(
  rows: readonly JobTaskTemplateRow[],
  settings: readonly JobTaskSeedingRow[],
  sectionRows: readonly JobTaskSectionRow[] = [],
): TaskCatalog {
  const tasks = Object.fromEntries(TASK_GROUPS.map((g) => [g.key, [] as CatalogTask[]])) as Record<
    TaskGroupKey,
    CatalogTask[]
  >;
  const ordered = [...rows].sort(
    (a, b) => a.sort_order - b.sort_order || a.task_key.localeCompare(b.task_key),
  );
  for (const row of ordered) {
    const list = tasks[row.group_key as TaskGroupKey];
    if (!list) continue;
    list.push({
      key: row.task_key,
      title: row.title,
      description: row.description,
      active: row.active,
    });
  }
  const switchFor = (scope: string) =>
    settings.find((s) => s.job_scope === scope)?.seed_equipment_tasks ?? true;
  return {
    tasks,
    equipmentSeeding: {
      water: switchFor("water"),
      mold: switchFor("mold"),
      fire_smoke: switchFor("fire_smoke"),
    },
    sections: sectionsFromRows(sectionRows, rows),
  };
}

/* The three tables arrive with migration 20261006174500 and are not in the
   generated types until Lovable regenerates them after it is applied. */
const untyped = () => supabase as unknown as SupabaseClient;

/**
 * The checklist lines as David last left them. Falls back to the compiled
 * lists ONLY when the table is missing (the migration is not applied yet).
 * Any other failure throws: falling back on a dropped connection would rename
 * every open task back to the compiled wording over David's edits.
 */
export async function loadTaskCatalog(
  client: SupabaseClient = untyped(),
): Promise<TaskCatalog & { fromDatabase: boolean }> {
  const [templates, settings, sections] = await Promise.all([
    client.from("job_task_templates").select(JOB_TASK_TEMPLATE_COLUMNS),
    client.from("job_task_seeding_settings").select("job_scope, seed_equipment_tasks"),
    client.from("job_task_sections").select(JOB_TASK_SECTION_COLUMNS),
  ]);
  if (templates.error) {
    if (isMissingSchema(templates.error)) return { ...BUILT_IN_TASK_CATALOG, fromDatabase: false };
    throw templates.error;
  }
  if (settings.error && !isMissingSchema(settings.error)) throw settings.error;
  // No sections table yet (20261013122000 unapplied) is "no custom sections".
  if (sections.error && !isMissingSchema(sections.error)) throw sections.error;
  return {
    ...catalogFromRows(
      (templates.data ?? []) as JobTaskTemplateRow[],
      (settings.data ?? []) as JobTaskSeedingRow[],
      (sections.error ? [] : (sections.data ?? [])) as JobTaskSectionRow[],
    ),
    fromDatabase: true,
  };
}

/**
 * The checklist spelling of the job's service category (`resolveScopeKey`).
 * Only reads the option when the legacy column does not map, so the common
 * case costs nothing. A failed read throws rather than guessing "no type":
 * no type would retire every open checklist task on the job.
 */
async function readScopeKey(job: JobScopeRow): Promise<string | null> {
  if (automaticScopeTypeFor(job.loss_type) || !job.loss_type_id) return job.loss_type;
  const { data, error } = await supabase
    .from("option_list_values")
    .select("key, label")
    .eq("id", job.loss_type_id)
    .maybeSingle();
  if (error) throw error;
  return resolveScopeKey(job.loss_type, data as { key: string; label: string } | null);
}

/** Every automatic key this job has ever carried; empty before the migration. */
async function readSeededKeys(jobId: string): Promise<Set<string>> {
  const { data, error } = await untyped()
    .from("job_task_seed_keys")
    .select("cadence_key")
    .eq("job_id", jobId);
  if (error) {
    if (isMissingSchema(error)) return new Set();
    throw error;
  }
  return new Set(((data ?? []) as { cadence_key: string }[]).map((row) => row.cadence_key));
}

async function updateTasks(ids: string[], patch: Record<string, unknown>): Promise<void> {
  if (!ids.length) return;
  const { data, error } = await supabase
    .from("tasks")
    .update(patch as never)
    .in("id", ids)
    .select("id");
  if (error) throw error;
  if ((data?.length ?? 0) !== ids.length) {
    throw new Error("Some automatic tasks could not be updated. Check job-task access.");
  }
}

/**
 * The resets on the job. A database without `job_drying_resets` simply has
 * none, which is what the drying clock assumes too.
 */
async function readDryingResets(jobId: string): Promise<DryingReset[]> {
  const { data, error } = await supabase
    .from("job_drying_resets")
    .select("id, reset_at, reset_by, previous_started_at, note")
    .eq("job_id", jobId)
    .limit(50);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []) as DryingReset[];
}

/**
 * Reconcile a job: after creation, a service-category change, the remediation
 * button, an equipment placement or a drying reset. `syncDate` is the caller's
 * today; callers outside a test pass `localCalendarDate(new Date())`.
 */
export async function syncAutomaticJobTasksForJob(
  jobId: string,
  userId: string,
  syncDate = localCalendarDate(new Date()),
): Promise<AutomaticTaskSyncPlan> {
  const [jobResult, taskResult, equipmentResult, resets, catalog, seededKeys] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        "id, status, loss_type, loss_type_id, location_id, account_id, crew_chief, additional_work_pending",
      )
      .eq("id", jobId)
      .single(),
    supabase
      .from("tasks")
      .select("id, status, source, cadence_key, due_date, title")
      .eq("job_id", jobId)
      .like("source", `${SOURCE_PREFIX}%`),
    supabase
      .from("equipment_placements")
      .select("placed_at, expected_retrieval_date, retrieved_at")
      .eq("job_id", jobId),
    readDryingResets(jobId),
    loadTaskCatalog(),
    readSeededKeys(jobId),
  ]);
  if (jobResult.error) throw jobResult.error;
  if (taskResult.error) throw taskResult.error;
  if (equipmentResult.error) throw equipmentResult.error;

  const job = jobResult.data as JobScopeRow;
  const lossTypeKey = await readScopeKey(job);
  const placements = (equipmentResult.data ?? []) as PlacementDates[];
  const existing: ExistingAutomaticTask[] = (taskResult.data ?? []).map((task) => ({
    id: task.id,
    status: task.status,
    source: task.source,
    cadenceKey: task.cadence_key,
    dueDate: task.due_date,
    title: task.title,
  }));
  const plan = buildAutomaticTaskSyncPlan(
    {
      jobId,
      lossTypeKey,
      additionalRemediationRequired: job.additional_work_pending,
      ...equipmentFollowUpDates(placements, resets),
      equipmentOnSite: placements.some((p) => !p.retrieved_at),
      // A paid job from last year is history. Opening its Tasks tab must not
      // put a fresh checklist due today into Needs you today.
      jobClosed: CLOSED_JOB_STATUSES.has(job.status),
      syncDate,
    },
    existing,
    { catalog, seededKeys },
  );

  const insertRows: TablesInsert<"tasks">[] = plan.insert.map((task) => ({
    title: task.title,
    description: task.description,
    assignee: job.crew_chief,
    due_date: task.dueDate,
    priority: "normal",
    status: "open",
    entity_type: "job",
    entity_id: job.id,
    account_id: job.account_id,
    job_id: job.id,
    location_id: job.location_id,
    source: task.source,
    cadence_key: task.cadenceKey,
    created_by: userId,
  }));

  // Make the new/current scope available before retiring obsolete open work.
  // The normal path is one request for the whole checklist. A concurrent
  // second sync can win a cadence-key race; only then retry row-by-row so its
  // duplicates are accepted without withholding the still-missing rows.
  if (insertRows.length) {
    const { error } = await supabase.from("tasks").insert(insertRows);
    if (error?.code === "23505") {
      for (const row of insertRows) {
        const { error: retryError } = await supabase.from("tasks").insert(row);
        if (retryError && retryError.code !== "23505") throw retryError;
      }
    } else if (error) {
      throw error;
    }
  }

  await updateTasks(plan.reopenIds, { status: "open", completed_at: null });
  for (const update of plan.dueDateUpdates) {
    await updateTasks([update.id], { due_date: update.dueDate });
  }
  for (const update of plan.titleUpdates) {
    await updateTasks([update.id], { title: update.title });
  }
  await updateTasks(plan.cancelIds, { status: "cancelled", completed_at: null });
  return plan;
}

/**
 * Collapse a burst of requests for the same key into at most two runs: the one
 * in flight, and one more after it if anything asked while it ran. Pure apart
 * from the `run` it is given, so the burst behavior is testable.
 */
export function coalescePerKey(
  run: (key: string) => Promise<unknown>,
): (key: string) => Promise<void> {
  const slots = new Map<string, { again: boolean; done: Promise<void> }>();
  return (key) => {
    const slot = slots.get(key);
    if (slot) {
      slot.again = true;
      return slot.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          await run(key);
        } while (entry.again);
      } finally {
        slots.delete(key);
      }
    })();
    slots.set(key, entry);
    return entry.done;
  };
}

let scheduledUserId: string | null = null;
const scheduleSync = coalescePerKey((jobId) =>
  syncAutomaticJobTasksForJob(jobId, scheduledUserId ?? "", localCalendarDate(new Date())),
);

/**
 * Called from the placement and drying-reset writes. A crew scanning six
 * machines in one at a time fires this six times; the cadence keys already
 * make that harmless, and coalescing makes it cheap. It never throws: a
 * checklist that fails to seed must not fail the scan that triggered it — the
 * Tasks tab reconciles again when it is opened.
 */
export function scheduleAutomaticTaskSync(jobId: string, userId: string): Promise<void> {
  scheduledUserId = userId;
  return scheduleSync(jobId).catch(() => undefined);
}

/**
 * A job's tasks in the order a crew works them: by due date as before, and
 * within one day each checklist in the order David set in Settings, the
 * groups in TASK_GROUPS' order, hand-made tasks after. Reordering a line in
 * Settings moves nothing in the database — this is where it shows. Stable,
 * so anything the rank cannot tell apart keeps the order it arrived in.
 */
export function sortTasksByChecklist<
  T extends { due_date: string | null; source: string; cadence_key: string | null },
>(rows: readonly T[], catalog: TaskCatalog): T[] {
  const rank = (row: T): number => {
    if (!row.source.startsWith(SOURCE_PREFIX) || !row.cadence_key) return Infinity;
    const group = row.source.slice(SOURCE_PREFIX.length);
    const builtInIndex = TASK_GROUPS.findIndex((g) => g.key === group);
    // David's sections list after the built-in ones, in his order.
    const sectionIndex = (catalog.sections ?? []).findIndex((s) => s.key === group);
    const groupIndex =
      builtInIndex >= 0 ? builtInIndex : sectionIndex >= 0 ? TASK_GROUPS.length + sectionIndex : -1;
    if (groupIndex < 0) return Infinity;
    const taskKey = row.cadence_key.split(":")[3];
    const taskIndex = tasksFor(group, catalog).findIndex((t) => t.key === taskKey);
    return groupIndex * 1000 + (taskIndex < 0 ? 999 : taskIndex);
  };
  const byDate = (a: string | null, b: string | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, rank: rank(row) }))
    .sort(
      (a, b) =>
        byDate(a.row.due_date, b.row.due_date) ||
        (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}
