import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useBlocker } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The Billing & Costs tabs' one save model: edits collect until Save, this bar
 * sticks to the bottom while anything is pending, takes an optional note for
 * the change log, and refuses Save while a change would be refused — with the
 * reason on the row. Leaving the page with changes pending asks first.
 */
export function SaveBar({
  pending,
  problems,
  note,
  onNote,
  saving,
  onSave,
  onDiscard,
  extra,
  hint = "Nothing is saved until you press Save.",
  noteRequired = false,
}: {
  pending: number;
  problems: number;
  note: string;
  onNote: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Controls for this tab's save (e.g. when a rate takes effect). */
  extra?: ReactNode;
  hint?: ReactNode;
  /** The overhead engine asks why, every time. */
  noteRequired?: boolean;
}) {
  useBlocker({
    shouldBlockFn: () =>
      pending > 0 && !window.confirm("You have unsaved changes. Leave and lose them?"),
    enableBeforeUnload: () => pending > 0,
  });
  if (pending === 0) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-card shadow-[0_-4px_12px_rgb(16_24_40_/_0.08)]"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-3">
        <div className="mr-auto min-w-0">
          <p className="text-sm font-medium">
            {pending} unsaved change{pending === 1 ? "" : "s"}
          </p>
          {problems > 0 ? (
            <p className="flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Fix {problems} problem{problems === 1 ? "" : "s"} marked above to save.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{hint}</p>
          )}
        </div>
        {extra}
        <Input
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder={
            noteRequired ? "Why? Required for the change log" : "Note for the change log (optional)"
          }
          aria-label="Note for the change log"
          aria-required={noteRequired || undefined}
          maxLength={500}
          className="h-11 w-full sm:w-72 md:h-8"
        />
        <Button variant="outline" className="h-11 md:h-8" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button
          variant="cta"
          className="h-11 md:h-8"
          onClick={onSave}
          disabled={saving || problems > 0 || (noteRequired && !note.trim())}
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
