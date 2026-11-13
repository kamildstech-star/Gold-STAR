import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { PersonPicker } from "@/components/person-picker";
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
import { dispatchCrewMember } from "@/lib/job-dispatch";

export function JobDispatchDialog({
  open,
  onOpenChange,
  job,
  exclude = [],
  onDispatched,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: { id: string; jobNumber: string; address: string; locationId: string };
  exclude?: string[];
  onDispatched?: () => void;
}) {
  const [userId, setUserId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const dispatch = async () => {
    if (!userId || pending) return;
    setPending(true);
    try {
      const result = await dispatchCrewMember({
        jobId: job.id,
        jobNumber: job.jobNumber,
        address: job.address,
        userId,
      });
      if (!result.created) {
        toast.info("That crew member is already assigned to this job.");
      } else if (!result.notified) {
        toast.warning("Crew assigned, but no notification was delivered.");
      } else {
        toast.success("Crew member assigned and notified.");
      }
      setUserId(null);
      onOpenChange(false);
      onDispatched?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not dispatch crew.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dispatch crew</DialogTitle>
          <DialogDescription>
            Assign a crew member to {job.jobNumber}. They will receive a notification with the job
            address and a direct link.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Crew member</Label>
          <PersonPicker
            value={userId}
            onChange={setUserId}
            locationId={job.locationId}
            exclude={exclude}
            placeholder="Search by name or email…"
            disabled={pending}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={dispatch} disabled={!userId || pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
