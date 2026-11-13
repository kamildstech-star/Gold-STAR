import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Maximize2, Pencil, X, type LucideIcon } from "lucide-react";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDetailSurface } from "@/components/master-detail";

/**
 * Record detail surface. Inside a master-detail split it renders inline beside
 * the list; anywhere else (and on mobile) it falls back to a slide-over sheet.
 */
export function DetailDrawer({
  open,
  onOpenChange,
  title,
  subtitle,
  headerExtra,
  footer,
  expandHref,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  headerExtra?: ReactNode;
  footer?: ReactNode;
  /** Full-record route opened by the expand control. */
  expandHref?: string;
  children: ReactNode;
}) {
  const surface = useDetailSurface();
  const navigate = useNavigate();
  const href = expandHref ?? surface?.expandHref;

  const header = (inSheet: boolean) => (
    <div className="shrink-0 border-b px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {inSheet ? (
            <SheetTitle className="font-display truncate text-[15px] font-semibold leading-tight">
              {title}
            </SheetTitle>
          ) : (
            <h2 className="font-display truncate text-[15px] font-semibold leading-tight">
              {title}
            </h2>
          )}
          {subtitle && (
            <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <span className="flex shrink-0 items-center gap-0.5">
          {href && (
            <a
              href={href}
              aria-label="Open full record"
              title="Open full record"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.button === 1) return;
                e.preventDefault();
                void navigate({ to: href });
              }}
              className="inline-flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              <Maximize2 className="size-3.5" />
            </a>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label="Close"
            className="size-8 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </span>
      </div>
      {headerExtra && <div className="mt-1.5">{headerExtra}</div>}
    </div>
  );

  if (surface?.inPanel) {
    if (!open) return null;
    return (
      <div className="flex h-full min-h-0 flex-col bg-card">
        {header(false)}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0 border-t bg-surface px-3 py-2">{footer}</div>}
      </div>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-[560px]"
        aria-describedby={undefined}
        /* The header below has its own ×, beside Open full record; the
           sheet's corner one sat on top of it (4 Nov). */
        hideClose
      >
        {header(true)}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="shrink-0 border-t bg-muted/30 px-3 py-2.5">{footer}</div>}
      </SheetContent>
    </Sheet>
  );
}

export function DrawerSection({
  title,
  titleClassName,
  action,
  collapsible,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  /** Override the default small-caps heading look. */
  titleClassName?: string;
  action?: ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-b py-1">
      <div className="flex items-center justify-between gap-2 px-3 py-1">
        {collapsible ? (
          <button
            type="button"
            onClick={onToggle}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
          >
            <ChevronDown
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                collapsed && "-rotate-90",
              )}
            />
            <h3
              className={cn(
                "truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                titleClassName,
              )}
            >
              {title}
            </h3>
          </button>
        ) : (
          <h3
            className={cn(
              "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
              titleClassName,
            )}
          >
            {title}
          </h3>
        )}
        {action}
      </div>
      {!collapsed && <div>{children}</div>}
    </section>
  );
}

/**
 * Icon-led key/value line. Click the value to edit in place — no boxed form.
 */
export function DrawerField({
  icon: Icon,
  label,
  value,
  display,
  onSave,
  type = "text",
  readOnly,
  options,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value?: string | null;
  display?: ReactNode;
  onSave?: (next: string) => Promise<void> | void;
  type?: "text" | "email" | "tel" | "number" | "date";
  readOnly?: boolean;
  /**
   * Turns the field into a picker rather than a text box. A drawer field that
   * holds one of a fixed set -- a decision role, a position -- was previously
   * either read-only or a free-text box someone could mistype into, and a
   * mistyped position is worse than none because it looks recorded.
   */
  options?: { value: string; label: string }[];
  /**
   * One quiet line under the value, for a field whose NAME does not settle
   * what belongs in it. Added for Position vs Custom title, which a reader
   * could not tell apart when they sat side by side with no explanation.
   */
  hint?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);

  const begin = () => {
    if (readOnly || !onSave) return;
    setDraft(value ?? "");
    setEditing(true);
  };

  const commitWith = async (next: string) => {
    if (!onSave) return;
    setBusy(true);
    try {
      await onSave(next.trim());
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const commit = () => commitWith(draft);

  return (
    <div className="group grid grid-cols-[16px_72px_minmax(0,1fr)_auto] items-center gap-2 px-4 py-[7px] hover:bg-accent/40">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="truncate text-[12px] text-muted-foreground">{label}</span>
      {editing && options ? (
        <Select
          value={draft}
          onValueChange={(v) => {
            // Committing on choice, not on a tick: a picker has no half-typed
            // state worth protecting, and one gesture beats two.
            setDraft(v);
            void commitWith(v);
          }}
        >
          <SelectTrigger className="h-6 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : editing ? (
        <Input
          autoFocus
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="h-6 text-[12px]"
        />
      ) : readOnly || !onSave ? (
        <span
          className={cn(
            "min-w-0 break-words text-left text-[12.5px]",
            value || display ? "" : "text-muted-foreground",
          )}
        >
          {display ?? (value || "—")}
        </span>
      ) : (
        <button
          type="button"
          onClick={begin}
          className={cn(
            "min-w-0 break-words text-left text-[12.5px]",
            "cursor-text",
            value || display ? "" : "text-muted-foreground",
          )}
        >
          {display ?? (value || "—")}
        </button>
      )}
      {editing && !options ? (
        <span className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="size-6 p-0"
            disabled={busy}
            onClick={() => void commit()}
          >
            <Check className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="size-6 p-0"
            onClick={() => setEditing(false)}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      ) : (
        <span className="w-4">
          {!readOnly && onSave && (
            <Pencil className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </span>
      )}
      {/* Under the value, in the value's column — a hint under the label would
          read as part of the label. Hidden while editing, where the control
          already has the focus and the room. */}
      {hint && !editing && (
        <p className="col-start-3 -mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
