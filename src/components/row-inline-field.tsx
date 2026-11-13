import { useEffect, useId, useRef, useState } from "react";
import { Pencil } from "lucide-react";

import { cn } from "@/lib/utils";
import { useSectionEdit, useSectionStage } from "@/components/job-inline-field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Click-to-edit for a value that is not a `jobs` column.
 *
 * Rooms, related contacts, crew assignments and equipment placements each live
 * in their own table, so `JobField` cannot reach them — but someone correcting
 * a typo should not have to care which table the value came from. Same
 * behaviour as JobField: click the value, save on blur, escape cancels, and it
 * honours the same section pencil so a card opens all at once.
 */

export type RowFieldKind = "text" | "number" | "date" | "time" | "email" | "phone" | "textarea";

/** A number field hands back a number; every other kind hands back a string. */
type RowFieldValue<K extends RowFieldKind> = K extends "number" ? number : string;

export function RowField<K extends RowFieldKind = "text">({
  value,
  onSave,
  kind,
  placeholder,
  display,
  readOnly,
  className,
  empty = "—",
}: {
  value: string | number | null | undefined;
  onSave: (next: RowFieldValue<K> | null) => void | Promise<void>;
  kind?: K;
  placeholder?: string;
  /** Formatted text for the resting state — the raw value is still what edits. */
  display?: string;
  readOnly?: boolean;
  className?: string;
  empty?: string;
}) {
  const sectionEditing = useSectionEdit();
  const sectionStage = useSectionStage();
  const stageKey = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value == null ? "" : String(value));
  const escaped = useRef(false);
  // The kind decides what the column is given; callers keep the narrow type.
  const saveNow = onSave as (next: string | number | null) => void | Promise<void>;
  /* Opened by its row's pencil: held until Done (see SectionEdit). Opened by
     a click on the value: saved now, as before. */
  const save = (next: string | number | null) =>
    sectionStage && !editing ? sectionStage(stageKey, () => saveNow(next)) : saveNow(next);

  useEffect(() => {
    setText(value == null ? "" : String(value));
  }, [value]);

  const open = !readOnly && (editing || sectionEditing);

  const commit = async () => {
    const raw = text.trim();
    setEditing(false);
    if (raw === "") {
      if (value != null) await save(null);
      return;
    }
    if (kind === "number") {
      const n = Number(raw.replace(/[,\s]/g, ""));
      // A typo like "12a" must not silently blank the column it landed in.
      if (!Number.isFinite(n)) return setText(value == null ? "" : String(value));
      if (n !== value) await save(n);
      return;
    }
    if (raw !== value) await save(raw);
  };

  const blur = () => {
    if (escaped.current) {
      escaped.current = false;
      return;
    }
    void commit();
  };

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      escaped.current = true;
      setText(value == null ? "" : String(value));
      setEditing(false);
    }
    if (e.key === "Enter" && (kind !== "textarea" || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void commit();
    }
  };

  if (open) {
    if (kind === "textarea") {
      return (
        <Textarea
          autoFocus={editing}
          rows={3}
          value={text}
          placeholder={placeholder}
          className={cn("text-[13px]", className)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          onBlur={blur}
        />
      );
    }
    return (
      <Input
        autoFocus={editing}
        type={
          kind === "date"
            ? "date"
            : kind === "time"
              ? "time"
              : kind === "email"
                ? "email"
                : kind === "phone"
                  ? "tel"
                  : "text"
        }
        inputMode={kind === "number" ? "decimal" : kind === "phone" ? "tel" : undefined}
        value={kind === "time" ? text.slice(0, 5) : text}
        placeholder={placeholder}
        className={cn("h-7 px-2 text-[13px]", className)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
        onBlur={blur}
      />
    );
  }

  const shown = display ?? (value == null || value === "" ? empty : String(value));
  // Read-only is plain text: no button, no hover hint, nothing that looks clickable.
  if (readOnly) {
    return <span className={cn("inline-block max-w-full truncate", className)}>{shown}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={cn(
        "group/row -mx-1 inline-flex max-w-full cursor-text items-center gap-1 rounded-sm px-1 text-left hover:bg-muted/60",
        className,
      )}
    >
      <span className="truncate">{shown}</span>
      <Pencil className="size-3 shrink-0 opacity-0 transition-opacity group-hover/row:opacity-60" />
    </button>
  );
}

/**
 * The same idea for a fixed set of choices. Read-only renders the label as
 * text — a greyed-out select reads as "broken" rather than "not yours".
 */
export function RowSelect({
  value,
  onSave,
  options,
  readOnly,
  placeholder,
  className,
  display,
  empty = "—",
}: {
  value: string | null | undefined;
  onSave: (next: string) => void | Promise<void>;
  options: { key: string; label: string }[];
  readOnly?: boolean;
  placeholder?: string;
  className?: string;
  /** Read-only label for a value the option list no longer carries. */
  display?: string;
  empty?: string;
}) {
  if (readOnly) {
    const label = display ?? options.find((o) => o.key === value)?.label ?? empty;
    return <span className={cn("truncate text-xs text-muted-foreground", className)}>{label}</span>;
  }
  return (
    <Select value={value ?? ""} onValueChange={(v) => v && void onSave(v)}>
      <SelectTrigger className={cn("h-7 text-xs", className)}>
        <SelectValue placeholder={placeholder ?? "Choose"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.key} value={o.key}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
