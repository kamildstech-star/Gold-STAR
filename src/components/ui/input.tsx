import * as React from "react";

import { cn } from "@/lib/utils";
import { DateInput } from "@/components/ui/date-input";
import { INPUT_CLASS } from "@/components/ui/input-class";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    /*
     * FE5: a native date box draws in the computer's regional order (day
     * first on a UK-set machine). Every `<Input type="date">` and
     * `type="datetime-local"` is drawn by DateInput instead — MM/DD/YYYY on
     * screen, ISO in e.target.value, so no caller changes.
     */
    if (type === "date" || type === "datetime-local") {
      return (
        <DateInput
          ref={ref}
          type={type as "date" | "datetime-local"}
          className={className}
          {...props}
        />
      );
    }
    return <input type={type} className={cn(INPUT_CLASS, className)} ref={ref} {...props} />;
  },
);
Input.displayName = "Input";

export { Input };
