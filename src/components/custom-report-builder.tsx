import { ComparisonControls } from "@/components/comparison-controls";
import { useCan } from "@/lib/permissions";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Play, Save, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastDbError } from "@/lib/db-errors";
import {
  CUSTOM_AREAS,
  blankDefinition,
  customArea,
  deleteSavedReport,
  saveCustomReport,
  type CustomAreaId,
  type CustomReportDefinition,
  type SavedReport,
} from "@/lib/custom-reports";

/**
 * The custom report builder: area, filters, columns, run, save.
 *
 * David, 22 Sep: "If I want to just randomly go in there and create different
 * filters and different stuff to run a new report... maybe add another
 * section here, custom report." The office and the period are NOT in here —
 * they are the page's own controls above, the same ones every preset uses, so
 * a saved report always runs against whatever office and dates are chosen now.
 */
export function CustomReportBuilder({
  draft,
  onChange,
  onRun,
  saved,
  canEditSaved,
  saveLocationId,
  onSaved,
  onDeleted,
}: {
  draft: CustomReportDefinition;
  onChange: (next: CustomReportDefinition) => void;
  onRun: () => void;
  /** The saved report being edited, or null for a new one. */
  saved: SavedReport | null;
  /** Only the owner edits a saved report; a shared one is "Save a copy". */
  canEditSaved: boolean;
  saveLocationId: string | null;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const area = customArea(draft.area);
  const [name, setName] = useState(saved?.name ?? "");
  const [shared, setShared] = useState(saved?.shared ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const statusQ = useQuery({
    queryKey: ["custom-report-status-options", area.id],
    queryFn: () => area.status!.options(),
    enabled: !!area.status,
    staleTime: 5 * 60_000,
  });

  const save = useMutation({
    mutationFn: (asCopy: boolean) =>
      saveCustomReport({
        id: saved && canEditSaved && !asCopy ? saved.id : undefined,
        name,
        definition: draft,
        shared,
        locationId: saved && canEditSaved && !asCopy ? saved.location_id : saveLocationId,
      }),
    onSuccess: (id) => {
      toast.success("Report saved");
      void qc.invalidateQueries({ queryKey: ["saved-reports"] });
      onSaved(id);
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "save this report" });
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteSavedReport(saved!.id),
    onSuccess: () => {
      toast.success("Report deleted");
      void qc.invalidateQueries({ queryKey: ["saved-reports"] });
      onDeleted();
    },
    onError: (e) => toastDbError(e, { action: "delete this report" }),
  });

  const set = (patch: Partial<CustomReportDefinition>) => onChange({ ...draft, ...patch });
  const canSeeMoney = useCan("job.view_costs");
  const toggleIn = (list: string[], v: string, on: boolean) =>
    on ? [...new Set([...list, v])] : list.filter((x) => x !== v);

  return (
    <div className="space-y-3 rounded-md border bg-card p-3">
      {draft.comparison ? (
        <ComparisonControls
          value={draft.comparison}
          onChange={(comparison) => set({ comparison })}
          money={canSeeMoney}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Data</Label>
              <Select
                value={draft.area}
                onValueChange={(v) => onChange(blankDefinition(v as CustomAreaId))}
              >
                <SelectTrigger className="h-11 md:h-9" aria-label="Data area">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_AREAS.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{area.blurb}</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Which date the period applies to</Label>
              <Select value={draft.dateField} onValueChange={(v) => set({ dateField: v })}>
                <SelectTrigger className="h-11 md:h-9" aria-label="Date field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {area.dateFields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Office and period come from the controls above.
              </p>
            </div>
          </div>

          {area.status ? (
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium">
                {area.status.label} {draft.statuses.length ? "" : "(any)"}
              </legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {(statusQ.data ?? []).map((o) => (
                  <label
                    key={o.value}
                    className="flex min-h-11 items-center gap-2 text-sm md:min-h-8"
                  >
                    <Checkbox
                      checked={draft.statuses.includes(o.value)}
                      onCheckedChange={(v) =>
                        set({ statuses: toggleIn(draft.statuses, o.value, v === true) })
                      }
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          <fieldset className="space-y-1">
            <legend className="text-xs font-medium">Contains (optional)</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {area.fields
                .filter((f) => f.textFilter)
                .map((f) => (
                  <Input
                    key={f.key}
                    className="h-11 md:h-9"
                    aria-label={`${f.label} contains`}
                    placeholder={`${f.label} contains…`}
                    value={draft.text[f.key] ?? ""}
                    onChange={(e) => {
                      const text = { ...draft.text, [f.key]: e.target.value };
                      if (!e.target.value) delete text[f.key];
                      set({ text });
                    }}
                  />
                ))}
            </div>
          </fieldset>

          <fieldset className="space-y-1">
            {/* Mark, 6 Oct: "for reports add a select all and deselect all button". */}
            {/* The buttons sit inside the legend so it stays the fieldset's first
            child — the group's label for screen readers. */}
            <legend className="flex flex-wrap items-center gap-2 text-xs font-medium">
              Columns
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={draft.columns.length === area.fields.length}
                onClick={() => set({ columns: area.fields.map((f) => f.key) })}
              >
                Select all
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={draft.columns.length === 0}
                onClick={() => set({ columns: [] })}
              >
                Deselect all
              </Button>
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {area.fields.map((f) => (
                <label key={f.key} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
                  <Checkbox
                    checked={draft.columns.includes(f.key)}
                    onCheckedChange={(v) => {
                      const next = toggleIn(draft.columns, f.key, v === true);
                      // Keep the area's order, not the order they were ticked in.
                      set({
                        columns: area.fields.map((x) => x.key).filter((k) => next.includes(k)),
                      });
                    }}
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </fieldset>
        </>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t pt-3">
        <Button
          className="h-11 md:h-9"
          onClick={onRun}
          disabled={!draft.comparison && draft.columns.length === 0}
        >
          <Play className="mr-1.5 size-4" /> Run
        </Button>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <Input
            className="h-11 w-56 md:h-9"
            aria-label="Report name"
            placeholder="Name to save it as"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="flex min-h-11 items-center gap-2 text-xs md:min-h-9">
            <Switch
              checked={shared}
              onCheckedChange={setShared}
              aria-label="Share with the office"
            />
            Share with the office
          </label>
          <Button
            variant="outline"
            className="h-11 md:h-9"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate(false)}
          >
            <Save className="mr-1.5 size-4" />
            {saved && canEditSaved ? "Save changes" : "Save report"}
          </Button>
          {saved && canEditSaved ? (
            confirmDelete ? (
              <Button
                variant="destructive"
                className="h-11 md:h-9"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Delete “{saved.name}”
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="h-11 text-destructive md:h-9"
                onClick={() => setConfirmDelete(true)}
                aria-label="Delete this saved report"
              >
                <Trash2 className="size-4" />
              </Button>
            )
          ) : saved ? (
            <Button
              variant="ghost"
              className="h-11 md:h-9"
              disabled={!name.trim() || save.isPending}
              onClick={() => save.mutate(true)}
            >
              Save a copy
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
