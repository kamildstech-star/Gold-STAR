import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

export type LinkedEditScope = "record" | "job";

/**
 * The question asked when somebody edits a person on a job who was picked from
 * the company's records: is this a correction to the person, or something true
 * only of this job?
 *
 * Both answers write the job's own copy — job data stays frozen, so nothing
 * about this job ever depends on the CRM afterwards. "Update the company
 * record" ALSO writes the contact, so the next job picks up the corrected
 * number. "This job only" is the 2am case: the adjuster gave their mobile for
 * this claim, and the office line on file is still right for everything else.
 *
 * Cancel writes nothing.
 */
export function LinkedEditChoice({
  open,
  personName,
  companyName,
  fieldLabel,
  canUpdateRecord,
  onChoose,
  onCancel,
}: {
  open: boolean;
  personName: string;
  companyName: string | null;
  /** "email", "phone", "name". */
  fieldLabel: string;
  /** False for anyone the contacts policy would refuse: they get job-only. */
  canUpdateRecord: boolean;
  onChoose: (scope: LinkedEditScope) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const choose = async (scope: LinkedEditScope) => {
    setBusy(true);
    try {
      await onChoose(scope);
    } finally {
      setBusy(false);
    }
  };
  const company = companyName ?? "the company";
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && !busy && onCancel()}>
      <AlertDialogContent data-linked-edit-choice>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Change {personName}&rsquo;s {fieldLabel}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {personName} was picked from {company}&rsquo;s records. This job keeps its own copy
            either way.
            {!canUpdateRecord &&
              ` You can't edit ${company}'s records, so this changes the job only.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:gap-2">
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void choose("job")}
            data-scope="job"
          >
            Change for this job only
          </Button>
          {canUpdateRecord && (
            <Button disabled={busy} onClick={() => void choose("record")} data-scope="record">
              Update the company record too
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
