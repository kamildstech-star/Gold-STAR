import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { BAND_BAR, BAND_LABEL, BAND_TEXT, type Score } from "@/lib/scorecard";

/**
 * The score is a judgement about a person, so it is never rendered without a
 * way to see exactly how it was reached. Clicking the number opens the full
 * arithmetic: component, raw value, target, weight, points contributed.
 */
export function ScoreBadge({
  score,
  teamMedian,
  name,
  className,
}: {
  score: Score;
  teamMedian: number | null;
  name: string;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group flex items-baseline gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-accent/70",
            className,
          )}
          aria-label={`Score breakdown for ${name}`}
        >
          {score.value == null ? (
            <span className="text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2">
              Insufficient activity
            </span>
          ) : (
            <>
              <span
                className={cn(
                  "display-heavy text-[20px] leading-none tabular-nums",
                  BAND_TEXT[score.band],
                )}
              >
                {score.value}
              </span>
              <span className="text-[10px] text-muted-foreground">
                /100
                {teamMedian != null && <span className="ml-1">· med {Math.round(teamMedian)}</span>}
              </span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[440px] p-0">
        <ScoreBreakdown score={score} teamMedian={teamMedian} name={name} />
      </PopoverContent>
    </Popover>
  );
}

export function ScoreBreakdown({
  score,
  teamMedian,
  name,
}: {
  score: Score;
  teamMedian: number | null;
  name: string;
}) {
  return (
    <div className="text-[12px]">
      <div className="border-b px-3 py-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="display-heavy text-[13px]">{name}</span>
          <span className={cn("text-[11px]", BAND_TEXT[score.band])}>{BAND_LABEL[score.band]}</span>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {score.group === "chase" ? "Chase weighting" : "Sales weighting"} · {score.activityEvents}{" "}
          logged {score.activityEvents === 1 ? "event" : "events"} in period
          {teamMedian != null && ` · team median ${Math.round(teamMedian)}`}
        </p>
      </div>

      {score.reason && (
        <div className="border-b bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          {score.reason} The components below are shown for context but no score is claimed.
        </div>
      )}

      <table className="w-full">
        <thead>
          <tr className="border-b text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-1 text-left font-medium">Component</th>
            <th className="px-2 py-1 text-right font-medium">Value</th>
            <th className="px-2 py-1 text-right font-medium">Target</th>
            <th className="px-2 py-1 text-right font-medium">Weight</th>
            <th className="px-3 py-1 text-right font-medium">Points</th>
          </tr>
        </thead>
        <tbody>
          {score.lines.map((l) => (
            <tr key={l.component} className="border-b last:border-0 align-top">
              <td className="px-3 py-1.5">
                <div className="font-medium">{l.label}</div>
                <div className="text-[10px] leading-tight text-muted-foreground">
                  {l.meaning}
                  {l.direction === "lower" && " · lower is better"}
                </div>
              </td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums">{l.rawFormatted}</td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                {l.targetFormatted}
              </td>
              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                {l.weight}
              </td>
              <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                {l.attainment == null ? (
                  <span className="text-muted-foreground">n/a</span>
                ) : (
                  l.points.toFixed(1)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        Components with no measurable data are excluded from the total rather than counted as zero.
        Weights are configurable per location in Admin and are not baked into the app.
      </div>
    </div>
  );
}

/** Horizontal bar, coloured by band. Used beside the headline figures. */
export function ScoreBar({ score, className }: { score: Score; className?: string }) {
  const pct = score.value == null ? 0 : Math.max(2, Math.min(100, score.value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-sm bg-muted", className)}>
      <div
        className={cn("h-full", BAND_BAR[score.band])}
        style={{
          width: score.value == null ? "100%" : `${pct}%`,
          opacity: score.value == null ? 0.35 : 1,
        }}
      />
    </div>
  );
}
