import { useMemo, useState, type FocusEvent } from "react";
import { AlertTriangle, CheckCircle2, Fan } from "lucide-react";

import { useLabelLanguage } from "@/components/bilingual";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEHU_VERDICT_TEXT,
  dehuPerformance,
  describeDehuPerformance,
  pairDehuReadings,
  type DehuPerformance,
} from "@/lib/dehu-performance";
import type { DryingPlacement } from "@/lib/drying-equipment";
import type { DryingReading } from "@/lib/drying-log";
import { derive } from "@/lib/psychrometrics";
import { cn } from "@/lib/utils";

/**
 * Dehumidifier INLET and OUTLET, per machine — the drawer under the day's
 * readings.
 *
 * Heshy Landau's checklist (1 Sep, via David) asks for both sides of every
 * running dehumidifier: the air it takes in and the air it exhausts, and the
 * grain depression between them, which is the one number that proves a
 * machine billed for the week actually pulled water. See
 * src/lib/dehu-performance.ts for the verdict.
 *
 * Collapsed, and off the daily cards, on purpose. Mark took the outlet block
 * off the form on 2026-09-07 ("remove this as well") and the Inside and
 * Affected cards a tech fills every day stay exactly as he left them. This is
 * the advanced reading, opened by whoever is doing the audit-grade walk.
 *
 * One row per dehumidifier on site that day, straight from the placement log —
 * never a free "Dehu #3" label, because an outlet reading that does not name
 * its machine vouches for none of them.
 */

/** One machine's four boxes. Numbers stay text until saved, like the rest of the form. */
type PairDraft = { inT: string; inRH: string; outT: string; outRH: string };

const EMPTY: PairDraft = { inT: "", inRH: "", outT: "", outRH: "" };

export type DehuPairEntry = {
  placement: DryingPlacement;
  inlet: { temperatureF: number; relativeHumidity: number };
  outlet: { temperatureF: number; relativeHumidity: number };
};

function numOrNull(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function keepVisible(e: FocusEvent<HTMLInputElement>) {
  const el = e.currentTarget;
  window.setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
}

export function VerdictBadge({ p }: { p: DehuPerformance }) {
  const { bi } = useLabelLanguage();
  const t = DEHU_VERDICT_TEXT[p.verdict];
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0",
        p.verdict === "pulling" && "border-success/60 text-success",
        p.verdict === "ineffective" && "border-warning/60 text-warning",
        p.verdict === "check" && "border-destructive/60 text-destructive",
      )}
    >
      {bi(t.en, t.es)} · {p.depression} gr
    </Badge>
  );
}

export function DehuReadingsDrawer({
  dayWord,
  date,
  dehus,
  readings,
  roomNames,
  available,
  disabled,
  onSave,
}: {
  dayWord: string;
  date: string;
  /** Dehumidifiers on site that day. */
  dehus: DryingPlacement[];
  readings: DryingReading[];
  roomNames: Map<string, string>;
  /** False until 20260928160000 admits the inlet point. */
  available: boolean;
  disabled: boolean;
  onSave: (pairs: DehuPairEntry[]) => Promise<void>;
}) {
  const { bi } = useLabelLanguage();
  const [drafts, setDrafts] = useState<Record<string, PairDraft>>({});
  const [busy, setBusy] = useState(false);

  const onFile = useMemo(
    () => new Map(pairDehuReadings(readings, date).map((d) => [d.equipmentId, d])),
    [readings, date],
  );

  const draftOf = (id: string) => drafts[id] ?? EMPTY;
  const patch = (id: string, change: Partial<PairDraft>) =>
    setDrafts((cur) => ({ ...cur, [id]: { ...draftOf(id), ...change } }));

  /** A pair is saveable only whole: half a pair has no verdict. */
  const complete = dehus
    .map((placement) => {
      const d = draftOf(placement.equipment_id);
      const inlet = { temperatureF: numOrNull(d.inT), relativeHumidity: numOrNull(d.inRH) };
      const outlet = { temperatureF: numOrNull(d.outT), relativeHumidity: numOrNull(d.outRH) };
      const perf = dehuPerformance(inlet, outlet);
      return perf ? { placement, inlet, outlet } : null;
    })
    .filter(Boolean) as DehuPairEntry[];
  const started = dehus.filter((p) => Object.values(draftOf(p.equipment_id)).some((v) => v.trim()));
  const halfDone = started.length - complete.length;

  const passing = [...onFile.values()].filter((d) => d.performance?.verdict === "pulling").length;
  const judged = [...onFile.values()].filter((d) => d.performance).length;

  const save = async () => {
    setBusy(true);
    try {
      await onSave(complete);
      setDrafts({});
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="group rounded-md border">
      <summary className="flex min-h-11 cursor-pointer select-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm font-medium">
        <Fan className="size-4 shrink-0 text-muted-foreground" />
        {bi("Dehumidifiers — inlet / outlet", "Deshumidificadores — entrada / salida")}
        <span className="text-[11px] font-normal text-muted-foreground">
          {dehus.length === 0
            ? "none on site"
            : judged > 0
              ? `${passing} of ${dehus.length} pulling moisture ${dayWord}`
              : `${dehus.length} on site · not read ${dayWord}`}
        </span>
      </summary>

      <div className="space-y-3 border-t p-3">
        <p className="text-[11px] text-muted-foreground">
          Read the air going in and the air coming out of each machine. Grains per pound are
          calculated; the difference is the grain depression — what the machine is taking out.
        </p>

        {!available ? (
          <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px]">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
            <span>
              Inlet readings arrive with 20260928160000_drying_class_dehu_inlet_hour_meters — the
              database would refuse one today, so this is held back. If it has just been applied,
              reload.
            </span>
          </p>
        ) : dehus.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            No dehumidifier is logged on this job for {dayWord}. Place one from Equipment above
            (Set up → scan) and it appears here.
          </p>
        ) : (
          <>
            <ul className="space-y-3">
              {dehus.map((placement) => {
                const id = placement.equipment_id;
                const d = draftOf(id);
                const filed = onFile.get(id);
                const live = dehuPerformance(
                  { temperatureF: numOrNull(d.inT), relativeHumidity: numOrNull(d.inRH) },
                  { temperatureF: numOrNull(d.outT), relativeHumidity: numOrNull(d.outRH) },
                );
                const inGpp = derive(numOrNull(d.inT), numOrNull(d.inRH)).gpp;
                const outGpp = derive(numOrNull(d.outT), numOrNull(d.outRH)).gpp;
                const room = placement.room_id ? roomNames.get(placement.room_id) : null;
                return (
                  <li key={placement.id} className="space-y-2 rounded-md border bg-background p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 text-sm">
                        <span className="font-mono text-xs font-semibold">
                          {placement.asset_tag ?? "(no tag)"}
                        </span>
                        {room && (
                          <span className="ml-1.5 text-xs text-muted-foreground">{room}</span>
                        )}
                      </span>
                      {filed?.performance && <VerdictBadge p={filed.performance} />}
                    </div>
                    {filed?.performance && (
                      <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
                        <CheckCircle2 className="mt-0.5 size-3 shrink-0" />
                        <span>
                          On file {dayWord}: {describeDehuPerformance(filed.performance)}
                        </span>
                      </p>
                    )}

                    {/* Inlet then outlet, each a temp/RH pair — the order the
                        probe is moved in: front of the machine, then the
                        exhaust. */}
                    <div className="grid gap-2 sm:grid-cols-2">
                      <fieldset className="space-y-1">
                        <legend className="text-[11px] font-medium text-muted-foreground">
                          {bi("Inlet (air in)", "Entrada (aire que entra)")}
                        </legend>
                        <div className="grid grid-cols-2 gap-2">
                          <Input
                            className="h-11 text-base"
                            inputMode="decimal"
                            aria-label={`Inlet temperature °F, ${placement.asset_tag}`}
                            placeholder="Temp °F"
                            value={d.inT}
                            onFocus={keepVisible}
                            onChange={(e) => patch(id, { inT: e.target.value })}
                          />
                          <Input
                            className="h-11 text-base"
                            inputMode="decimal"
                            aria-label={`Inlet relative humidity %, ${placement.asset_tag}`}
                            placeholder="RH %"
                            value={d.inRH}
                            onFocus={keepVisible}
                            onChange={(e) => patch(id, { inRH: e.target.value })}
                          />
                        </div>
                        <p className="text-[11px] tabular-nums text-muted-foreground">
                          {inGpp == null ? "— gr/lb" : `${inGpp} gr/lb`}
                        </p>
                      </fieldset>
                      <fieldset className="space-y-1">
                        <legend className="text-[11px] font-medium text-muted-foreground">
                          {bi("Outlet (exhaust)", "Salida (aire que sale)")}
                        </legend>
                        <div className="grid grid-cols-2 gap-2">
                          <Input
                            className="h-11 text-base"
                            inputMode="decimal"
                            aria-label={`Outlet temperature °F, ${placement.asset_tag}`}
                            placeholder="Temp °F"
                            value={d.outT}
                            onFocus={keepVisible}
                            onChange={(e) => patch(id, { outT: e.target.value })}
                          />
                          <Input
                            className="h-11 text-base"
                            inputMode="decimal"
                            aria-label={`Outlet relative humidity %, ${placement.asset_tag}`}
                            placeholder="RH %"
                            value={d.outRH}
                            onFocus={keepVisible}
                            onChange={(e) => patch(id, { outRH: e.target.value })}
                          />
                        </div>
                        <p className="text-[11px] tabular-nums text-muted-foreground">
                          {outGpp == null ? "— gr/lb" : `${outGpp} gr/lb`}
                        </p>
                      </fieldset>
                    </div>

                    {/* The verdict live, so a swapped probe is caught while
                        the tech is still standing at the machine. */}
                    {live && (
                      <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                        <VerdictBadge p={live} />
                        <span className="min-w-0 text-muted-foreground">
                          {describeDehuPerformance(live)}
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {halfDone > 0 && (
              <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
                <span>
                  {halfDone} machine{halfDone === 1 ? " has" : "s have"} only part of a pair — all
                  four numbers are needed, or nothing is saved for it.
                </span>
              </p>
            )}

            <Button
              type="button"
              className="h-12 w-full"
              disabled={busy || disabled || complete.length === 0}
              onClick={() => void save()}
            >
              {complete.length === 0
                ? bi(`Log dehumidifier readings for ${dayWord}`, "Guardar lecturas")
                : bi(
                    `Log ${complete.length} dehumidifier${complete.length === 1 ? "" : "s"} for ${dayWord}`,
                    "Guardar lecturas",
                  )}
            </Button>
          </>
        )}
      </div>
    </details>
  );
}
