import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, ArchiveRestore, Plus, Shapes } from "lucide-react";

import { CommitInput } from "@/components/commit-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastDbError } from "@/lib/db-errors";
import {
  EQUIPMENT_TYPES_KEY,
  saveEquipmentType,
  useEquipmentTypes,
  type EquipmentTypeAction,
} from "@/lib/equipment-types";

/**
 * Equipment › Types (Billing & Costs prompt 3): the register's types as data.
 * Add one (name, optional default make and model), rename it, archive it —
 * never delete, since units and money (its T&M rate and cost, item EQ:<key>)
 * hang off it. Every change is in the Billing & Costs change log. Admins only.
 */
export function EquipmentTypesDialog({ disabled }: { disabled?: boolean }) {
  const qc = useQueryClient();
  const q = useEquipmentTypes();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ label: "", default_make: "", default_model: "" });
  const [busy, setBusy] = useState(false);
  const rows = q.data ?? [];
  const live = rows.filter((r) => !r.archived_at);
  const archived = rows.filter((r) => r.archived_at);
  const duplicate = rows.some(
    (r) => r.label.toLowerCase() === draft.label.trim().toLowerCase() && draft.label.trim(),
  );

  async function run(
    action: EquipmentTypeAction,
    type: Parameters<typeof saveEquipmentType>[1],
    done: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      await saveEquipmentType(action, type);
      toast.success(done);
      await qc.invalidateQueries({ queryKey: EQUIPMENT_TYPES_KEY });
      await qc.invalidateQueries({ queryKey: ["billing-costs"] });
      return true;
    } catch (err) {
      toastDbError(err, { action: "Saving the equipment type" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <Shapes className="mr-1.5 size-3.5" aria-hidden />
          Types
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Equipment types</DialogTitle>
          <DialogDescription>
            The types a unit can be. A new type is ready for units at once, and appears in Billing
            &amp; Costs for its T&amp;M rate and cost. Archiving hides it from the pickers; units of
            it keep it.
          </DialogDescription>
        </DialogHeader>
        {q.isError && <p className="text-sm text-destructive">The types could not be read.</p>}
        <ul className="divide-y rounded-md border" data-equipment-types>
          {live.map((t) => (
            <li
              key={t.key}
              className="grid gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center"
            >
              <CommitInput
                value={t.label}
                aria-label={`Name of ${t.label}`}
                className="h-11 md:h-8"
                onCommit={(next) =>
                  next.trim()
                    ? run("edit", { key: t.key, label: next.trim() }, "Type renamed")
                    : Promise.resolve(false)
                }
              />
              <CommitInput
                value={t.default_make ?? ""}
                placeholder="Default make"
                aria-label={`Default make for ${t.label}`}
                className="h-11 md:h-8"
                onCommit={(next) =>
                  run("edit", { key: t.key, default_make: next }, "Default make saved")
                }
              />
              <CommitInput
                value={t.default_model ?? ""}
                placeholder="Default model"
                aria-label={`Default model for ${t.label}`}
                className="h-11 md:h-8"
                onCommit={(next) =>
                  run("edit", { key: t.key, default_model: next }, "Default model saved")
                }
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-11 justify-self-start md:h-8"
                disabled={busy}
                onClick={() => void run("archive", { key: t.key }, `${t.label} archived`)}
              >
                <Archive aria-hidden /> Archive
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2 rounded-md border bg-muted/40 p-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.label.trim() || duplicate) return;
            const ok = await run(
              "add",
              {
                label: draft.label.trim(),
                default_make: draft.default_make.trim(),
                default_model: draft.default_model.trim(),
              },
              `${draft.label.trim()} added`,
            );
            if (ok) setDraft({ label: "", default_make: "", default_model: "" });
          }}
        >
          <div>
            <Input
              value={draft.label}
              onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
              placeholder="New type, e.g. Injector"
              aria-label="New type name"
              aria-invalid={duplicate || undefined}
              className="h-11 md:h-8"
            />
            {duplicate && (
              <p className="mt-1 text-xs text-destructive">
                There is already a type with that name.
              </p>
            )}
          </div>
          <Input
            value={draft.default_make}
            onChange={(e) => setDraft((d) => ({ ...d, default_make: e.target.value }))}
            placeholder="Default make (optional)"
            aria-label="Default make"
            className="h-11 md:h-8"
          />
          <Input
            value={draft.default_model}
            onChange={(e) => setDraft((d) => ({ ...d, default_model: e.target.value }))}
            placeholder="Default model (optional)"
            aria-label="Default model"
            className="h-11 md:h-8"
          />
          <Button
            type="submit"
            className="h-11 md:h-8"
            disabled={busy || !draft.label.trim() || duplicate}
          >
            <Plus aria-hidden /> Add type
          </Button>
        </form>
        {archived.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Archived
            </p>
            <ul className="flex flex-wrap gap-2">
              {archived.map((t) => (
                <li key={t.key}>
                  <Badge variant="secondary" className="gap-1 normal-case tracking-normal">
                    {t.label}
                    <button
                      type="button"
                      className="ml-1 inline-flex items-center gap-0.5 text-link hover:underline"
                      disabled={busy}
                      onClick={() => void run("restore", { key: t.key }, `${t.label} restored`)}
                      aria-label={`Restore ${t.label}`}
                    >
                      <ArchiveRestore className="size-3" aria-hidden /> Restore
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
