import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One collapsible group on an access screen — the shape Mark pointed at on the
 * user page's Permissions panel: a closed row that reads `AREA  12/14`, so an
 * administrator scans eight closed rows and sees the whole picture, then opens
 * the one that looks wrong.
 *
 * The same component carries page areas on the Roles tab, page areas on the
 * People tab, and capability groups on both, so the three views are one
 * interaction and not three.
 */
export function AccessGroup({
  title,
  count,
  total,
  open,
  onToggle,
  actions,
  hint,
  children,
}: {
  title: string;
  /** Lines that are on. */
  count: number;
  total: number;
  open: boolean;
  onToggle: () => void;
  /** Header controls (Allow all / Clear). Only shown while open, so a closed row stays a plain count. */
  actions?: React.ReactNode;
  /** Small text after the title, e.g. "what this role may do". */
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-sm border">
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent/40"
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate">{title}</span>
          {hint ? (
            <span className="hidden truncate font-normal normal-case tracking-normal sm:inline">
              {hint}
            </span>
          ) : null}
          <span
            className={cn(
              "ml-auto shrink-0 font-mono normal-case tracking-normal",
              count === total ? "text-foreground" : count === 0 ? "" : "text-foreground/80",
            )}
          >
            {count}/{total}
          </span>
        </button>
        {open && actions ? <div className="flex shrink-0 gap-1">{actions}</div> : null}
      </div>
      {open ? <div className="border-t">{children}</div> : null}
    </div>
  );
}
