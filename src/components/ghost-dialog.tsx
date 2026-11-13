/**
 * The popup for moving a record to Ghosted by hand.
 *
 * Melly (29 Oct): "The rep can also move someone to Ghosted by hand at any
 * time. Sometimes a rep just knows it is dead. The system does not block
 * this. It quietly notes it, and if a rep is ghosting a lot of records after
 * barely trying, that shows up for the manager."
 *
 * So nothing here is required. `pipeline_ghost_manual` moves the record with
 * a default reason, the ghost-log trigger records the attempt count, and the
 * quick-ghosting sweep is what tells the manager. A note is welcome, never
 * demanded. The generic "why was this lost?" box, which refuses to move
 * anything until something is typed, is for the other lost stages.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import { ghostManually } from "@/lib/pipeline-rules";

export type GhostTarget = { id: string; name: string };

export function GhostDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: GhostTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // A fresh note per record, so last time's never lands on this company.
  useEffect(() => {
    if (target) setNote("");
  }, [target]);

  const save = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await ghostManually(target.id, note.trim() || null);
      toast.success(`${target.name} moved to Ghosted`);
      onOpenChange(false);
      onDone();
    } catch (e) {
      toastDbError(e, { action: "move to Ghosted" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Move {target?.name} to Ghosted?</DialogTitle>
          <DialogDescription>
            Nothing to fill in. The attempts so far are noted with it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="ghost-note">Note (optional)</Label>
          <Textarea
            id="ghost-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything worth remembering if they come back"
          />
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={busy}>
            Move to Ghosted
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
