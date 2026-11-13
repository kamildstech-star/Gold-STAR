/**
 * Drying progress, cut down to what a loss report says about it.
 *
 * The drying report and the adjuster workbook carry every reading; a loss
 * report needs the trend: each material point's first and latest reading
 * against its dry goal, and the day the goal was met. Everything here is a
 * CREW measurement. Automatic outside figures (Open-Meteo's model, or a
 * National Weather Service station miles away) are left out entirely, so the
 * narrative cannot describe one as a reading somebody took at the property;
 * those figures live in the drying report, labelled with their source.
 *
 * Pure: rows in, plain data out. job-reports.server.ts reads the rows.
 */
import { MOISTURE_MATERIAL_LABEL, dryGoal, summarizePoint } from "@/lib/drying-materials";
import type { MoisturePoint, MoistureReading } from "@/lib/drying-materials";

export type CrewAirReading = {
  point: string;
  reading_date: string;
  grains_per_pound: number | null;
  source: string;
  room_id?: string | null;
};

export type DryingPointFact = {
  room: string | null;
  material: string;
  location: string | null;
  dry_goal_pct: number | null;
  first_reading: { date: string; moisture_pct: number } | null;
  latest_reading: { date: string; moisture_pct: number } | null;
  goal_met_on: string | null;
  at_goal_now: boolean | null;
  material_removed: boolean;
};

export type DryingSummary = {
  /** False when the moisture tables are not in this database yet. */
  moisture_tables_available: boolean;
  moisture_points: DryingPointFact[];
  points_total: number;
  points_at_goal: number;
  crew_reading_days: number;
  first_crew_reading: string | null;
  last_crew_reading: string | null;
  /** Grains per pound in the affected area, first and latest crew reading. */
  affected_air: {
    first: { date: string; grains_per_pound: number };
    latest: { date: string; grains_per_pound: number };
  } | null;
  /** Rooms the crew marked as affected, with the materials named: "Kitchen (Drywall, Baseboard)". */
  affected_rooms: string[];
};

/** "Unit 4B · Kitchen", or "Kitchen" on a house — the label the rest of the app prints. */
export function dryingRoomLabel(r: { unit?: string | null; name?: string | null }): string {
  const name = (r.name ?? "").trim() || "Unnamed room";
  const unit = (r.unit ?? "").trim();
  if (!unit) return name;
  const designated =
    unit.startsWith("#") ||
    /^(unit|apt|apartment|suite|ste|rm|room|bldg|building|lot|space)\b/i.test(unit);
  return `${designated ? unit : `Unit ${unit}`} · ${name}`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function summarizeDrying(input: {
  moisture: { points: MoisturePoint[]; readings: MoistureReading[] } | null;
  airReadings: readonly CrewAirReading[];
  roomNames: ReadonlyMap<string, string>;
  rooms?: readonly { label: string; affected_materials?: string[] | null }[];
}): DryingSummary {
  const points = (input.moisture?.points ?? []).map((p) => {
    const s = summarizePoint(p, input.moisture!.readings);
    const goal = dryGoal(p.dry_standard);
    const fact: DryingPointFact = {
      room: p.room_id ? (input.roomNames.get(p.room_id) ?? null) : null,
      material: MOISTURE_MATERIAL_LABEL[p.material] ?? p.material,
      location: p.location,
      dry_goal_pct: goal == null ? null : round1(goal),
      first_reading: s.first
        ? { date: s.first.reading_date, moisture_pct: round1(s.first.moisture_pct) }
        : null,
      latest_reading: s.latest
        ? { date: s.latest.reading_date, moisture_pct: round1(s.latest.moisture_pct) }
        : null,
      goal_met_on: s.metOn,
      at_goal_now: goal == null || !s.latest ? null : s.latest.moisture_pct <= goal,
      material_removed: s.removed,
    };
    return fact;
  });

  // Crew rows only: an automatic outside figure is never evidence of a visit.
  const crew = input.airReadings.filter((r) => r.source !== "weather");
  const days = [...new Set(crew.map((r) => r.reading_date))].sort();
  const affected = crew
    .filter((r) => r.point === "affected" && r.grains_per_pound != null)
    .sort((a, b) => a.reading_date.localeCompare(b.reading_date));
  const firstAir = affected[0];
  const lastAir = affected[affected.length - 1];

  return {
    moisture_tables_available: input.moisture != null,
    moisture_points: points,
    points_total: points.filter((p) => !p.material_removed).length,
    points_at_goal: points.filter((p) => !p.material_removed && p.at_goal_now === true).length,
    crew_reading_days: days.length,
    first_crew_reading: days[0] ?? null,
    last_crew_reading: days[days.length - 1] ?? null,
    affected_air:
      firstAir && lastAir
        ? {
            first: {
              date: firstAir.reading_date,
              grains_per_pound: round1(Number(firstAir.grains_per_pound)),
            },
            latest: {
              date: lastAir.reading_date,
              grains_per_pound: round1(Number(lastAir.grains_per_pound)),
            },
          }
        : null,
    affected_rooms: (input.rooms ?? [])
      .filter((r) => (r.affected_materials ?? []).length > 0)
      .map((r) => `${r.label} (${(r.affected_materials ?? []).join(", ")})`),
  };
}
