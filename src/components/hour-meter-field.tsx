import { Gauge } from "lucide-react";

import { useLabelLanguage } from "@/components/bilingual";
import { Input } from "@/components/ui/input";

/**
 * The hour-meter box on a scanned machine — one component for set-up and
 * pickup, on the Equipment tab and the work ticket, so the dial is asked for
 * the same way everywhere a unit goes in or comes out.
 *
 * Heshy Landau's checklist (1 Sep, via David): the reading at placement and
 * again at pickup, end minus start being the operating hours a carrier is
 * billed for. See src/lib/equipment-hours.ts. Optional by design — a meter
 * nobody can read must never stop a unit being placed or retrieved.
 */
export function HourMeterField({
  value,
  onChange,
  assetTag,
  phase,
  hint,
  warning,
}: {
  value: string;
  onChange: (next: string) => void;
  assetTag: string;
  phase: "start" | "end";
  /** e.g. "1204 h at placement", shown under the box at pickup. */
  hint?: string | null;
  warning?: string | null;
}) {
  const { bi } = useLabelLanguage();
  return (
    <div className="mt-1.5 space-y-1">
      {/* Stacked below sm. Beside its label inside the scanner's unit row,
          next to the remove button, the box was left about 80px — narrower
          than its own placeholder. */}
      <label className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Gauge className="size-4 shrink-0" aria-hidden />
          {bi("Hour meter", "Horómetro")}
        </span>
        <Input
          className="h-11 w-full min-w-0 text-base sm:h-8 sm:flex-1 sm:text-[13px]"
          inputMode="decimal"
          aria-label={`Hour meter ${phase === "start" ? "at set-up" : "at pickup"}, ${assetTag}`}
          placeholder={
            phase === "start" ? "Reading at set-up (optional)" : "Reading at pickup (optional)"
          }
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {warning && <p className="text-[11px] text-destructive">{warning}</p>}
    </div>
  );
}
