/**
 * Renaming a job (26 Oct): the title on the job page and the Job name column
 * on the Jobs list. Blank goes back to showing the customer, else the address
 * (jobDisplayName) — nothing else about the job changes.
 */
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveJobField } from "@/lib/job-update";

export function JobRenameDialog({
  open,
  onOpenChange,
  jobId,
  current,
  fallback,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId: string;
  /** The stored job name (null when none is set). */
  current: string | null;
  /** What shows when it is blank: the customer, else the address. */
  fallback: string | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(current ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setDraft(current ?? "");
  }, [open, current]);

  const save = async () => {
    const next = draft.trim() || null;
    if (next === (current?.trim() || null)) return onOpenChange(false);
    setSaving(true);
    const ok = await saveJobField(jobId, "job_name", next, "Job name");
    setSaving(false);
    if (ok) {
      onSaved();
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename the job</DialogTitle>
          <DialogDescription>
            Shown as the title here and as the Job name on the Jobs list.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Label htmlFor="job-name">Job name</Label>
          <Input
            id="job-name"
            value={draft}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={fallback ?? "Job name"}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Leave it blank to show the{" "}
            {fallback ? `customer or address (${fallback})` : "customer or address"}.
          </p>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
