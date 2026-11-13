import type { ReportOption } from "@/lib/reports-engine";
import { cn } from "@/lib/utils";

/**
 * A preset report's own switches, as rows of segmented buttons above the
 * table. Mark, 7 Oct: "and reports, it needs to be able to separate salesman
 * and referrers" — Show: All / Salesmen / Referrers; View: By payee / Lines.
 *
 * Wraps on a phone rather than scrolling sideways, and every button is a 44px
 * target there.
 */
export function ReportOptionsBar({
  options,
  values,
  onChange,
}: {
  options: readonly ReportOption[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-report-options>
      {options.map((o) => (
        <div
          key={o.key}
          role="radiogroup"
          aria-label={o.label}
          className="flex flex-wrap items-center gap-1"
        >
          <span className="label-caps mr-1 text-muted-foreground">{o.label}</span>
          {o.choices.map((c) => {
            const active = values[o.key] === c.value;
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onChange(o.key, c.value)}
                className={cn(
                  "h-11 rounded-md border px-3 text-xs md:h-7 md:px-2",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-card hover:bg-accent",
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
