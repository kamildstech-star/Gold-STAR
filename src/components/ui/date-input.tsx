import * as React from "react";
import { CalendarDays } from "lucide-react";

import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { INPUT_CLASS } from "@/components/ui/input-class";
import {
  isoToLocalDate,
  isoToUS,
  joinIsoDateTime,
  localDateToIso,
  maskUSDate,
  splitIsoDateTime,
  usToIso,
} from "@/lib/us-date-input";

type DateInputProps = Omit<React.ComponentProps<"input">, "type"> & {
  type?: "date" | "datetime-local";
};

/*
 * Classes that place the control in its parent (width, margins, flex/grid
 * placement, display) go on the wrapper; the rest (height, text size,
 * colors) go on the text box, so `className="h-7 w-36 text-[12px]"` sizes it
 * the way it sized the native box.
 */
const PLACEMENT =
  /^(-?m[trblxy]?-|w-|min-w-|max-w-|flex-1$|flex-none$|flex-auto$|grow|shrink|basis-|col-|row-|self-|justify-self-|order-|hidden$|block$|inline)/;

function splitClassName(className: string | undefined): { wrap: string; box: string } {
  const wrap: string[] = [];
  const box: string[] = [];
  for (const token of (className ?? "").split(/\s+/).filter(Boolean)) {
    const base = token.slice(token.lastIndexOf(":") + 1);
    (PLACEMENT.test(base) ? wrap : box).push(token);
  }
  return { wrap: wrap.join(" "), box: box.join(" ") };
}

/** What callers read: `e.target.value` (ISO) and `e.target.name`. */
function syntheticEvent<E extends React.SyntheticEvent<HTMLInputElement>>(
  value: string,
  name: string | undefined,
  type: string,
): E {
  const target = { value, name: name ?? "" };
  return {
    target,
    currentTarget: target,
    type,
    preventDefault() {},
    stopPropagation() {},
    persist() {},
  } as unknown as E;
}

/**
 * A date box that always reads MM/DD/YYYY (FE5, 28 Oct). Type the digits —
 * the slashes go in by themselves — or pick from the calendar. The value
 * going in and coming out is ISO (`YYYY-MM-DD`; `YYYY-MM-DDTHH:mm` for
 * the datetime-local type), exactly what a native date input gives, so
 * `onChange={(e) => set(e.target.value)}` works unchanged. A half-typed date
 * changes nothing until it is a whole, real day; clearing the box sends "".
 */
export const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(
  (
    {
      type = "date",
      value,
      defaultValue,
      onChange,
      onBlur,
      className,
      name,
      min,
      max,
      disabled,
      readOnly,
      placeholder,
      step: _step,
      ...rest
    },
    ref,
  ) => {
    const controlled = value !== undefined;
    const [inner, setInner] = React.useState(String(defaultValue ?? ""));
    const iso = controlled ? String(value ?? "") : inner;
    const withTime = type === "datetime-local";

    // date + time are held apart so a half-entered pair is not lost while the
    // value coming back is still "".
    const [parts, setParts] = React.useState(() => splitIsoDateTime(iso));
    React.useEffect(() => {
      if (!withTime) return;
      if (iso) setParts(splitIsoDateTime(iso));
      else setParts((p) => (joinIsoDateTime(p.date, p.time) ? { date: "", time: "" } : p));
    }, [iso, withTime]);
    const dateIso = withTime ? parts.date : splitIsoDateTime(iso).date;

    const [draft, setDraft] = React.useState(() => isoToUS(dateIso));
    React.useEffect(() => {
      setDraft((d) => (usToIso(d) === dateIso || (!d && !dateIso) ? d : isoToUS(dateIso)));
    }, [dateIso]);

    const [open, setOpen] = React.useState(false);
    const { wrap, box } = splitClassName(className);

    const emit = (next: string) => {
      if (!controlled) setInner(next);
      onChange?.(syntheticEvent<React.ChangeEvent<HTMLInputElement>>(next, name, "change"));
    };

    const commitDate = (nextDate: string) => {
      if (withTime) {
        setParts((p) => ({ ...p, date: nextDate }));
        const joined = joinIsoDateTime(nextDate, parts.time);
        if (joined !== iso) emit(joined);
      } else if (nextDate !== iso) {
        emit(nextDate);
      }
    };

    const typed = (raw: string) => {
      const masked = maskUSDate(raw);
      setDraft(masked);
      if (!masked.trim()) return commitDate("");
      // While typing, only a four-digit year counts: "10/28/20" is on its
      // way to 2026, not a date in 2020. A two-digit year is taken on blur.
      const parsed = usToIso(masked);
      if (parsed && /\d{4}\s*$/.test(masked)) commitDate(parsed);
    };

    const currentValue = () => (withTime ? joinIsoDateTime(dateIso, parts.time) : dateIso);

    const blurred = (e: React.FocusEvent<HTMLInputElement>) => {
      // A whole date (two-digit year too) is taken; a box left half-typed
      // goes back to the last whole date.
      const parsed = draft.trim() ? usToIso(draft) : "";
      const nextDate = parsed ?? dateIso;
      if (parsed !== null && parsed !== dateIso) commitDate(parsed);
      setDraft(isoToUS(nextDate));
      const value = withTime ? joinIsoDateTime(nextDate, parts.time) : nextDate;
      onBlur?.(syntheticEvent<React.FocusEvent<HTMLInputElement>>(value, name, e.type || "blur"));
    };

    const picked = (d: Date | undefined) => {
      if (!d) return;
      const next = localDateToIso(d);
      setDraft(isoToUS(next));
      commitDate(next);
      setOpen(false);
      // A pick is a finished entry: callers that save on blur save now.
      const value = withTime ? joinIsoDateTime(next, parts.time) : next;
      onBlur?.(syntheticEvent<React.FocusEvent<HTMLInputElement>>(value, name, "blur"));
    };

    const minDate = typeof min === "string" ? isoToLocalDate(min) : undefined;
    const maxDate = typeof max === "string" ? isoToLocalDate(max) : undefined;
    const selected = isoToLocalDate(dateIso);
    const locked = disabled || readOnly;

    const dateBox = (
      <div className={cn("relative min-w-0", withTime ? "flex-1" : "w-full")}>
        <input
          {...rest}
          ref={ref}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={placeholder ?? "MM/DD/YYYY"}
          value={draft}
          disabled={disabled}
          readOnly={readOnly}
          data-date-input={type}
          onChange={(e) => typed(e.target.value)}
          onBlur={blurred}
          className={cn(INPUT_CLASS, "pr-7 tabular-nums", box)}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={locked}
              aria-label="Pick a date"
              tabIndex={-1}
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <CalendarDays className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-0">
            <Calendar
              mode="single"
              captionLayout="dropdown"
              selected={selected}
              defaultMonth={selected ?? minDate}
              startMonth={minDate}
              endMonth={maxDate ?? new Date(new Date().getFullYear() + 10, 11)}
              disabled={[
                ...(minDate ? [{ before: minDate }] : []),
                ...(maxDate ? [{ after: maxDate }] : []),
              ]}
              onSelect={picked}
            />
          </PopoverContent>
        </Popover>
      </div>
    );

    return (
      <div className={cn("relative flex w-full items-center gap-1", wrap)}>
        {dateBox}
        {withTime && (
          <input
            type="time"
            aria-label="Time"
            value={parts.time}
            disabled={disabled}
            readOnly={readOnly}
            onChange={(e) => {
              const time = e.target.value;
              setParts((p) => ({ ...p, time }));
              const joined = joinIsoDateTime(parts.date, time);
              if (joined !== iso) emit(joined);
            }}
            className={cn(INPUT_CLASS, "w-[7.5rem] shrink-0", box)}
          />
        )}
        {name && <input type="hidden" name={name} value={currentValue()} />}
      </div>
    );
  },
);
DateInput.displayName = "DateInput";
