/**
 * Is the dehumidifier actually pulling water? The inlet / outlet pair and the
 * grain depression between them.
 *
 * Heshy Landau's checklist (1 Sep, via David) asks for the air going into each
 * running dehumidifier and the air coming out of it, temperature and RH both.
 * RH alone is useless here — a refrigerant dehumidifier heats the air it
 * exhausts, so outlet RH drops even when no water is being removed. What
 * matters is grains per pound: inlet GPP minus outlet GPP is the GRAIN
 * DEPRESSION, the water the machine took out of every pound of air that went
 * through it. That is the number a carrier's reviewer checks before paying a
 * week of dehumidifier rental.
 *
 * The verdict is deliberately blunt, because it is read with gloves on:
 *
 *   pulling      depression at or above PULLING_MIN_GRAINS
 *   ineffective  positive but below it — the unit is running and achieving
 *                little: the room is already near dry, the coil is iced, the
 *                filter is clogged, or the machine is the wrong size
 *   check        outlet is WETTER than inlet — physically not a working
 *                dehumidifier, so almost always the two readings were swapped
 *                or the unit is off; re-read before anyone relies on it
 *
 * The 10-grain line is the field rule of thumb restorers use, not a number
 * S500 prints; it is one constant so Heshy can move it.
 *
 * Pure. The GPP comes from src/lib/psychrometrics.ts — the same derivation the
 * rest of the log stores, so the depression shown on site and the one printed
 * in a report cannot disagree.
 */
import { derive, isUsableReading } from "@/lib/psychrometrics";

export const PULLING_MIN_GRAINS = 10;

export type DehuVerdict = "pulling" | "ineffective" | "check";

export type AirReading = { temperatureF: number | null; relativeHumidity: number | null };

export type DehuPerformance = {
  inletGpp: number;
  outletGpp: number;
  /** Inlet GPP minus outlet GPP, rounded to a tenth. */
  depression: number;
  verdict: DehuVerdict;
};

export function dehuVerdict(depression: number): DehuVerdict {
  if (depression < 0) return "check";
  return depression >= PULLING_MIN_GRAINS ? "pulling" : "ineffective";
}

/**
 * The pair, or null when either side is not a usable reading yet. Half a pair
 * has no verdict — an inlet reading on its own proves nothing about the
 * machine, and showing "ineffective" for a missing outlet would be a lie.
 */
export function dehuPerformance(inlet: AirReading, outlet: AirReading): DehuPerformance | null {
  if (!isUsableReading(inlet.temperatureF, inlet.relativeHumidity)) return null;
  if (!isUsableReading(outlet.temperatureF, outlet.relativeHumidity)) return null;
  const inletGpp = derive(inlet.temperatureF, inlet.relativeHumidity).gpp;
  const outletGpp = derive(outlet.temperatureF, outlet.relativeHumidity).gpp;
  if (inletGpp == null || outletGpp == null) return null;
  const depression = Math.round((inletGpp - outletGpp) * 10) / 10;
  return { inletGpp, outletGpp, depression, verdict: dehuVerdict(depression) };
}

/** The same verdict from stored rows, which carry their frozen GPP. */
export function dehuPerformanceFromGpp(
  inletGpp: number | null,
  outletGpp: number | null,
): DehuPerformance | null {
  if (inletGpp == null || outletGpp == null) return null;
  const depression = Math.round((inletGpp - outletGpp) * 10) / 10;
  return { inletGpp, outletGpp, depression, verdict: dehuVerdict(depression) };
}

export const DEHU_VERDICT_TEXT: Record<DehuVerdict, { en: string; es: string }> = {
  pulling: { en: "Pulling moisture", es: "Sacando humedad" },
  ineffective: { en: "Ineffective", es: "No está sacando humedad" },
  check: { en: "Check readings", es: "Revise las lecturas" },
};

/** Why, in one sentence, for the line under the verdict. */
export function describeDehuPerformance(p: DehuPerformance): string {
  if (p.verdict === "pulling") {
    return `Taking ${p.depression} gr/lb out of the air (${p.inletGpp} in → ${p.outletGpp} out).`;
  }
  if (p.verdict === "ineffective") {
    return `Only ${p.depression} gr/lb out (${p.inletGpp} in → ${p.outletGpp} out) — under ${PULLING_MIN_GRAINS}. Check the filter and coil, or whether the room is already near dry.`;
  }
  return `Outlet air is wetter than inlet (${p.inletGpp} in → ${p.outletGpp} out). The readings are probably swapped, or the unit is off — re-read it.`;
}

/** A stored drying row, as much of it as the pairing needs. */
export type DehuRow = {
  point: string;
  equipment_id: string | null;
  reading_date: string;
  captured_at: string;
  grains_per_pound: number | null;
  temperature_f: number;
  relative_humidity: number;
};

export type DehuDay = {
  equipmentId: string;
  inlet: DehuRow | null;
  outlet: DehuRow | null;
  performance: DehuPerformance | null;
};

/**
 * One entry per machine read on `date`: its latest inlet and latest outlet,
 * and the verdict on the pair. Rows with no machine are skipped — an outlet
 * reading that does not say which unit it came off cannot vouch for any unit.
 */
export function pairDehuReadings(rows: DehuRow[], date: string): DehuDay[] {
  const byUnit = new Map<string, { inlet: DehuRow | null; outlet: DehuRow | null }>();
  const newer = (a: DehuRow | null, b: DehuRow) => (!a || b.captured_at > a.captured_at ? b : a);
  for (const r of rows) {
    if (r.reading_date !== date || !r.equipment_id) continue;
    if (r.point !== "dehu_inlet" && r.point !== "dehu_outlet") continue;
    const cur = byUnit.get(r.equipment_id) ?? { inlet: null, outlet: null };
    if (r.point === "dehu_inlet") cur.inlet = newer(cur.inlet, r);
    else cur.outlet = newer(cur.outlet, r);
    byUnit.set(r.equipment_id, cur);
  }
  return [...byUnit.entries()].map(([equipmentId, { inlet, outlet }]) => ({
    equipmentId,
    inlet,
    outlet,
    performance: dehuPerformanceFromGpp(
      inlet?.grains_per_pound ?? null,
      outlet?.grains_per_pound ?? null,
    ),
  }));
}
