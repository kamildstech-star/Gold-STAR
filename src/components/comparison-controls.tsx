/**
 * The choices behind a comparative report (21 Oct, David): month over month
 * or year over year, which months, broken down by what, measuring what. The
 * office comes from the page's own office picker, like every report; the
 * months come from here, not the period picker — a comparison is its own
 * calendar. See comparison-report.ts.
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DIMENSIONS,
  MEASURES,
  defaultComparison,
  type ComparisonSpec,
  type ComparisonWindow,
} from "@/lib/comparison-report";

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function ComparisonControls({
  value,
  onChange,
  money,
}: {
  value: ComparisonSpec;
  onChange: (next: ComparisonSpec) => void;
  /** Whether the viewer may see job money; without it only counts are offered. */
  money: boolean;
}) {
  const set = (patch: Partial<ComparisonSpec>) => onChange({ ...value, ...patch });
  const windowKey =
    value.window.kind === "rolling" ? `rolling:${value.window.months}` : value.window.kind;
  const setWindow = (key: string) => {
    let w: ComparisonWindow;
    if (key === "ytd") w = { kind: "ytd" };
    else if (key === "fixed")
      w = { kind: "fixed", from: `${thisMonth().slice(0, 4)}-01`, to: thisMonth() };
    else w = { kind: "rolling", months: Number(key.split(":")[1]) || 6 };
    set({ window: w });
  };
  const measures = MEASURES.filter((m) => money || !m.money);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-comparison-controls>
      <div className="space-y-1">
        <Label className="text-xs">Compare</Label>
        <Select
          value={value.mode}
          onValueChange={(v) => {
            const mode = v as ComparisonSpec["mode"];
            // Each mode starts from its natural window and chart.
            const d = defaultComparison(mode);
            onChange({ ...value, mode, window: d.window, chart: d.chart });
          }}
        >
          <SelectTrigger className="h-11 md:h-9" aria-label="Comparison">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="mom">Month over month</SelectItem>
            <SelectItem value="yoy">Year over year</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Months</Label>
        <Select value={windowKey} onValueChange={setWindow}>
          <SelectTrigger className="h-11 md:h-9" aria-label="Months">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ytd">January to date</SelectItem>
            <SelectItem value="rolling:3">Last 3 months</SelectItem>
            <SelectItem value="rolling:6">Last 6 months</SelectItem>
            <SelectItem value="rolling:12">Last 12 months</SelectItem>
            <SelectItem value="fixed">Choose months…</SelectItem>
          </SelectContent>
        </Select>
        {value.window.kind === "fixed" ? (
          <div className="flex items-center gap-1.5">
            <Input
              type="month"
              className="h-11 md:h-9"
              aria-label="From month"
              value={value.window.from}
              max={thisMonth()}
              onChange={(e) =>
                e.target.value &&
                set({
                  window: {
                    kind: "fixed",
                    from: e.target.value,
                    to: (value.window as { to: string }).to,
                  },
                })
              }
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="month"
              className="h-11 md:h-9"
              aria-label="To month"
              value={value.window.to}
              max={thisMonth()}
              onChange={(e) =>
                e.target.value &&
                set({
                  window: {
                    kind: "fixed",
                    from: (value.window as { from: string }).from,
                    to: e.target.value,
                  },
                })
              }
            />
          </div>
        ) : null}
      </div>

      {value.mode === "yoy" ? (
        <div className="space-y-1">
          <Label className="text-xs">Years side by side</Label>
          <Select value={String(value.years)} onValueChange={(v) => set({ years: Number(v) })}>
            <SelectTrigger className="h-11 md:h-9" aria-label="Years">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">This year and last</SelectItem>
              <SelectItem value="3">Three years</SelectItem>
              <SelectItem value="4">Four years</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1">
        <Label className="text-xs">Broken down by</Label>
        <Select
          value={value.dimension}
          onValueChange={(v) => set({ dimension: v as ComparisonSpec["dimension"] })}
        >
          <SelectTrigger className="h-11 md:h-9" aria-label="Breakdown">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIMENSIONS.map((d) => (
              <SelectItem key={d.key} value={d.key}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Measure</Label>
        <Select
          value={measures.some((m) => m.key === value.measure) ? value.measure : "jobs"}
          onValueChange={(v) => set({ measure: v as ComparisonSpec["measure"] })}
        >
          <SelectTrigger className="h-11 md:h-9" aria-label="Measure">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {measures.map((m) => (
              <SelectItem key={m.key} value={m.key}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!money ? (
          <p className="text-[11px] text-muted-foreground">
            Billed, collected and profit need permission to see job costs.
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Place each job by</Label>
        <Select
          value={value.dateBasis}
          onValueChange={(v) => set({ dateBasis: v as ComparisonSpec["dateBasis"] })}
        >
          <SelectTrigger className="h-11 md:h-9" aria-label="Date basis">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="loss_date">Date of loss</SelectItem>
            <SelectItem value="created_at">Date created</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Chart</Label>
        <Select
          value={value.chart}
          onValueChange={(v) => set({ chart: v as ComparisonSpec["chart"] })}
        >
          <SelectTrigger className="h-11 md:h-9" aria-label="Chart">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bar">Bars</SelectItem>
            <SelectItem value="line">Lines</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <p className="text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-3">
        The months are set here; the period picker above does not apply to a comparison. The office
        picker does. A month still running is marked “to date”, and in year over year earlier years
        are cut to the same day.
      </p>
    </div>
  );
}
