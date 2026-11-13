import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Lightning-style "Path" component.
 *
 * A horizontal chevron progress bar for stage-like enums. Completed steps
 * are muted-primary, the current step carries the strong fill, and a
 * terminal step (`won`, `lost`) can be flagged so it takes a semantic
 * success or destructive fill instead.
 *
 * Click a step to advance. Keyboard focus rings are honored via the shared
 * :focus-visible rule so this doubles as a keyboard control.
 */
export interface PathProps<T extends string> {
  stages: readonly T[];
  current: T | null | undefined;
  labels?: Partial<Record<T, string>>;
  /** Stages that should render in success/destructive tone when active. */
  success?: readonly T[];
  destructive?: readonly T[];
  disabled?: boolean;
  onChange?: (next: T) => void;
  className?: string;
}

export function Path<T extends string>({
  stages,
  current,
  labels,
  success = [],
  destructive = [],
  disabled,
  onChange,
  className,
}: PathProps<T>) {
  const currentIdx = current ? stages.indexOf(current) : -1;

  return (
    <div
      role="tablist"
      aria-label="Stage"
      className={cn("flex w-full min-w-0 items-stretch", className)}
    >
      {stages.map((stage, i) => {
        const isFirst = i === 0;
        const isLast = i === stages.length - 1;
        const completed = currentIdx > -1 && i < currentIdx;
        const active = i === currentIdx;
        const isSuccess = active && success.includes(stage);
        const isDestructive = active && destructive.includes(stage);

        // Clip path builds the chevron. First cell keeps a flat left edge;
        // last cell keeps a flat right edge.
        const clip = isFirst
          ? "[clip-path:polygon(0_0,calc(100%-10px)_0,100%_50%,calc(100%-10px)_100%,0_100%)]"
          : isLast
            ? "[clip-path:polygon(0_0,100%_0,100%_100%,0_100%,10px_50%)]"
            : "[clip-path:polygon(0_0,calc(100%-10px)_0,100%_50%,calc(100%-10px)_100%,0_100%,10px_50%)]";

        const tone = isDestructive
          ? "bg-destructive text-destructive-foreground"
          : active || completed || isSuccess
            ? "bg-success text-success-foreground hover:bg-success/90"
            : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground";

        return (
          <button
            key={stage}
            type="button"
            role="tab"
            aria-selected={active}
            aria-current={active ? "step" : undefined}
            disabled={disabled}
            onClick={() => onChange?.(stage)}
            className={cn(
              "relative min-w-0 flex-1 truncate text-xs font-medium transition-colors",
              "py-2 pl-3 pr-4",
              !isFirst && "-ml-[10px] pl-5",
              !isLast && "pr-6",
              tone,
              clip,
              disabled && "cursor-default opacity-70",
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {completed && <Check className="size-3 shrink-0" aria-hidden />}
              <span className="truncate">{labels?.[stage] ?? stage}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
