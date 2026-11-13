/**
 * The "Custom date range" popup — one implementation for every page that
 * offers a custom window next to its presets.
 *
 * It began life inline on the pipeline page. When Mark asked for the same
 * thing on the leaderboard ("on hte leaderboard page, add a customs date
 * range picker") it moved here so the two pages cannot drift: the same two
 * date boxes, the same rule that the end can't precede the start, and the
 * same promise that nothing is applied until Apply. Typing in a box changes
 * nothing on the page behind it; Cancel leaves whatever period was already
 * chosen exactly as it was.
 *
 * The form lives in its own component under DialogContent on purpose: Radix
 * unmounts the content when the dialog closes, so the drafts start fresh from
 * `initialFrom`/`initialTo` every time it opens, with no effect to keep in
 * step.
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseDateStr } from "@/lib/period";

export type DateRangeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `YYYY-MM-DD`, or "" for an empty box — usually the range already applied. */
  initialFrom?: string;
  initialTo?: string;
  onApply: (range: { from: string; to: string }) => void;
};

export function DateRangeDialog({
  open,
  onOpenChange,
  initialFrom = "",
  initialTo = "",
  onApply,
}: DateRangeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>Custom date range</DialogTitle>
        </DialogHeader>
        <RangeForm
          initialFrom={initialFrom}
          initialTo={initialTo}
          onCancel={() => onOpenChange(false)}
          onApply={(range) => {
            onApply(range);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function RangeForm({
  initialFrom,
  initialTo,
  onCancel,
  onApply,
}: {
  initialFrom: string;
  initialTo: string;
  onCancel: () => void;
  onApply: (range: { from: string; to: string }) => void;
}) {
  const [fromDraft, setFromDraft] = React.useState(initialFrom);
  const [toDraft, setToDraft] = React.useState(initialTo);
  const rangeInvalid = !!fromDraft && !!toDraft && fromDraft > toDraft;

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs">From</Label>
          <Input
            type="date"
            value={fromDraft}
            max={toDraft || undefined}
            onChange={(e) => setFromDraft(e.target.value)}
            className="h-8 text-[12px]"
          />
        </div>
        <div>
          <Label className="text-xs">To</Label>
          <Input
            type="date"
            value={toDraft}
            min={fromDraft || undefined}
            onChange={(e) => setToDraft(e.target.value)}
            className="h-8 text-[12px]"
          />
        </div>
      </div>
      {rangeInvalid && (
        <p className="text-[12px] text-[var(--destructive)]">
          The end date can't be before the start date.
        </p>
      )}
      <DialogFooter>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!parseDateStr(fromDraft) || !parseDateStr(toDraft) || rangeInvalid}
          onClick={() => onApply({ from: fromDraft, to: toDraft })}
        >
          Apply
        </Button>
      </DialogFooter>
    </>
  );
}
