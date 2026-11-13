import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/*
 * Soft banners (3 Nov redesign): the tone lives in the tint, the border and
 * the icon; the words stay in the foreground colour so a warning is as
 * readable as anything else on the page — amber text on an amber wash is
 * about 3:1. Theme tokens throughout, so every palette and dark mode tune it.
 */
export const ALERT_TONE = {
  default: "border-border bg-card [&>svg]:text-muted-foreground",
  neutral: "border-border bg-muted/50 [&>svg]:text-muted-foreground",
  info: "border-chart-1/30 bg-chart-1/[0.07] [&>svg]:text-chart-1",
  success: "border-success/30 bg-success/[0.07] [&>svg]:text-success",
  warning: "border-warning/35 bg-warning/[0.09] [&>svg]:text-warning",
  destructive: "border-destructive/30 bg-destructive/[0.06] [&>svg]:text-destructive",
} as const;

export type AlertTone = keyof typeof ALERT_TONE;

const alertVariants = cva(
  "relative w-full rounded-xl border px-4 py-3 text-sm text-foreground [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-[0.875rem] [&>svg]:size-4 [&>svg~*]:pl-7",
  {
    variants: { variant: ALERT_TONE },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn("mb-1 font-semibold leading-tight", className)} {...props} />
  ),
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm text-foreground/85 [&_p]:leading-relaxed", className)}
    {...props}
  />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
