import * as React from "react";
import { Check, Loader2, Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { errText } from "@/lib/db-errors";

/**
 * Click-to-edit, with an honest save state.
 *
 * The interaction is the one already used by `DrawerField` (detail-drawer.tsx)
 * and `JobField` (job-inline-field.tsx): the value is a button, clicking it
 * opens an input, Enter or blur commits, Escape cancels, a pencil appears on
 * hover, and a field you may not edit is plain read-only text (no disabled
 * control, no "no access" hint). Nothing new is invented here.
 *
 * What is added is the part those two leave to a toast: a field that is saving
 * says so, a field that saved says so, and a field whose save FAILED keeps the
 * editor open with the typed value still in it and the database's own message
 * underneath. A toast that scrolls away while the panel shows the old value is
 * how an edit gets silently lost, and Client 360 is a panel people will sit in
 * and correct six things in a row.
 */

export type InlineFieldKind = "text" | "date" | "datetime-local" | "select";

export type InlineFieldOption = { value: string; label: string };

export type InlineFieldProps = {
  label: string;
  /** The stored value, as the editor should show it. */
  value: string;
  /** What the reader sees when not editing. Defaults to `value` or an em dash. */
  display?: React.ReactNode;
  kind?: InlineFieldKind;
  options?: readonly InlineFieldOption[];
  placeholder?: string;
  /** Null when acceptable, otherwise the sentence to show without saving. */
  validate?: (raw: string) => string | null;
  /** Throw to fail the save — the thrown message is what the reader sees. */
  onSave: (raw: string) => Promise<void>;
  /**
   * False renders the value as plain read-only text. `disabledReason` is shown
   * under it — pass only a read-only-preview reason (View As), never a role
   * reason: a role that may not edit just sees the value.
   */
  canEdit: boolean;
  disabledReason?: string | null;
  /** Extra line under the value — e.g. what an empty field falls back to. */
  hint?: React.ReactNode;
  className?: string;
};

export function InlineField({
  label,
  value,
  display,
  kind = "text",
  options,
  placeholder,
  validate,
  onSave,
  canEdit,
  disabledReason,
  hint,
  className,
}: InlineFieldProps) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);
  const escaped = React.useRef(false);
  const savedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldId = React.useId();

  React.useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  // A value changed elsewhere (another tab, the board refetching) should land
  // in the editor — but never over the top of what someone is typing.
  React.useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const begin = () => {
    if (!canEdit) return;
    setDraft(value);
    setProblem(null);
    setSaved(false);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setProblem(null);
    setDraft(value);
  };

  const commit = async (raw: string) => {
    if (raw === value) {
      setEditing(false);
      setProblem(null);
      return;
    }
    const invalid = validate?.(raw) ?? null;
    if (invalid) {
      setProblem(invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onSave(raw);
      setEditing(false);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      // Stay open, keep what was typed, show what the database said.
      setProblem(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      escaped.current = true;
      e.preventDefault();
      // Escape inside a field belongs to the field, not to the panel behind it.
      e.stopPropagation();
      cancel();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void commit(draft);
    }
  };

  const blur = () => {
    if (escaped.current) {
      escaped.current = false;
      return;
    }
    if (busy) return;
    void commit(draft);
  };

  return (
    <div className={cn("group/inline min-w-0", className)}>
      <div className="flex items-baseline gap-2">
        <label
          htmlFor={editing ? fieldId : undefined}
          className="shrink-0 text-[11px] text-[var(--muted-foreground)]"
        >
          {label}
        </label>
        {busy ? (
          <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--muted-foreground)]">
            <Loader2 className="h-3 w-3 animate-spin" /> Saving…
          </span>
        ) : saved ? (
          <span
            role="status"
            className="inline-flex items-center gap-1 text-[10.5px] text-[var(--success)]"
          >
            <Check className="h-3 w-3" /> Saved
          </span>
        ) : null}
      </div>

      {editing ? (
        kind === "select" ? (
          <select
            id={fieldId}
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => {
              setDraft(e.target.value);
              void commit(e.target.value);
            }}
            onKeyDown={keys}
            className="mt-0.5 h-8 w-full rounded-md border border-[var(--border)] bg-card px-2 text-[12.5px]"
          >
            {(options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <Input
            id={fieldId}
            autoFocus
            type={kind}
            value={draft}
            disabled={busy}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={keys}
            onBlur={blur}
            className="mt-0.5 h-8 text-[12.5px]"
          />
        )
      ) : !canEdit ? (
        /* Not editable: plain text — no disabled button, no hover hint. */
        <div className="mt-0.5 text-[12.5px]">
          <span className={cn("break-words", !value && "text-[var(--muted-foreground)]")}>
            {display ?? (value || "—")}
          </span>
        </div>
      ) : (
        <button
          type="button"
          onClick={begin}
          title="Click to edit"
          aria-label={`Edit ${label}`}
          className="-mx-1 mt-0.5 flex w-[calc(100%+0.5rem)] cursor-text items-center gap-1.5 rounded-sm px-1 text-left text-[12.5px] hover:bg-[var(--surface)]"
        >
          <span
            className={cn("min-w-0 flex-1 break-words", !value && "text-[var(--muted-foreground)]")}
          >
            {display ?? (value || "—")}
          </span>
          <Pencil className="h-3 w-3 shrink-0 text-[var(--muted-foreground)] opacity-0 transition-opacity group-hover/inline:opacity-70" />
        </button>
      )}

      {hint && !problem ? (
        <p className="mt-0.5 text-[10.5px] text-[var(--muted-foreground)]">{hint}</p>
      ) : null}
      {problem ? (
        <p role="alert" className="mt-0.5 text-[11px] text-destructive">
          {problem}
        </p>
      ) : null}
      {!canEdit && disabledReason ? (
        <p className="mt-0.5 text-[10.5px] text-[var(--muted-foreground)]">{disabledReason}</p>
      ) : null}
    </div>
  );
}
