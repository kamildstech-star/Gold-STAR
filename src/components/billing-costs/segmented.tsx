import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The Billing & Costs view switches (Rates / Compare offices, Costs /
 * Supplies book / Overhead engine, Standard / Client agreements). The chosen
 * one is a raised white chip on a grey track, in full-strength text; the rest
 * are muted text on the track. The old secondary-on-white could not be told
 * apart from ghost.
 */
export const SEGMENT_TRACK = "inline-flex flex-wrap gap-0.5 rounded-md border bg-muted p-0.5";

export function SegmentButton({
  on,
  className,
  ...props
}: { on: boolean } & Omit<ComponentProps<typeof Button>, "variant">) {
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={on}
      className={cn(
        on
          ? "bg-card font-semibold text-foreground shadow-[0_1px_2px_rgb(16_24_40_/_0.12)] ring-1 ring-border hover:bg-card"
          : "text-muted-foreground hover:bg-hover hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
