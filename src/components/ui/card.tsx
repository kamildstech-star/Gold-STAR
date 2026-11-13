import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The container primitive. Every panel in the app is one of these, so the
 * four things that make a card read AS a card — corner, edge, elevation and
 * internal padding — are read from tokens here and nowhere else.
 *
 * Padding is deliberately a class (`p-[var(--card-padding)]`) rather than an
 * inline style: `cn()` runs tailwind-merge, so the ~190 call sites that pass
 * their own `p-3`/`p-0` still win. Changing the token moves everything that
 * has not opted out.
 */
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card"
      className={cn(
        "rounded-[var(--radius-card)] border border-[var(--card-border)] bg-card text-card-foreground",
        "shadow-[var(--card-shadow)] transition-shadow hover:shadow-[var(--card-shadow-hover)]",
        className,
      )}
      {...props}
    />
  ),
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-header"
      className={cn(
        "flex flex-col gap-0.5 border-b px-[var(--card-padding)] py-[var(--card-padding-tight)]",
        className,
      )}
      {...props}
    />
  ),
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "text-[length:var(--text-card-title)] [font-weight:var(--card-title-weight,700)] leading-tight tracking-tight text-foreground",
        className,
      )}
      {...props}
    />
  ),
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("text-[length:var(--text-body)] text-muted-foreground", className)}
      {...props}
    />
  ),
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-content"
      className={cn("p-[var(--card-padding)]", className)}
      {...props}
    />
  ),
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex items-center border-t px-[var(--card-padding)] py-[var(--card-padding-tight)]",
        className,
      )}
      {...props}
    />
  ),
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
