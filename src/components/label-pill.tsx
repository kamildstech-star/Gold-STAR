import { pillStyle, type Label } from "@/lib/labels";
import { cn } from "@/lib/utils";

export function LabelPill({
  label,
  className,
  onRemove,
}: {
  label: Pick<Label, "name" | "color">;
  className?: string;
  onRemove?: () => void;
}) {
  return (
    <span className={cn("pill max-w-[180px]", className)} style={pillStyle(label.color)}>
      <span className="truncate">{label.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="opacity-70 hover:opacity-100"
          aria-label={`Remove ${label.name}`}
        >
          ×
        </button>
      )}
    </span>
  );
}

export function LabelPills({
  labels,
  max = 4,
  className,
}: {
  labels: Pick<Label, "id" | "name" | "color">[];
  max?: number;
  className?: string;
}) {
  if (!labels.length) return <span className="text-[11px] text-muted-foreground">—</span>;
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {shown.map((l) => (
        <LabelPill key={l.id} label={l} />
      ))}
      {rest > 0 && <span className="text-[11px] text-muted-foreground">+{rest}</span>}
    </span>
  );
}
