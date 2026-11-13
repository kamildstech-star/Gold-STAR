import { useState } from "react";
import { AlertTriangle, Pencil } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * Site-access and safety info the crew must read before they get out of the
 * van: gate codes, key location, dog on site, no parking before 9am, asbestos.
 * Pinned, warning-styled, and translated on the work order.
 */
export function ImportantInstructions({
  jobId,
  value,
  onChange,
  readOnly,
}: {
  jobId: string;
  value: string | null;
  onChange?: (v: string | null) => void;
  readOnly?: boolean;
}) {
  const app = useAppContext();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  const canEdit = !readOnly && !app.writesDisabled;

  const save = async () => {
    setSaving(true);
    const next = draft.trim() || null;
    const { error } = await supabase
      .from("jobs")
      .update({ important_instructions: next })
      .eq("id", jobId);
    setSaving(false);
    if (error) return toastDbError(error, { action: "save the important instructions" });
    onChange?.(next);
    setEditing(false);
    toast.success("Important instructions saved");
  };

  if (!value && !canEdit) return null;

  if (editing) {
    return (
      <div className="space-y-2 rounded-sm border border-warning/50 bg-warning/10 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide">Important instructions</div>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          placeholder="Gate code, key location, dog on site, no parking before 9am, asbestos suspected…"
          autoFocus
        />
        <div className="flex gap-2">
          <Button size="sm" onClick={save} disabled={saving}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(value ?? "");
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (!value) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="border-warning/50 text-xs"
        onClick={() => setEditing(true)}
      >
        <AlertTriangle className="mr-1 size-3.5 text-warning" /> Add important instructions
      </Button>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-sm border-2 border-warning bg-warning/15 p-3">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold uppercase tracking-wide">Important instructions</div>
        <div className="whitespace-pre-wrap text-sm font-medium">{value}</div>
      </div>
      {canEdit && (
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Edit important instructions"
          onClick={() => setEditing(true)}
        >
          <Pencil className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
