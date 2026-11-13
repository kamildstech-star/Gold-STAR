import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type MultiSelectOption = {
  value: string;
  /** Shown in the list and used as the trigger label when exactly one is picked. */
  label: string;
  /** Optional muted suffix rendered after the label in the list only. */
  hint?: string;
};

/**
 * Generic multi-select dropdown: search box, checkbox rows, "All" toggle and
 * Clear. Styled to sit next to the shadcn `SelectTrigger` used across the app,
 * so it can replace a single-select filter without a visual seam.
 *
 * Selection semantics are `IN (…)`: an empty array means "no filter", never
 * "match nothing".
 */
export function MultiSelect({
  options,
  value,
  onChange,
  emptyLabel,
  noun,
  pluralNoun,
  allLabel,
  searchPlaceholder,
  emptyMessage,
  icon: Icon,
  className,
  contentClassName,
  align = "start",
  disabled,
  ariaLabel,
  modal = true,
}: {
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Trigger label when nothing is selected, e.g. "Any office". */
  emptyLabel: string;
  /** Counting noun for the trigger, e.g. "office" -> "3 offices". */
  noun: string;
  /** Override when the plural isn't noun + "s". */
  pluralNoun?: string;
  /** Label on the select-all row, e.g. "All offices". */
  allLabel?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  contentClassName?: string;
  align?: "start" | "center" | "end";
  disabled?: boolean;
  ariaLabel?: string;
  /**
   * Modal by default, exactly like Radix `Select`: it blocks outside pointer
   * events, which is what stops a parent Popover (the Pipeline "Filters"
   * panel) from dismissing itself the moment you click inside this one.
   */
  modal?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");

  const plural = pluralNoun ?? `${noun}s`;

  const matches = React.useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(t) || (o.hint ?? "").toLowerCase().includes(t),
    );
  }, [options, q]);

  // A stale id (office removed, rep deactivated) must not be counted as "all".
  const known = React.useMemo(() => new Set(options.map((o) => o.value)), [options]);
  const selectedKnown = value.filter((v) => known.has(v));
  const allOn = options.length > 0 && selectedKnown.length === options.length;

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  const label =
    value.length === 0
      ? emptyLabel
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? `1 ${noun}`)
        : `${value.length} ${plural}`;

  return (
    <Popover
      modal={modal}
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel ?? emptyLabel}
          className={cn(
            "flex h-8 w-full items-center justify-between gap-1 whitespace-nowrap rounded-md border border-input bg-card px-2 py-1 text-[13px] ring-offset-background cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            value.length === 0 && "text-muted-foreground",
            className,
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {Icon ? <Icon className="size-3.5 shrink-0 text-[var(--muted-foreground)]" /> : null}
            <span className="truncate text-left">{label}</span>
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className={cn("w-(--radix-popover-trigger-width) min-w-[220px] p-0", contentClassName)}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b p-2">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder ?? `Search ${plural}…`}
            className="h-8 text-[12.5px]"
          />
        </div>

        {options.length > 0 && (
          <button
            type="button"
            onClick={() => onChange(allOn ? [] : options.map((o) => o.value))}
            className="flex w-full items-center gap-2 border-b px-2.5 py-2 text-left text-[12.5px] font-medium hover:bg-muted"
          >
            <span
              className={cn(
                "grid size-4 shrink-0 place-items-center rounded-[4px] border",
                allOn ? "border-primary bg-primary text-primary-foreground" : "border-input",
              )}
            >
              {allOn ? <Check className="size-3" /> : null}
            </span>
            {allLabel ?? `All ${plural}`}
          </button>
        )}

        <div className="max-h-64 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-muted-foreground">
              {emptyMessage ?? `No ${plural} match.`}
            </p>
          ) : (
            matches.map((o) => {
              const on = value.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  aria-pressed={on}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-muted"
                >
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-[4px] border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-input",
                    )}
                  >
                    {on ? <Check className="size-3" /> : null}
                  </span>
                  <span className="truncate">
                    {o.label}
                    {o.hint ? <span className="ml-1 text-muted-foreground">{o.hint}</span> : null}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {value.length > 0 && (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-[12px]"
              onClick={() => onChange([])}
            >
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
