/**
 * The job's placements, as the drying log needs them: which dehumidifiers are
 * running (for the inlet / outlet drawer) and what their hour meters say (for
 * the drying summary's billing line).
 *
 * The panel stopped reading equipment_placements on 2026-09-07, when Mark had
 * the dehu outlet block taken off the form and its machine picker went with
 * it. It reads them again because the inlet / outlet pair is only evidence
 * when it names the machine it came off, and the machines on the job are the
 * placements.
 *
 * The hour-meter columns ship in 20260928160000. The read falls back to the
 * columns that certainly exist, so a pending migration costs the hours line
 * and nothing else.
 */
import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export type DryingPlacement = {
  id: string;
  equipment_id: string;
  room_id: string | null;
  placed_at: string;
  retrieved_at: string | null;
  hour_meter_start: number | null;
  hour_meter_end: number | null;
  asset_tag: string | null;
  equipment_type: string | null;
};

const BASE = "id, equipment_id, room_id, placed_at, retrieved_at";
const EQUIPMENT = "equipment:equipment_id(asset_tag, equipment_type)";

type Raw = {
  id: string;
  equipment_id: string;
  room_id: string | null;
  placed_at: string;
  retrieved_at: string | null;
  hour_meter_start?: number | string | null;
  hour_meter_end?: number | string | null;
  equipment: { asset_tag: string | null; equipment_type: string | null } | null;
};

const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

export async function listDryingPlacements(
  jobId: string,
): Promise<{ rows: DryingPlacement[]; hoursAvailable: boolean }> {
  const read = (cols: string) =>
    supabase
      .from("equipment_placements")
      .select(cols as never)
      .eq("job_id", jobId)
      .order("placed_at", { ascending: true });

  let hoursAvailable = true;
  let res = await read(`${BASE}, hour_meter_start, hour_meter_end, ${EQUIPMENT}`);
  if (res.error && isMissingSchema(res.error)) {
    hoursAvailable = false;
    res = await read(`${BASE}, ${EQUIPMENT}`);
  }
  if (res.error) throw res.error;
  const rows = ((res.data ?? []) as unknown as Raw[]).map((r) => ({
    id: r.id,
    equipment_id: r.equipment_id,
    room_id: r.room_id,
    placed_at: r.placed_at,
    retrieved_at: r.retrieved_at,
    hour_meter_start: num(r.hour_meter_start),
    hour_meter_end: num(r.hour_meter_end),
    asset_tag: r.equipment?.asset_tag ?? null,
    equipment_type: r.equipment?.equipment_type ?? null,
  }));
  return { rows, hoursAvailable };
}

/**
 * Dehumidifiers on site on `date`: placed on or before it and not retrieved
 * before it. A machine picked up this afternoon was still running this
 * morning, and its last inlet / outlet pair belongs to today.
 */
export function dehusOnSite(rows: DryingPlacement[], date: string): DryingPlacement[] {
  const local = (ts: string) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  return rows.filter(
    (r) =>
      r.equipment_type === "dehumidifier" &&
      local(r.placed_at) <= date &&
      (!r.retrieved_at || local(r.retrieved_at) >= date),
  );
}
