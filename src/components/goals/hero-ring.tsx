import { cn } from "@/lib/utils";

/**
 * The big attainment ring on My Goals.
 *
 * Null attainment means nobody set a target — it is drawn empty with a dash,
 * never as 0%, so a rep is not told they failed at a goal that does not exist.
 */
export function HeroRing({
  value,
  size = 168,
  thickness = 14,
  label,
}: {
  value: number | null;
  size?: number;
  thickness?: number;
  label?: string;
}) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const clamped = value == null ? 0 : Math.max(0, Math.min(1, value));
  const tone =
    value == null
      ? "var(--muted-foreground)"
      : clamped >= 1
        ? "var(--success)"
        : clamped >= 0.6
          ? "var(--brand-gold)"
          : "var(--brand)";

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--muted)"
          strokeWidth={thickness}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped)}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div
          className={cn(
            "font-display text-[34px] font-bold leading-none tabular-nums",
            value == null && "text-muted-foreground",
          )}
        >
          {value == null ? "—" : `${Math.round(value * 100)}%`}
        </div>
        <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label ?? "complete"}
        </div>
      </div>
    </div>
  );
}
