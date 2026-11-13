import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The small boxes the job's Billing tab lists invoices and estimates in.
 *
 * David, 5 Nov (T7): "show only 6 to 8 invoice boxes and put the rest in a
 * scroll", and estimates "in the same small boxes" as invoices, not long
 * rows. One list and one box class, so the two cards cannot drift.
 *
 * Two boxes a row once the card is wide enough (29 Oct, a container query —
 * the card is half a split on a desktop), one on a phone. The list is cut
 * at the bottom of its eighth box and scrolls the rest inside the card. The
 * cut is measured, not guessed: a box is taller on a phone, where its
 * buttons are touch-sized, so no fixed height would land on eight.
 */
export const BILLING_BOX_CAP = 8;

export const BILLING_BOX =
  "flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-xs " +
  "shadow-[var(--card-shadow)] transition-shadow hover:shadow-[var(--card-shadow-hover)]";

export function BillingBoxList({
  children,
  label,
  className,
  ...rest
}: {
  children: ReactNode;
  label: string;
  className?: string;
} & Record<`data-${string}`, unknown>) {
  const ref = useRef<HTMLUListElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const ul = ref.current;
    if (!ul || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const items = ul.children;
      if (items.length <= BILLING_BOX_CAP) return setMaxHeight(null);
      // The eighth box ends the eighth row of one, or the fourth row of two.
      const last = items[BILLING_BOX_CAP - 1] as HTMLElement;
      const bottom = last.offsetTop + last.offsetHeight - ul.offsetTop;
      setMaxHeight((prev) => (prev === bottom ? prev : bottom));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(ul);
    return () => ro.disconnect();
  }, [children]);

  return (
    <div className="@container min-w-0">
      <ul
        ref={ref}
        aria-label={label}
        className={cn(
          "grid min-w-0 grid-cols-1 gap-2 @[34rem]:grid-cols-2",
          maxHeight != null && "overflow-y-auto overscroll-contain pr-1",
          className,
        )}
        style={maxHeight != null ? { maxHeight } : undefined}
        {...rest}
      >
        {children}
      </ul>
    </div>
  );
}
