import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  chartDimensions,
  chartMeasures,
  type CustomReportDefinition,
  type CustomReportView,
} from "@/lib/custom-reports";
import { cn } from "@/lib/utils";

/**
 * Data or chart, for a custom report. David, 22 Sep: "the custom reports
 * should have include different type of charts, including charts or just
 * data... broken down by different states and different tabs." Data is the
 * default; Chart groups by one of the area's natural dimensions — office,
 * state, stage or status, month, a category such as carrier — and draws one
 * measure. The choice is saved with the report.
 */
export function CustomChartControls({
  def,
  onChange,
}: {
  def: CustomReportDefinition;
  onChange: (view: CustomReportView) => void;
}) {
  const view: CustomReportView = def.view ?? { mode: "table" };
  const dims = chartDimensions(def.area);
  const measures = chartMeasures(def.area);
  const set = (patch: Partial<CustomReportView>) =>
    onChange({
      kind: "bar",
      groupBy: dims[0]?.key,
      measure: "count",
      ...view,
      ...patch,
    });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex rounded-md border p-0.5" role="group" aria-label="Show as">
        {(["table", "chart"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={view.mode === m}
            onClick={() => set({ mode: m })}
            className={cn(
              "min-h-11 rounded px-3 text-xs md:min-h-8",
              view.mode === m ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            {m === "table" ? "Data" : "Chart"}
          </button>
        ))}
      </div>
      {view.mode === "chart" ? (
        <>
          <div className="space-y-1">
            <Label className="text-xs">Type</Label>
            <Select
              value={view.kind ?? "bar"}
              onValueChange={(v) => set({ kind: v as CustomReportView["kind"] })}
            >
              <SelectTrigger className="h-11 w-28 md:h-8" aria-label="Chart type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bar">Bar</SelectItem>
                <SelectItem value="line">Line</SelectItem>
                <SelectItem value="pie">Pie</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Broken down by</Label>
            <Select
              value={view.groupBy ?? dims[0]?.key ?? ""}
              onValueChange={(v) => set({ groupBy: v })}
            >
              <SelectTrigger className="h-11 w-40 md:h-8" aria-label="Group by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dims.map((d) => (
                  <SelectItem key={d.key} value={d.key}>
                    {d.label}
                    {d.dimension === "month" ? " (by month)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Measure</Label>
            <Select value={view.measure ?? "count"} onValueChange={(v) => set({ measure: v })}>
              <SelectTrigger className="h-11 w-48 md:h-8" aria-label="Measure">
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
          </div>
        </>
      ) : null}
    </div>
  );
}
