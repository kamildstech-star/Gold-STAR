import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { actionErrorMessage } from "@/lib/db-errors";
import { useOptionList } from "@/lib/option-lists";
import { DECLINE_REASONS, declineWithReason } from "@/lib/outcomes";

/**
 * Declining is per chaser. The incident stays live for everyone else, so the
 * copy has to say so or people will think they killed the lead.
 *
 * Reasons come from the admin-managed `chase_decline_reason` option list.
 * Mark, on the old one-tap version: "needs a submit button". Tapping a reason
 * now only selects it (tap again to clear); Submit sends.
 *
 * The reason is optional in the data model — `decline_incident_with_reason`
 * stores free text in `incident_dispatches.decline_reason`, nullable, with no
 * allowed-value check — so Submit is on once a reason is picked OR a note is
 * typed. A note on its own is the "Other" case; there is no separate Other
 * button. A failed write keeps the dialog open with the reason and note intact.
 */
export function DeclineSheet({
  open,
  onOpenChange,
  incidentId,
  onDeclined,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  incidentId: string;
  onDeclined: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { options } = useOptionList("chase_decline_reason");

  // Fall back to the built-in labels only if an admin emptied the list.
  const reasons = options.length
    ? options.map((o) => o.label)
    : DECLINE_REASONS.filter((r) => r !== "Other");

  const canSubmit = !busy && (reason !== null || note.trim().length > 0);

  const reset = () => {
    setReason(null);
    setNote("");
    setError(null);
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const text = [reason, note.trim()].filter(Boolean).join(" — ");
      await declineWithReason(incidentId, text);
      toast("Removed from your board — still live for other chasers");
      reset();
      onDeclined();
    } catch (e) {
      setError(actionErrorMessage(e, "Could not decline"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && busy) return;
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Why are you passing?</DialogTitle>
          <DialogDescription>
            This only clears your board. The incident stays live for everyone else.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Reason">
          {reasons.map((r) => {
            const selected = reason === r;
            return (
              <Button
                key={r}
                type="button"
                variant="outline"
                aria-pressed={selected}
                data-selected={selected ? "" : undefined}
                className={cn(
                  "h-16 whitespace-normal text-[13px] font-semibold leading-tight",
                  selected &&
                    "border-primary bg-primary/10 text-primary ring-2 ring-primary hover:bg-primary/15 hover:text-primary",
                )}
                disabled={busy}
                onClick={() => setReason(selected ? null : r)}
              >
                {r}
              </Button>
            );
          })}
        </div>

        <Textarea
          placeholder="Add a note (optional)"
          aria-label="Add a note (optional)"
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
        />

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              onOpenChange(false);
              reset();
            }}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {busy ? "Submitting…" : "Submit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
