import { useMemo, useState } from "react";
import { CalendarRange, ChevronsRight, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/jobs";
import {
  GANTT_KIND_LABEL,
  GANTT_KIND_ORDER,
  barPlacement,
  buildGanttWindow,
  dayToIso,
  type GanttBar,
  type GanttKind,
  type GanttWindow,
} from "@/lib/job-gantt";

/* The pinned label column. Wide enough for a full name at 13px, narrow enough
   to leave most of a phone screen for the bars themselves. */
const LABEL_W = 168;
const ROW_H = 30;

const KIND_BAR: Record<GanttKind, string> = {
  job: "border-primary/60 bg-primary/25",
  crew: "border-info/60 bg-info/25",
  equipment: "border-success/60 bg-success/25",
};

const KIND_DOT: Record<GanttKind, string> = {
  job: "bg-primary",
  crew: "bg-info",
  equipment: "bg-success",
};

const OVERDUE_BAR = "border-destructive/70 bg-destructive/25";

/** Below this a bar has no room for text and is carried by its row label. */
const BAR_TEXT_MIN_PX = 88;

/**
 * The chart itself, given bars and nothing else.
 *
 * Deliberately has no idea where the bars came from. The internal job view
 * queries them from the browser; the public share view is handed them by a
 * server function that has already dropped everything the link forbids. Both
 * must draw identically, and a second copy of this file would guarantee they
 * eventually did not.
 */
export function GanttChart({
  bars,
  today,
  warning,
  footnote,
  empty,
  className,
}: {
  bars: GanttBar[];
  /** Which calendar day the "today" line sits on, as a day number. */
  today: number;
  /** Banner above the chart — a failed sub-read, never a decorative note. */
  warning?: React.ReactNode;
  footnote?: React.ReactNode;
  /** Shown instead of the chart when there is genuinely nothing to draw. */
  empty?: React.ReactNode;
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const win = useMemo(() => buildGanttWindow(bars, today), [bars, today]);

  /* Only legend the kinds actually drawn. A "Crew" dot over a chart with no
     crew rows reads as missing data rather than as a hidden option. */
  const kinds = useMemo(
    () => GANTT_KIND_ORDER.filter((k) => bars.some((b) => b.kind === k)),
    [bars],
  );

  if (!win) {
    return (
      <div className={cn("rounded-md border bg-card p-3 text-sm text-muted-foreground", className)}>
        {empty}
      </div>
    );
  }

  const active = bars.find((b) => b.id === activeId) ?? null;

  return (
    <div className={cn("rounded-md border bg-card", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2 text-[13px] font-medium">
          <CalendarRange className="size-4 text-muted-foreground" />
          Schedule
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {kinds.map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-full", KIND_DOT[k])} />
              {GANTT_KIND_LABEL[k]}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <ChevronsRight className="size-3" />
            still running
          </span>
        </div>
      </div>

      {warning && (
        <div className="flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs text-warning">
          <TriangleAlert className="size-3.5 shrink-0" />
          {warning}
        </div>
      )}

      {/* One readout instead of a tooltip per bar: it works the same under a
          mouse and under a thumb, and it never covers the row beside it. */}
      <div className="border-b px-3 py-1.5 text-xs">
        {active ? (
          <span>
            <span className="font-medium">{active.label}</span>
            <span className="text-muted-foreground"> · </span>
            <span className="font-mono tabular-nums">{barRange(active)}</span>
            <span className="text-muted-foreground"> · {active.note}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            Hover or tap a bar for its exact dates. Axis runs{" "}
            <span className="font-mono tabular-nums">{fmtDate(dayToIso(win.startDay))}</span> to{" "}
            <span className="font-mono tabular-nums">{fmtDate(dayToIso(win.endDay))}</span>.
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <div className="relative" style={{ width: LABEL_W + win.trackWidth }}>
          <Gridlines win={win} />

          <AxisRow win={win} ticks={win.bands} className="text-[11px] font-medium" />
          <AxisRow win={win} ticks={win.ticks} className="text-[10px] text-muted-foreground" />

          {GANTT_KIND_ORDER.map((kind) => {
            const rows = bars.filter((b) => b.kind === kind);
            if (rows.length === 0) return null;
            return (
              <div key={kind}>
                <div className="flex border-b bg-muted/40">
                  <div
                    className="sticky left-0 z-30 shrink-0 bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                    style={{ width: LABEL_W }}
                  >
                    {GANTT_KIND_LABEL[kind]}
                  </div>
                  <div className="grow" />
                </div>
                {rows.map((bar) => (
                  <Row
                    key={bar.id}
                    bar={bar}
                    win={win}
                    active={bar.id === activeId}
                    onActivate={setActiveId}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {footnote && (
        <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">{footnote}</div>
      )}
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

/**
 * Tick dividers and the today line, drawn once behind every row. Absolute
 * rather than a repeating gradient because months are not all the same width.
 */
function Gridlines({ win }: { win: GanttWindow }) {
  return (
    /* No z-index on this wrapper on purpose — giving it one would open a
       stacking context and trap the today line below the bars. */
    <div
      className="pointer-events-none absolute inset-y-0"
      style={{ left: LABEL_W, width: win.trackWidth }}
    >
      {win.ticks.map((t) => (
        <div
          key={t.key}
          className="absolute inset-y-0 w-px bg-border/70"
          style={{ left: Math.round(t.offset * win.pxPerDay) }}
        />
      ))}
      {win.todayOffset != null && (
        /* z-20 puts today over the bars but under the pinned labels at z-30. */
        <div
          className="absolute inset-y-0 z-20 w-px bg-destructive"
          style={{ left: Math.round((win.todayOffset + 0.5) * win.pxPerDay) }}
        >
          <span className="absolute -top-px left-0 rounded-br-sm bg-destructive px-1 text-[9px] font-medium leading-4 text-destructive-foreground">
            Today
          </span>
        </div>
      )}
    </div>
  );
}

function AxisRow({
  win,
  ticks,
  className,
}: {
  win: GanttWindow;
  ticks: GanttWindow["ticks"];
  className?: string;
}) {
  return (
    <div className="flex border-b">
      <div
        className="sticky left-0 z-30 shrink-0 border-r bg-card"
        style={{ width: LABEL_W }}
        aria-hidden
      />
      <div className="relative z-10 grid" style={trackStyle(win)}>
        {ticks.map((t) => (
          <div
            key={t.key}
            className={cn("overflow-hidden whitespace-nowrap px-1 py-0.5 tabular-nums", className)}
            style={{ gridColumn: `${t.offset + 1} / span ${t.span}` }}
          >
            {t.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function Row({
  bar,
  win,
  active,
  onActivate,
}: {
  bar: GanttBar;
  win: GanttWindow;
  active: boolean;
  onActivate: (id: string) => void;
}) {
  const { solid, projected } = barPlacement(bar, win);
  const solidPx = solid.span * win.pxPerDay;
  const tone = bar.overdue ? OVERDUE_BAR : KIND_BAR[bar.kind];
  const title = `${bar.label} — ${barRange(bar)}`;

  return (
    <div className="flex border-b last:border-b-0 hover:bg-hover/40">
      <div
        className="sticky left-0 z-30 flex shrink-0 flex-col justify-center border-r bg-card px-3"
        style={{ width: LABEL_W, height: ROW_H }}
      >
        <span className="truncate text-[12px] leading-tight">{bar.label}</span>
        {bar.sublabel && (
          <span className="truncate text-[10px] leading-tight text-muted-foreground">
            {bar.sublabel}
          </span>
        )}
      </div>

      <div
        className="relative z-10 grid items-center"
        style={{ ...trackStyle(win), height: ROW_H }}
      >
        <button
          type="button"
          title={title}
          aria-label={title}
          onMouseEnter={() => onActivate(bar.id)}
          onFocus={() => onActivate(bar.id)}
          onClick={() => onActivate(bar.id)}
          className={cn(
            "relative flex h-5 items-center overflow-hidden rounded-sm border px-1 text-left text-[10px] leading-none",
            tone,
            /* An open-ended bar is squared off and arrowed so it reads as
               "still going", never as a bar that happens to end today. */
            bar.openEnded && "rounded-r-none pr-3.5",
            active && "ring-2 ring-ring",
          )}
          style={{
            gridColumn: `${solid.column} / span ${solid.span}`,
            /* A same-day placement is one column wide; keep it clickable. */
            minWidth: 8,
          }}
        >
          {solidPx >= BAR_TEXT_MIN_PX && (
            <span className="truncate font-mono tabular-nums">{barRange(bar)}</span>
          )}
          {bar.openEnded && (
            <ChevronsRight className="absolute right-0 top-1/2 size-3 -translate-y-1/2 opacity-70" />
          )}
        </button>

        {projected && (
          /* Expected retrieval is a plan, not a record — dashed and hollow so
             it never reads as gear that has actually come back. */
          <div
            title={title}
            onMouseEnter={() => onActivate(bar.id)}
            className="h-5 rounded-r-sm border border-l-0 border-dashed border-warning/70 bg-warning/10"
            style={{
              gridColumn: `${projected.column} / span ${projected.span}`,
              minWidth: 8,
            }}
          />
        )}
      </div>
    </div>
  );
}

function trackStyle(win: GanttWindow): React.CSSProperties {
  return {
    width: win.trackWidth,
    gridTemplateColumns: `repeat(${win.totalDays}, ${win.pxPerDay}px)`,
  };
}

/** "12/03/2026 → 19/03/2026", or the open-ended and projected variants. */
function barRange(bar: GanttBar): string {
  const start = fmtDate(dayToIso(bar.startDay));
  if (bar.projectedEndDay != null) {
    return `${start} → out now, back ${fmtDate(dayToIso(bar.projectedEndDay))}`;
  }
  if (bar.openEnded) return `${start} → still out`;
  return `${start} → ${fmtDate(dayToIso(bar.endDay))}`;
}
