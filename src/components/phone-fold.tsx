import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { T } from "@/components/bilingual";
import { cn } from "@/lib/utils";

/**
 * A section folded on a phone and open, untouched, on a desktop.
 *
 * David, 6 Nov call: "it's such a long page on the phones — everything
 * should be collapsed, especially insurance; tap on it and it opens." Below
 * `md` the fold bar IS the section's header: its title, the section's own
 * actions (the edit pencil) and a chevron. The card inside hides its own
 * header on a phone (`max-md:hidden`) so the title is not printed twice; the
 * same pencil element is rendered in both places and CSS shows one. From
 * `md` up nothing here is visible but the children, exactly as before.
 *
 * `defaultOpen` is for the first section on the page (Customer Info): "the
 * first one shows up, then you open any other by tapping on it".
 */
export function PhoneFold({
  title,
  actions,
  defaultOpen = false,
  children,
  className,
}: {
  title: string;
  /** The section's own header actions, shown on the fold bar on a phone. */
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn("min-w-0", className)} data-phone-fold={title} data-open={open || undefined}>
      <div className="flex items-center gap-2 rounded-[var(--radius-card)] border border-[var(--card-border)] bg-card px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold"
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90",
            )}
            aria-hidden
          />
          <span className="truncate">
            <T>{title}</T>
          </span>
        </button>
        {actions}
      </div>
      <div className={cn("min-w-0 md:h-full", open ? "max-md:mt-2" : "max-md:hidden")}>
        {children}
      </div>
    </div>
  );
}

/** For a card inside a PhoneFold: its own header only shows from `md` up. */
export const FOLD_HEADER = "max-md:hidden";
