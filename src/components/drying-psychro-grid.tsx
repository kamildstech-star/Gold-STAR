/**
 * Psychrometrics, every day at once — days across, readings down.
 *
 * The client, showing Moisture Mapper's Psychrometrics screen: "I like the way
 * it opens up like a chart or calendar type of view and you can put in all
 * days at one time ... right now you have to click each day separately and it
 * takes up a lot more room on the screen." The rules — which figure a day
 * already has, what a changed box saves, the derived rows — are in
 * `src/lib/drying-psychro-grid.ts`; this file is the table and the keys.
 *
 * 11 Nov (client): every room has its own Inside °F and Inside %RH rows
 * ("these two will work repeatedly according to room"), each saving as that
 * room's reading, and the Across / Down switch is gone. Enter moves to the
 * next day; at the last day it wraps to the next row. Tab goes across too.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { DryingReading } from "@/lib/drying-log";
import {
  EXTERIOR_LINE,
  deriveGridDay,
  draftKey,
  effectivePair,
  fmtGridNumber,
  gridChanges,
  gridDateLabel,
  gridDaysFromReadings,
  gridLines,
  type GridCell,
  type GridDrafts,
  type GridField,
  type GridLine,
  type GridSave,
} from "@/lib/drying-psychro-grid";
import { cn } from "@/lib/utils";

type TypedRow = { line: GridLine; field: GridField; label: string };

function signed(n: number | null): string {
  if (n == null) return "—";
  return n > 0 ? `+${fmtGridNumber(n)}` : fmtGridNumber(n);
}

export function DryingPsychroGrid({
  dates,
  readings,
  roomNames,
  selectedDate,
  today,
  onPickDate,
  onSave,
  writesDisabled,
  writesReason,
}: {
  /** Oldest first — the same days the squares show. */
  dates: string[];
  readings: readonly DryingReading[];
  roomNames: ReadonlyMap<string, string>;
  /** The day open in the day form below, highlighted here. */
  selectedDate: string;
  today: string;
  /** A date heading opens that day in the full form (rooms, meter photos). */
  onPickDate: (date: string) => void;
  /** Writes each changed cell as a new reading. */
  onSave: (saves: GridSave[]) => Promise<void>;
  writesDisabled: boolean;
  writesReason: string | null;
}) {
  const [drafts, setDrafts] = useState<GridDrafts>({});
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const lines = useMemo(() => gridLines(roomNames, readings, dates), [roomNames, readings, dates]);
  /** Every typed row, in the order the eye and the Enter key walk them. */
  const typedRows = useMemo<TypedRow[]>(
    () =>
      lines.flatMap((line) => {
        const side = line.point === "exterior" ? "Outside" : "Inside";
        return [
          { line, field: "temp" as const, label: `${side} °F` },
          { line, field: "rh" as const, label: `${side} %RH` },
        ];
      }),
    [lines],
  );
  const days = useMemo(
    () => gridDaysFromReadings(readings, dates, lines),
    [readings, dates, lines],
  );
  const { saves, problems } = useMemo(
    () => gridChanges(drafts, days, dates, lines),
    [drafts, days, dates, lines],
  );
  const problemCells = useMemo(
    () => new Set(problems.map((p) => `${p.date}|${p.line}`)),
    [problems],
  );
  const rooms = lines.filter((l) => l.point === "interior" && l.roomId);

  /*
   * 11 Nov (client): each room opens and closes like an accordion, closed
   * by default, so a ten-room job is a list of names until one is opened.
   * A room with a box that cannot be saved as typed stays open, so the
   * problem is never hidden.
   */
  const [openRooms, setOpenRooms] = useState<ReadonlySet<string>>(() => new Set());
  const roomsWithProblems = useMemo(() => new Set(problems.map((p) => p.line)), [problems]);
  const isOpen = (line: GridLine) =>
    rooms.length === 0 ||
    line.point === "exterior" ||
    openRooms.has(line.key) ||
    roomsWithProblems.has(line.key);
  const toggleRoom = (key: string) => {
    // Opening a room must not move the days: the click focuses the heading,
    // and the browser scrolls the strip to show it. Keep where it was.
    const keep = scrollRef.current?.scrollLeft;
    setOpenRooms((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    requestAnimationFrame(() => {
      if (scrollRef.current && keep != null) scrollRef.current.scrollLeft = keep;
    });
  };
  /** Days with a figure on a room's line, said on its closed heading. */
  const loggedDays = (line: GridLine) =>
    dates.filter((d) => {
      const c = days.get(d)?.[line.key];
      return c != null && c.tempF != null;
    }).length;

  // Open on the newest days, the ones being worked.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [dates.length]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>, row: number, col: number) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    let r = row;
    let c = col + 1;
    // A closed room's rows are not drawn: walk on to the next one that is.
    for (let tries = 0; tries <= typedRows.length; tries++) {
      if (c >= dates.length) {
        c = 0;
        r = (r + 1) % typedRows.length;
      }
      const next = scrollRef.current?.querySelector<HTMLInputElement>(
        `input[data-grid-row="${r}"][data-grid-col="${c}"]`,
      );
      if (next) {
        next.focus();
        next.select();
        return;
      }
      c = dates.length;
    }
  };

  const save = async () => {
    if (saves.length === 0 || problems.length > 0) return;
    setBusy(true);
    try {
      await onSave(saves);
      setDrafts({});
    } finally {
      setBusy(false);
    }
  };

  const cellOf = (date: string, line: string): GridCell =>
    days.get(date)?.[line] ?? { tempF: null, rh: null, source: null, note: null };

  return (
    <div className="space-y-2" data-testid="drying-psychro-grid">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted-foreground">
          Type every day at once. Grey outside figures were filled in automatically.
        </p>
      </div>

      <div ref={scrollRef} className="overflow-x-auto rounded-md border">
        <table className="w-max min-w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b bg-muted/40">
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-[9.5rem] bg-muted px-3 py-2 text-left text-[12px] font-semibold"
              >
                Dates
              </th>
              {dates.map((d) => (
                <th key={d} scope="col" className="px-1 py-1.5">
                  <button
                    type="button"
                    onClick={() => onPickDate(d)}
                    title="Open this day for rooms and meter photos"
                    className={cn(
                      "w-full rounded-md px-1.5 py-1 text-[12px] tabular-nums hover:bg-background",
                      d === selectedDate && "bg-primary/15 font-semibold text-foreground",
                      d === today ? "font-semibold" : "font-medium text-muted-foreground",
                    )}
                  >
                    {gridDateLabel(d)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {typedRows.map((row, rowIndex) => (
              <Fragment key={`${row.line.key}-${row.field}`}>
                {/* A room's name heads its pair (11 Nov: one pair per room). */}
                {/* The name sits in the sticky first column, like every row
                    label: a cell spanning the table scrolls out of view with
                    the days, since the grid opens on the newest. */}
                {row.field === "temp" && row.line.point === "interior" && rooms.length > 0 ? (
                  <tr
                    className="border-b bg-muted/60"
                    data-grid-room={row.line.key}
                    data-open={isOpen(row.line) || undefined}
                  >
                    <th scope="rowgroup" className="sticky left-0 z-10 bg-muted p-0 text-left">
                      <button
                        type="button"
                        onClick={() => toggleRoom(row.line.key)}
                        aria-expanded={isOpen(row.line)}
                        title={row.line.label}
                        className="flex w-full max-w-[12rem] items-center gap-1.5 px-3 py-1.5 text-left text-[12px] font-semibold text-foreground hover:bg-background/60"
                      >
                        <ChevronRight
                          className={cn(
                            "size-3.5 shrink-0 text-muted-foreground transition-transform",
                            isOpen(row.line) && "rotate-90",
                          )}
                          aria-hidden
                        />
                        <span className="truncate">{row.line.label}</span>
                        {!isOpen(row.line) ? (
                          <span className="shrink-0 font-normal text-muted-foreground">
                            · {loggedDays(row.line)}d
                          </span>
                        ) : null}
                      </button>
                    </th>
                    <td colSpan={dates.length} aria-hidden />
                  </tr>
                ) : null}
                {!isOpen(row.line) ? null : (
                  <GridRows
                    rowIndex={rowIndex}
                    row={row}
                    dates={dates}
                    drafts={drafts}
                    cellOf={cellOf}
                    problemCells={problemCells}
                    disabled={writesDisabled || busy}
                    onChange={(key, value) => setDrafts((d) => ({ ...d, [key]: value }))}
                    onKey={onKey}
                    // After each pair, the rows derived from it.
                    after={
                      row.field === "rh" ? (
                        <DerivedRows
                          line={row.line}
                          dates={dates}
                          drafts={drafts}
                          cellOf={cellOf}
                        />
                      ) : null
                    }
                  />
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">
          {rooms.length > 0
            ? "Each room's inside figures save as that room's reading. For a meter photo, click the date to open that day."
            : "Inside saves as the whole property's reading. Add rooms on the Rooms tab to log each one. For a meter photo, click the date to open that day."}
        </p>
        {problems.length > 0 ? (
          <span className="text-[12px] font-medium text-destructive">
            {problems.length === 1 ? "1 entry needs" : `${problems.length} entries need`} both a
            temperature and a humidity (1–100%)
          </span>
        ) : null}
        {Object.keys(drafts).length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setDrafts({})} disabled={busy}>
            Discard
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={save}
          disabled={busy || writesDisabled || saves.length === 0 || problems.length > 0}
          title={writesReason ?? undefined}
        >
          {busy
            ? "Saving…"
            : saves.length === 0
              ? "Save"
              : `Save ${saves.length} reading${saves.length === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}

function GridRows({
  rowIndex,
  row,
  dates,
  drafts,
  cellOf,
  problemCells,
  disabled,
  onChange,
  onKey,
  after,
}: {
  rowIndex: number;
  row: TypedRow;
  dates: string[];
  drafts: GridDrafts;
  cellOf: (date: string, line: string) => GridCell;
  problemCells: ReadonlySet<string>;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
  onKey: (e: KeyboardEvent<HTMLInputElement>, row: number, col: number) => void;
  after: React.ReactNode;
}) {
  return (
    <>
      <tr className="border-b">
        <th
          scope="row"
          className="sticky left-0 z-10 bg-card px-3 py-1 text-left text-[12.5px] font-medium"
        >
          {row.label}
        </th>
        {dates.map((date, col) => {
          const key = draftKey(date, row.line.key, row.field);
          const cell = cellOf(date, row.line.key);
          const typed = drafts[key];
          const stored = row.field === "temp" ? cell.tempF : cell.rh;
          const value = typed !== undefined ? typed : fmtGridNumber(stored);
          const problem = problemCells.has(`${date}|${row.line.key}`);
          const fromElsewhere =
            typed === undefined && (cell.source === "weather" || cell.source === "room");
          return (
            <td key={date} className="px-1 py-1">
              <input
                type="text"
                inputMode="decimal"
                value={value}
                disabled={disabled}
                aria-label={`${row.line.point === "interior" && row.line.roomId ? `${row.line.label} ` : ""}${row.label}, ${gridDateLabel(date)}`}
                title={typed === undefined ? (cell.note ?? undefined) : undefined}
                data-grid-row={rowIndex}
                data-grid-col={col}
                onChange={(e) => onChange(key, e.target.value)}
                onKeyDown={(e) => onKey(e, rowIndex, col)}
                onFocus={(e) => e.currentTarget.select()}
                className={cn(
                  "h-8 w-[4.25rem] rounded-md border bg-background px-1 text-center tabular-nums outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/25 disabled:opacity-60",
                  fromElsewhere && "italic text-muted-foreground",
                  typed !== undefined && "border-primary/50 font-medium",
                  problem &&
                    "border-destructive focus:border-destructive focus:ring-destructive/25",
                )}
              />
            </td>
          );
        })}
      </tr>
      {after}
    </>
  );
}

function DerivedRows({
  line,
  dates,
  drafts,
  cellOf,
}: {
  line: GridLine;
  dates: string[];
  drafts: GridDrafts;
  cellOf: (date: string, line: string) => GridCell;
}) {
  const derived = dates.map((date) =>
    deriveGridDay(
      effectivePair(drafts, date, EXTERIOR_LINE.key, cellOf(date, EXTERIOR_LINE.key)),
      line.point === "interior"
        ? effectivePair(drafts, date, line.key, cellOf(date, line.key))
        : { tempF: null, rh: null },
    ),
  );
  const rows: { label: string; values: string[] }[] =
    line.point === "exterior"
      ? [{ label: "Outside GPP", values: derived.map((d) => fmtGridNumber(d.outsideGpp) || "—") }]
      : [
          { label: "Inside GPP", values: derived.map((d) => fmtGridNumber(d.insideGpp) || "—") },
          {
            label: "Inside dew point °F",
            values: derived.map((d) => fmtGridNumber(d.insideDewPoint) || "—"),
          },
          {
            label: "GPP difference (in − out)",
            values: derived.map((d) => signed(d.gppDifference)),
          },
        ];
  return (
    <>
      {rows.map((r) => (
        <tr key={r.label} className="border-b bg-muted/30">
          <th
            scope="row"
            className="sticky left-0 z-10 bg-muted px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground"
          >
            {r.label}
          </th>
          {r.values.map((v, i) => (
            <td
              key={dates[i]}
              className="px-1 py-1.5 text-center text-[12.5px] tabular-nums text-muted-foreground"
            >
              {v}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
