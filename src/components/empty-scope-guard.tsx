import { Button } from "@/components/ui/button";
import { ArrowRight, Users } from "lucide-react";

/**
 * A scoped view that renders zero rows while the unscoped view has plenty
 * reads as broken software. Say what happened and offer the one toggle that
 * fixes it, rather than showing a bare empty state.
 */
export function EmptyScopeGuard({
  scopedCount,
  unscopedCount,
  scopedLabel = "assigned to you",
  unscopedLabel = "in this location",
  noun = "records",
  onSwitch,
  switchLabel,
  className,
}: {
  scopedCount: number;
  unscopedCount: number;
  /** e.g. "assigned to you" */
  scopedLabel?: string;
  /** e.g. "in this location" */
  unscopedLabel?: string;
  /** e.g. "opportunities" */
  noun?: string;
  onSwitch: () => void;
  switchLabel?: string;
  className?: string;
}) {
  if (scopedCount > 0 || unscopedCount <= 0) return null;

  return (
    <div
      className={
        "flex flex-col gap-2 border border-dashed bg-muted/40 px-3 py-3 text-[13px] sm:flex-row sm:items-center " +
        (className ?? "")
      }
    >
      <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex-1">
        <span className="font-medium">
          You have no {noun} {scopedLabel}.
        </span>{" "}
        <span className="text-muted-foreground">
          There {unscopedCount === 1 ? "is" : "are"} {unscopedCount} {unscopedLabel} — this screen
          is not empty, your slice of it is.
        </span>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onSwitch}>
        {switchLabel ?? `View all ${unscopedCount}`}
        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
