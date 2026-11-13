/**
 * The scope of work the crew performs on site, room by room.
 *
 * Labelled "Scope of work" (David, 12 Oct — he offered "Work order / Scope of
 * work"; the single name is used everywhere a person reads it). The component
 * and file keep their old name so nothing that imports them moves.
 *
 * It is its own field. It never falls back to the important instructions —
 * that is a short site warning, and a crew reading "don't block driveway"
 * under a Scope of work heading would arrive with nothing to do.
 */
import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { useWritesDisabled } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { WorkOrderTranslation } from "@/components/work-order-translation";

export function WorkOrderBlock({
  jobId,
  scope,
  onChange,
}: {
  jobId: string;
  scope: string | null;
  onChange?: (v: string | null) => void;
}) {
  const { disabled: writesDisabled } = useWritesDisabled();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(scope ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const next = draft.trim() || null;
    const { error } = await supabase.from("jobs").update({ scope: next }).eq("id", jobId);
    setSaving(false);
    if (error) return toastDbError(error, { action: "save the scope of work" });
    onChange?.(next);
    setEditing(false);
    toast.success("Scope of work saved");
  };

  if (scope && !editing) {
    return (
      <div className="space-y-2">
        <WorkOrderTranslation
          entityType="job"
          entityId={jobId}
          field="scope"
          text={scope}
          title="Scope of work"
        />
        {!writesDisabled && (
          <Button
            size="sm"
            variant="ghost"
            className="text-xs"
            onClick={() => {
              setDraft(scope);
              setEditing(true);
            }}
          >
            Edit scope of work
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Scope of work</CardTitle>
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              autoFocus
              placeholder={
                'Kitchen — extract standing water, remove wet drywall to 24"…\nBasement — set 2 dehus, 4 air movers…'
              }
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={saving}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(scope ?? "");
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Saved in English; translate it for the crew once it is written.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 rounded-sm border border-dashed p-4 text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <ClipboardList className="size-4" /> No scope of work written yet.
            </span>
            {!writesDisabled && (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Add scope of work
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
