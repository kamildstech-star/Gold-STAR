import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, GripVertical, Pencil, Plus, Search, Tag as TagIcon, X } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { LabelPill, LabelPills } from "@/components/label-pill";
import { useAppContext } from "@/components/app-context";
import { isPrivileged } from "@/lib/roles";
import { assertWritesEnabled } from "@/lib/write-guard";
import {
  LABEL_COLORS,
  fetchLabelCreationSetting,
  fetchLabelIdsFor,
  fetchLabels,
  setLabelsFor,
  type Label,
  type LabelScope,
  type LinkableScope,
} from "@/lib/labels";

type Props = {
  scope: LinkableScope;
  /** Omit for manage-only mode (admin screen). */
  recordId?: string;
  trigger?: ReactNode;
  onSaved?: () => void;
  /** Show the applied labels beside the button. On by default — that is the point. */
  showApplied?: boolean;
};

export function LabelPicker({ scope, recordId, trigger, onSaved, showApplied = true }: Props) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  /*
   * Mark: "the labels need to show."
   *
   * The picker was only ever a button. You could tick GIFTS OK and LEGAL
   * REVIEW, save, and the header would still read "Labels" -- the one place a
   * label exists to be seen. A label nobody can see without opening a popover
   * is not doing the job a label is for.
   *
   * So the applied ones sit beside the button, everywhere the picker is used:
   * the account header, both drawers and the account panel. None of them
   * showed labels by any other route, so none of them double up.
   */
  const appliedQ = useQuery({
    queryKey: ["label-ids", scope, recordId],
    enabled: showApplied && !!recordId,
    queryFn: () => fetchLabelIdsFor(scope, recordId!),
  });
  const allQ = useQuery({
    queryKey: ["labels", scope],
    enabled: showApplied && !!recordId,
    queryFn: () => fetchLabels(scope as LabelScope),
    staleTime: 5 * 60_000,
  });
  const applied = useMemo(() => {
    const ids = new Set(appliedQ.data ?? []);
    // Ordered by the admin's own sort order, not by when somebody ticked them.
    return (allQ.data ?? []).filter((l) => ids.has(l.id));
  }, [appliedQ.data, allQ.data]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {showApplied && applied.length > 0 && (
        <LabelPills labels={applied} max={4} className="mr-1.5" />
      )}
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-[12px]">
            <TagIcon className="size-3.5" /> Labels
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[300px] p-0">
        {open && (
          <LabelPickerBody
            scope={scope}
            recordId={recordId}
            onClose={() => setOpen(false)}
            onSaved={() => {
              // The chips beside the button are the point; they must not lag
              // behind the ticks that were just saved.
              void qc.invalidateQueries({ queryKey: ["label-ids", scope, recordId] });
              onSaved?.();
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

export function LabelPickerBody({
  scope,
  recordId,
  onClose,
  onSaved,
}: {
  scope: LinkableScope;
  recordId?: string;
  onClose?: () => void;
  onSaved?: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [order, setOrder] = useState<Label[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const labelScope: LabelScope = scope;

  const labelsQ = useQuery({
    queryKey: ["labels", labelScope],
    queryFn: () => fetchLabels(labelScope),
  });

  const settingQ = useQuery({ queryKey: ["label-setting"], queryFn: fetchLabelCreationSetting });

  const currentQ = useQuery({
    queryKey: ["record-labels", scope, recordId],
    enabled: !!recordId,
    queryFn: () => fetchLabelIdsFor(scope, recordId!),
  });

  useEffect(() => {
    if (labelsQ.data) setOrder(labelsQ.data);
  }, [labelsQ.data]);

  useEffect(() => {
    if (currentQ.data) setSelected(currentQ.data);
  }, [currentQ.data]);

  const canCreate = isPrivileged(app.roles) || settingQ.data === "everyone";
  const writeBlocked = app.writesDisabled;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return order;
    return order.filter((l) => l.name.toLowerCase().includes(term));
  }, [order, q]);

  const persistOrder = useMutation({
    mutationFn: async (list: Label[]) => {
      assertWritesEnabled(writeBlocked, app.writesDisabledReason);
      await Promise.all(
        list.map((l, i) =>
          l.sort_order === i
            ? Promise.resolve()
            : supabase.from("tags").update({ sort_order: i }).eq("id", l.id),
        ),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["labels"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const saveSelection = useMutation({
    mutationFn: async () => {
      assertWritesEnabled(writeBlocked, app.writesDisabledReason);
      if (!recordId) return;
      await setLabelsFor(scope, recordId, selected, currentQ.data ?? []);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["record-labels", scope, recordId] });
      onSaved?.();
      onClose?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleDrop = (target: number) => {
    if (writeBlocked || dragIndex === null || dragIndex === target) return;
    const next = [...order];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(target, 0, moved);
    setOrder(next);
    setDragIndex(null);
    persistOrder.mutate(next);
  };

  return (
    <div className="flex max-h-[420px] flex-col">
      <div className="relative border-b p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search labels"
          className="h-8 pl-7 text-[13px]"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {labelsQ.isLoading ? (
          <div className="px-3 py-4 text-[12px] text-muted-foreground">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-muted-foreground">No labels found.</div>
        ) : (
          filtered.map((label) => {
            const idx = order.findIndex((l) => l.id === label.id);
            const on = selected.includes(label.id);
            if (editing === label.id && !writeBlocked) {
              return (
                <LabelEditRow
                  key={label.id}
                  label={label}
                  onDone={() => {
                    setEditing(null);
                    qc.invalidateQueries({ queryKey: ["labels"] });
                  }}
                />
              );
            }
            return (
              <div
                key={label.id}
                draggable={!q && !writeBlocked}
                onDragStart={() => setDragIndex(idx)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(idx)}
                className="group flex items-center gap-1.5 px-2 py-1 hover:bg-accent/60"
              >
                <GripVertical
                  className={`size-3.5 shrink-0 text-muted-foreground/40 ${q ? "invisible" : writeBlocked ? "" : "cursor-grab"}`}
                />
                <button
                  type="button"
                  disabled={!recordId || writeBlocked}
                  onClick={() =>
                    setSelected((prev) =>
                      prev.includes(label.id)
                        ? prev.filter((x) => x !== label.id)
                        : [...prev, label.id],
                    )
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
                >
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    {on && <Check className="size-3.5 text-primary" />}
                  </span>
                  <LabelPill label={label} />
                </button>
                {canCreate && !writeBlocked && (
                  <button
                    type="button"
                    onClick={() => setEditing(label.id)}
                    className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                    aria-label={`Edit ${label.name}`}
                  >
                    <Pencil className="size-3 text-muted-foreground" />
                  </button>
                )}
              </div>
            );
          })
        )}

        {creating && !writeBlocked ? (
          <LabelEditRow
            scope={labelScope}
            initialName={q}
            onDone={(created) => {
              setCreating(false);
              qc.invalidateQueries({ queryKey: ["labels"] });
              if (created && recordId) setSelected((prev) => [...prev, created]);
            }}
          />
        ) : (
          canCreate &&
          !writeBlocked && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-primary hover:bg-accent/60"
            >
              <Plus className="size-3.5" /> Add label
            </button>
          )
        )}
      </div>

      {recordId && (
        <div className="flex items-center justify-end gap-2 border-t p-2">
          <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            disabled={saveSelection.isPending || writeBlocked}
            onClick={() => saveSelection.mutate()}
          >
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

/** Inline create/rename/recolour row — no navigation away from the picker. */
function LabelEditRow({
  label,
  scope,
  initialName,
  onDone,
}: {
  label?: Label;
  scope?: LabelScope;
  initialName?: string;
  onDone: (createdId?: string) => void;
}) {
  const [name, setName] = useState(label?.name ?? initialName ?? "");
  const [color, setColor] = useState(label?.color ?? LABEL_COLORS[0]);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      if (label) {
        const { error } = await supabase
          .from("tags")
          .update({ name: trimmed, color })
          .eq("id", label.id);
        if (error) throw error;
        onDone();
      } else {
        const { data, error } = await supabase
          .from("tags")
          .insert({ name: trimmed, color, scopes: [scope ?? "lead"] })
          .select("id")
          .single();
        if (error) throw error;
        onDone(data.id);
      }
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 border-y bg-muted/40 px-2 py-2">
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onDone();
          }}
          placeholder="Label name"
          className="h-7 text-[12px]"
        />
        <Button
          size="sm"
          className="h-7 px-2 text-[12px]"
          disabled={busy}
          onClick={() => void save()}
        >
          <Check className="size-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDone()}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {LABEL_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className={`size-4 rounded-md border ${color === c ? "ring-2 ring-offset-1 ring-primary" : "border-black/10"}`}
            style={{ backgroundColor: c }}
            aria-label={c}
          />
        ))}
      </div>
    </div>
  );
}
