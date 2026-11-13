import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Toolbar-scale buttons: 28–32px tall, 6px radius, flat. Nothing here carries
 * a shadow — buttons sit in the plane of the page. Primary is Gold Star navy.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 disabled:cursor-not-allowed aria-disabled:pointer-events-none aria-disabled:opacity-40 aria-disabled:cursor-not-allowed data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        /* The one thing to do next on a record. Primary everywhere except Gold
           Star, where it is the brand gold at full saturation (--cta). */
        cta: "bg-cta text-cta-fg font-semibold shadow-[0_1px_2px_rgb(16_24_40_/_0.12)] hover:bg-cta/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-border bg-card hover:bg-hover",
        secondary:
          "border border-transparent bg-secondary text-secondary-foreground hover:bg-hover",
        ghost: "hover:bg-hover",
        /* Semantic outcomes are saturated fills — never outlined, never muted. */
        won: "bg-success text-success-foreground hover:bg-success/90",
        lost: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        link: "text-link underline-offset-2 hover:underline",
      },
      size: {
        /*
         * Sizes read tokens whose fallbacks are the original values, so a
         * screen can scale every default-sized button at once (the job page
         * does, 3 Nov) while a call site's own height or padding class still wins.
         */
        default: "h-[var(--btn-h,2rem)] px-[var(--btn-px,0.75rem)]",
        sm: "h-[var(--btn-sm-h,1.75rem)] px-[var(--btn-sm-px,0.5rem)] text-[length:var(--btn-sm-text,0.75rem)]",
        lg: "h-9 px-4",
        icon: "h-[var(--btn-h,2rem)] w-[var(--btn-h,2rem)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    // data-slot marks the element as a Button whatever it renders as. The
    // touch tap-target rule in styles.css matches <button> by tag, which never
    // reached `<Button asChild><a>` / `<Link>` / `<label>` — ~70 call sites,
    // Call/Text/Email on the job rail among them, that stayed 28px on a phone.
    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
