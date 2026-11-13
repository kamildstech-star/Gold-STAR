import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { CommitInput } from "@/components/commit-input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LoadError } from "@/components/ui-density";
import {
  TASK_GROUPS,
  type AutomaticScopeType,
  type CustomSection,
  type DueRule,
  type EquipmentSeeding,
  type GroupTrigger,
  type JobTaskTemplateRow,
} from "@/lib/automatic-job-tasks";
import { toastDbError } from "@/lib/db-errors";
import { isPrivileged } from "@/lib/roles";
import {
  GROUP_WHEN,
  SECTION_ADDED_WHEN,
  SECTION_DUE,
  SECTION_JOB_TYPES,
  addSection,
  addTemplate,
  deleteSection,
  describeDryRun,
  describeEditSync,
  describeFullSync,
  describeSectionWhen,
  loadTemplateScreen,
  moveSection,
  moveTemplate,
  newSectionProblem,
  nextSortOrder,
  renameSection,
  renameTemplate,
  rowsForGroup,
  setEquipmentSeeding,
  setSectionActive,
  setTemplateActive,
  setTemplateNote,
  syncOpenJobs,
  type SyncReport,
} from "@/lib/job-task-templates";

const SCREEN_KEY = ["job-task-templates"] as const;

/**
 * Settings › Operations › Job checklists.
 *
 * Mark, with a screenshot of the Supply catalog: "like this for tasks" — so
 * David can add, rename, reorder and switch off checklist lines himself
 * instead of asking a developer. Built from the Supply catalog's own parts:
 * CommitInput boxes that save when you leave them, an Active switch per row,
 * an add row under each list. Up and down buttons rather than drag, because
 * they work the same under a thumb as under a mouse.
 *
 * Above the lists, Mark's other asks: "for now yes, but make a way for him to
 * disable it in the admin" (6 Oct) and "let him turn off drying log" (13 Oct)
 * — whether placing equipment seeds Monitoring and Pick up equipment, per job
 * type. Below them, "also let him make a new section if he wants".
 *
 * What an edit does to jobs already carrying a list is decided in
 * src/lib/job-task-templates.ts and said on the screen in one line.
 */
export function JobTaskTemplatesAdmin() {
  const app = useAppContext();
  /*
   * David, 13 Oct: "I can't create a new section or line." Checklist writes
   * are owner / admin only in the database (is_privileged); anybody else got a
   * bare permission error on every save. Say so up front, and refuse the save
   * in words instead of a Postgres code.
   */
  const canEdit = isPrivileged(app.realRoles);
  const qc = useQueryClient();
  const screen = useQuery({ queryKey: SCREEN_KEY, queryFn: loadTemplateScreen });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: SCREEN_KEY });
    void qc.invalidateQueries({ queryKey: ["job-task-catalog"] });
  };

  /**
   * After an edit that changes what open jobs should carry: the narrow pass,
   * which renames open tasks and adds a new line only where its checklist
   * already is. The edit itself has saved by now, so a failure here says so.
   */
  async function followThrough() {
    try {
      const report = await syncOpenJobs({ dryRun: false, onlySeededGroups: true });
      const said = describeEditSync(report);
      if (said) toast.success(said);
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["job-tasks"] });
    } catch (err) {
      toastDbError(err, {
        action: "The edit saved, but updating open jobs",
      });
    }
  }

  async function save(write: () => Promise<void>, what: string, follow: boolean) {
    // Nothing that calls this is drawn without the role; the database refuses it too.
    if (!canEdit) return false;
    try {
      await write();
      refresh();
      if (follow) await followThrough();
      return true;
    } catch (err) {
      if (err instanceof Error && !("code" in err)) toast.error(err.message);
      else toastDbError(err, { action: what });
      return false;
    }
  }

  if (screen.isError) {
    return <LoadError what="the job checklists" error={screen.error} />;
  }
  if (screen.isLoading || !screen.data) {
    return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  }
  if (!screen.data.available) {
    return (
      <Card>
        <CardContent className="space-y-1 p-3 text-sm">
          <p className="font-medium">Job checklists are not editable yet.</p>
          <p className="text-muted-foreground">
            The database update that holds them (migration 20261006174500) has not been applied.
            Until it is, every job gets Mark&rsquo;s lists exactly as they were.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { rows, sections, sectionsAvailable } = screen.data;
  return (
    <div className="space-y-3">
      {canEdit && !sectionsAvailable && (
        <p className="rounded-md border border-dashed border-warning/50 bg-warning/10 p-2 text-sm">
          New sections, the Water switch, and checklists on jobs with no loss type recorded all wait
          on database update 20261013122000. Until it is applied, lines can still be added to the
          built-in checklists below.
        </p>
      )}
      <EquipmentSeedingCard
        seeding={screen.data.seeding}
        waterSwitchable={sectionsAvailable}
        canEdit={canEdit}
        onSaved={refresh}
      />
      {canEdit && <OpenJobsCard sections={sections} />}
      {canEdit && (
        <p className="px-1 text-xs text-muted-foreground">
          Each box saves when you leave it. A rename reaches the unfinished tasks on open jobs;
          ticked ones keep the words they were ticked under. A new line is added to open jobs that
          already have that checklist. Switching a line off only stops it being added — nothing
          already on a job is removed.
        </p>
      )}
      {TASK_GROUPS.map((group) => (
        <ChecklistCard
          key={group.key}
          group={group.key}
          label={group.label}
          when={GROUP_WHEN[group.key]}
          rows={rowsForGroup(rows, group.key)}
          canEdit={canEdit}
          save={save}
        />
      ))}
      {sections.map((section, i) => (
        <ChecklistCard
          key={section.key}
          group={section.key}
          label={section.label}
          when={describeSectionWhen(section)}
          rows={rowsForGroup(rows, section.key)}
          canEdit={canEdit}
          save={save}
          header={
            !canEdit ? undefined : (
              <SectionControls
                section={section}
                sections={sections}
                first={i === 0}
                last={i === sections.length - 1}
                save={save}
              />
            )
          }
        />
      ))}
      {canEdit &&
        (sectionsAvailable ? (
          <NewSectionCard
            nextOrder={nextSortOrder(sections.map((s) => ({ sort_order: s.sortOrder })))}
            save={save}
          />
        ) : (
          <p className="px-1 text-xs text-muted-foreground">
            New sections and the Water switch arrive with database update 20261013122000.
          </p>
        ))}
    </div>
  );
}

type Save = (write: () => Promise<void>, what: string, follow: boolean) => Promise<boolean>;

function ChecklistCard({
  group,
  label,
  when,
  rows,
  canEdit,
  save,
  header,
}: {
  group: string;
  label: string;
  when: string;
  rows: JobTaskTemplateRow[];
  /** Without it the lines read as text: no boxes, switches, moves or Add. */
  canEdit: boolean;
  save: Save;
  /** A section of David's: its name box, switch, order and delete. */
  header?: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const active = rows.filter((r) => r.active).length;

  async function run(write: () => Promise<void>, what: string, follow: boolean) {
    setBusy(true);
    try {
      return await save(write, what, follow);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-checklist-group={group}>
      <CardHeader className="pb-2">
        {header ?? (
          <CardTitle className="text-sm">
            {label}{" "}
            <span className="font-normal text-muted-foreground">
              · {active} of {rows.length} active
            </span>
          </CardTitle>
        )}
        <p className="text-xs text-muted-foreground">{when}</p>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {rows.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            {canEdit ? "No lines — add the first below." : "No lines."}
          </p>
        ) : !canEdit ? (
          rows.map((row) => (
            <div
              key={row.id}
              data-checklist-row
              className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm"
            >
              <div className="min-w-0">
                <p className={row.active ? undefined : "text-muted-foreground"}>{row.title}</p>
                {row.description && (
                  <p className="text-xs text-muted-foreground">{row.description}</p>
                )}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {row.active ? "Active" : "Off"}
              </span>
            </div>
          ))
        ) : (
          rows.map((row, i) => (
            <div
              key={row.id}
              data-checklist-row
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5 lg:grid-cols-[auto_minmax(0,2fr)_minmax(0,1.5fr)_auto]"
            >
              <div className="lg:order-2">
                <CommitInput
                  value={row.title}
                  aria-label={`Name of ${row.title}`}
                  className={row.active ? "h-11 md:h-8" : "h-11 text-muted-foreground md:h-8"}
                  onCommit={(next) =>
                    run(() => renameTemplate(row.id, next), "Renaming the checklist line", true)
                  }
                />
              </div>
              <label className="flex items-center justify-end gap-2 text-xs text-muted-foreground lg:order-4">
                {row.active ? "Active" : "Off"}
                <Switch
                  checked={row.active}
                  aria-label={`${row.title} active`}
                  disabled={busy}
                  onCheckedChange={(v) =>
                    void run(
                      () => setTemplateActive(row.id, v),
                      "Switching the checklist line",
                      // Off stops seeding and touches no job; back on adds
                      // the line where its checklist already is.
                      v,
                    )
                  }
                />
              </label>
              <div className="col-span-2 flex items-center gap-2 lg:contents">
                <div className="flex shrink-0 gap-1 lg:order-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-11 md:size-8"
                    aria-label={`Move ${row.title} up`}
                    disabled={busy || i === 0}
                    onClick={() =>
                      void run(() => moveTemplate(rows, row.id, "up"), "Moving the line", false)
                    }
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-11 md:size-8"
                    aria-label={`Move ${row.title} down`}
                    disabled={busy || i === rows.length - 1}
                    onClick={() =>
                      void run(() => moveTemplate(rows, row.id, "down"), "Moving the line", false)
                    }
                  >
                    <ArrowDown />
                  </Button>
                </div>
                <div className="min-w-0 flex-1 lg:order-3">
                  <CommitInput
                    value={row.description}
                    placeholder="Note for the crew (optional)"
                    aria-label={`Note on ${row.title}`}
                    className="h-11 md:h-8"
                    onCommit={(next) =>
                      run(() => setTemplateNote(row.id, next), "Saving the note", false)
                    }
                  />
                </div>
              </div>
            </div>
          ))
        )}
        {canEdit && (
          <form
            className="flex gap-2 bg-muted/40 px-3 py-2.5"
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(
                () => addTemplate(group, draft, nextSortOrder(rows)),
                "Adding the checklist line",
                true,
              );
              if (ok) setDraft("");
            }}
          >
            <Input
              className="h-11 md:h-8"
              placeholder={`New ${label} line`}
              aria-label={`New line for ${label}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button type="submit" className="h-11 shrink-0 md:h-8" disabled={!draft.trim() || busy}>
              <Plus className="mr-1" /> Add
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * A section of David's: rename, switch off, move, delete. What it does (job
 * types, trigger, due date) was chosen when it was made and is read out
 * under the name — changing those would quietly re-scope tasks already on
 * jobs, so a different rule is a new section.
 */
function SectionControls({
  section,
  sections,
  first,
  last,
  save,
}: {
  section: CustomSection;
  sections: readonly CustomSection[];
  first: boolean;
  last: boolean;
  save: Save;
}) {
  const [busy, setBusy] = useState(false);
  async function run(write: () => Promise<void>, what: string, follow: boolean) {
    setBusy(true);
    try {
      return await save(write, what, follow);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div data-checklist-section={section.key} className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1 basis-48">
        <CommitInput
          value={section.label}
          aria-label={`Name of section ${section.label}`}
          className={
            section.active
              ? "h-11 font-semibold md:h-8"
              : "h-11 font-semibold text-muted-foreground md:h-8"
          }
          onCommit={(next) =>
            run(() => renameSection(section.key, next), "Renaming the section", false)
          }
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        {section.active ? "Section on" : "Section off"}
        <Switch
          checked={section.active}
          aria-label={`${section.label} section active`}
          disabled={busy}
          onCheckedChange={(v) =>
            // Off stops it adding lines and touches no job; back on adds its
            // lines where it already is.
            void run(() => setSectionActive(section.key, v), "Switching the section", v)
          }
        />
      </label>
      <div className="flex gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="size-11 md:size-8"
          aria-label={`Move section ${section.label} up`}
          disabled={busy || first}
          onClick={() =>
            void run(() => moveSection(sections, section.key, "up"), "Moving the section", false)
          }
        >
          <ArrowUp />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-11 md:size-8"
          aria-label={`Move section ${section.label} down`}
          disabled={busy || last}
          onClick={() =>
            void run(() => moveSection(sections, section.key, "down"), "Moving the section", false)
          }
        >
          <ArrowDown />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="size-11 text-destructive md:size-8"
              aria-label={`Delete section ${section.label}`}
              disabled={busy}
            >
              <Trash2 />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{section.label}”?</AlertDialogTitle>
              <AlertDialogDescription>
                The section and its lines go. This only works while no task has ever been made from
                it; once one has, switch the section off instead.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void run(() => deleteSection(section.key), "Deleting the section", false)
                }
              >
                Delete section
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

/**
 * Mark, 13 Oct: "also let him make a new section if he wants". Name, job
 * types, when it goes on and when it is due — each choice one the built-in
 * sections already make — then lines are added to it like any other list.
 */
function NewSectionCard({ nextOrder, save }: { nextOrder: number; save: Save }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [jobScopes, setJobScopes] = useState<AutomaticScopeType[]>([]);
  const [addedWhen, setAddedWhen] = useState<GroupTrigger>("job_type");
  const [due, setDue] = useState<DueRule>("sync");
  const [busy, setBusy] = useState(false);
  const draft = { label, jobScopes, addedWhen, due };
  const problem = newSectionProblem(draft);

  if (!open) {
    return (
      <Button variant="outline" className="h-11 w-full md:h-9" onClick={() => setOpen(true)}>
        <Plus className="mr-1" /> New section
      </Button>
    );
  }

  return (
    <Card data-new-checklist-section>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">New section</CardTitle>
        <p className="text-xs text-muted-foreground">
          A checklist of your own. Pick which jobs get it, what puts it on and when it is due; then
          add its lines like the lists above.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          className="h-11 md:h-8"
          placeholder="Section name, e.g. Contents"
          aria-label="Section name"
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium">Job types</legend>
          {SECTION_JOB_TYPES.map((t) => (
            <label key={t.value} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
              <Checkbox
                checked={jobScopes.includes(t.value)}
                onCheckedChange={(v) =>
                  setJobScopes((cur) => (v ? [...cur, t.value] : cur.filter((x) => x !== t.value)))
                }
              />
              {t.label}
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            <span>Added</span>
            <Select value={addedWhen} onValueChange={(v) => setAddedWhen(v as GroupTrigger)}>
              <SelectTrigger className="h-11 md:h-8" aria-label="When the section is added">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SECTION_ADDED_WHEN.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1 text-xs font-medium">
            <span>Due</span>
            <Select value={due} onValueChange={(v) => setDue(v as DueRule)}>
              <SelectTrigger className="h-11 md:h-8" aria-label="When the section is due">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SECTION_DUE.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          {problem ?? describeSectionWhen(draft)} These choices are fixed once it is made; rename,
          reorder or switch it off any time.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" className="h-11 md:h-8" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            className="h-11 md:h-8"
            disabled={!!problem || busy}
            onClick={async () => {
              setBusy(true);
              const ok = await save(
                async () => {
                  await addSection(draft, nextOrder);
                },
                "Adding the section",
                false,
              );
              setBusy(false);
              if (ok) {
                toast.success("Section added — now add its lines");
                setOpen(false);
                setLabel("");
                setJobScopes([]);
                setAddedWhen("job_type");
                setDue("sync");
              }
            }}
          >
            Add section
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Mark: "for now yes, but make a way for him to disable it in the admin" (Mold
 * and Fire, 6 Oct) and "let him turn off drying log" (Water, 13 Oct). Each job
 * type's switch decides whether placing equipment adds Monitoring and Pick up
 * equipment. The Drying log tab itself stays on every job either way.
 */
function EquipmentSeedingCard({
  seeding,
  waterSwitchable,
  canEdit,
  onSaved,
}: {
  seeding: EquipmentSeeding;
  /** False until 20261013122000 adds the 'water' row the switch writes. */
  waterSwitchable: boolean;
  /** Without it each line reads On or Off, with no switch. */
  canEdit: boolean;
  onSaved: () => void;
}) {
  const flip = useMutation({
    mutationFn: (v: { scope: keyof EquipmentSeeding; enabled: boolean }) =>
      setEquipmentSeeding(v.scope, v.enabled),
    onSuccess: (_d, v) => {
      toast.success(
        v.enabled
          ? "Monitoring and Pick up equipment will be added when equipment is placed"
          : "No new Monitoring or Pick up equipment tasks on these jobs",
      );
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "Changing the setting" }),
  });

  const rows: { scope: keyof EquipmentSeeding; label: string; on: boolean; hint?: string }[] = [
    {
      scope: "water",
      label: "Water Mitigation jobs",
      on: seeding.water,
      hint: "The drying checks. Off: no new Monitoring or Pick up equipment tasks on water jobs — the Drying log tab, the drying clock and the equipment alerts carry on as before.",
    },
    { scope: "mold", label: "Mold Remediation jobs", on: seeding.mold },
    { scope: "fire_smoke", label: "Fire & Smoke Cleaning jobs", on: seeding.fire_smoke },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">When equipment is placed</CardTitle>
        <p className="text-xs text-muted-foreground">
          Add the Monitoring and Pick up equipment checklists on these jobs.
          {canEdit &&
            " Turning one off stops new tasks; the ones already on jobs stay. Turning it back on adds them the next time equipment is placed on a job or its Tasks tab is opened."}
        </p>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {rows.map((r) => {
          const locked = r.scope === "water" && !waterSwitchable;
          return (
            <label
              key={r.label}
              data-equipment-seeding={r.scope}
              className="flex min-h-11 items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0">
                {r.label}
                {r.hint && (
                  <span className="block text-xs text-muted-foreground">
                    {locked ? "Always on until database update 20261013122000 is applied." : r.hint}
                  </span>
                )}
              </span>
              {canEdit ? (
                <Switch
                  checked={r.on}
                  disabled={locked || flip.isPending}
                  aria-label={`Monitoring and Pick up equipment on ${r.label}`}
                  onCheckedChange={(enabled) => flip.mutate({ scope: r.scope, enabled })}
                />
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {r.on ? "On" : "Off"}
                </span>
              )}
            </label>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * Mark, 13 Oct: "these dont show up in the job". The count used to be all
 * this card did — it read out the checklists open jobs were missing and left
 * them missing. Now the count is the first press and adding them the second,
 * confirmed: the same insert-what-is-missing pass, which never adds a line
 * twice and never puts back a task somebody deleted. After that each job
 * keeps itself up to date when its Tasks tab opens or equipment is placed.
 */
function OpenJobsCard({ sections }: { sections: readonly CustomSection[] }) {
  const qc = useQueryClient();
  const [done, setDone] = useState<SyncReport | null>(null);
  const check = useMutation({
    mutationFn: () => syncOpenJobs({ dryRun: true, onlySeededGroups: false }),
    onMutate: () => setDone(null),
    onError: (e) => toastDbError(e, { action: "Checking open jobs" }),
  });
  const apply = useMutation({
    mutationFn: () => syncOpenJobs({ dryRun: false, onlySeededGroups: false }),
    onSuccess: (report) => {
      setDone(report);
      check.reset();
      toast.success(describeFullSync(report));
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      void qc.invalidateQueries({ queryKey: ["job-tasks"] });
      void qc.invalidateQueries({ queryKey: ["job-rail-tasks"] });
    },
    onError: (e) => toastDbError(e, { action: "Adding the missing checklists" }),
  });
  const missing = check.data?.tasks_added ?? 0;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-3 p-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground sm:min-w-[16rem]">
          {done
            ? describeFullSync(done)
            : check.data
              ? describeDryRun(check.data, sections)
              : "See which open jobs are missing their checklists. Nothing changes until you add them."}
        </p>
        <Button
          variant="outline"
          className="h-11 md:h-8"
          disabled={check.isPending || apply.isPending}
          onClick={() => check.mutate()}
        >
          {check.isPending ? "Checking…" : "Check open jobs"}
        </Button>
        {missing > 0 && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button className="h-11 md:h-8" disabled={apply.isPending}>
                {apply.isPending
                  ? "Adding…"
                  : `Add ${missing} missing task${missing === 1 ? "" : "s"}`}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Add the missing checklists to open jobs?</AlertDialogTitle>
                <AlertDialogDescription>
                  {describeDryRun(check.data!, sections)} Each task goes to the job&rsquo;s crew
                  chief. Nothing already on a job is changed, no line is added twice, and a task
                  somebody deleted stays deleted.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Not now</AlertDialogCancel>
                <AlertDialogAction onClick={() => apply.mutate()}>Add them</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </CardContent>
    </Card>
  );
}
