import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Status badges use the same treatment as label pills: fully rounded, tinted
 * background with darker text of the same hue. Never a saturated fill.
 */
const badgeVariants = cva(
  /* Size and case read tokens whose fallbacks are the original look; the job
     page sets larger, sentence-case pills (3 Nov). */
  "inline-flex items-center rounded-full border px-[var(--badge-px,0.5rem)] py-[var(--badge-py,1px)] text-[length:var(--badge-text,10px)] font-semibold [text-transform:var(--badge-case,uppercase)] leading-[var(--badge-lh,1rem)] tracking-[var(--badge-tracking,0.02em)] transition-colors focus:outline-none focus:ring-1 focus:ring-ring",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--label-blue)] text-[var(--label-blue-fg)]",
        secondary: "border-transparent bg-[var(--label-grey)] text-[var(--label-grey-fg)]",
        destructive: "border-transparent bg-[var(--label-red)] text-[var(--label-red-fg)]",
        success: "border-transparent bg-[var(--label-green)] text-[var(--label-green-fg)]",
        warning: "border-transparent bg-[var(--label-yellow)] text-[var(--label-yellow-fg)]",
        outline: "border-border bg-card text-muted-foreground",
        /* Saturated status pills — OVERDUE, WON, LOST. */
        overdue: "border-transparent bg-destructive text-destructive-foreground",
        solidSuccess: "border-transparent bg-success text-success-foreground",
        solidWarning: "border-transparent bg-warning text-warning-foreground",
      },
    },

    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
