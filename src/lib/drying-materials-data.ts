/**
 * Reading and writing the fixed material test points. The verdicts are in
 * drying-materials.ts; this is the database side.
 *
 * Tables: `job_moisture_points`, `job_moisture_readings` (migration
 * 20260928161000). They postdate the generated Supabase types and may not be
 * applied yet, so they are reached through an untyped client and a missing
 * table is "not set up yet" — the same pattern as `drying-reset.ts`.
 *
 * Every write here is a raw write, shared by the immediate attempt and the
 * offline queue draining hours later. The queue imports this file, so nothing
 * here may import the queue back; the drawer wraps these in `writeOrQueue`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { MoisturePoint, MoistureReading } from "@/lib/drying-materials";

export type MoisturePointRow = MoisturePoint & { created_by: string | null };

export type MoistureReadingRow = MoistureReading & {
  notes: string | null;
  created_by: string | null;
};

/**
 * A change to a point that already exists: its dry standard, or that its
 * material came out. An UPDATE, never an upsert — an upsert checks the insert
 * policy too, which pins `created_by` to the caller, so a manager correcting a
 * tech's dry standard would be refused.
 */
export type MoisturePointPatch = {
  id: string;
  patch: Partial<Pick<MoisturePoint, "dry_standard" | "removed_at" | "location">>;
};

const db = (client: typeof supabase) => client as unknown as SupabaseClient;

/**
 * Null when the tables are not there yet, so the drawer can say "pending
 * migration" rather than showing an empty list that looks like no points.
 */
export async function listMoisture(
  jobId: string,
): Promise<{ points: MoisturePoint[]; readings: MoistureReading[] } | null> {
  const [p, r] = await Promise.all([
    db(supabase)
      .from("job_moisture_points")
      .select("id, job_id, room_id, material, location, dry_standard, removed_at, created_at")
      .eq("job_id", jobId)
      .order("created_at", { ascending: true }),
    db(supabase)
      .from("job_moisture_readings")
      .select("id, point_id, job_id, reading_date, moisture_pct, captured_at")
      .eq("job_id", jobId)
      .order("reading_date", { ascending: true }),
  ]);
  const error = p.error ?? r.error;
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  // numeric comes back from PostgREST as a string on some drivers; the
  // verdicts compare numbers.
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    points: (p.data ?? []).map((x) => ({
      ...x,
      dry_standard: num(x.dry_standard),
    })) as MoisturePoint[],
    readings: (r.data ?? []).map((x) => ({
      ...x,
      moisture_pct: Number(x.moisture_pct),
    })) as MoistureReading[],
  };
}

/** Upsert on the client id, so a replay lands on the point it already made. */
export async function writeMoisturePoint(
  row: MoisturePointRow,
  client: typeof supabase = supabase,
): Promise<void> {
  const { error } = await db(client).from("job_moisture_points").upsert(row, { onConflict: "id" });
  if (error) throw error;
}

export async function patchMoisturePoint(
  input: MoisturePointPatch,
  client: typeof supabase = supabase,
): Promise<void> {
  const { error } = await db(client)
    .from("job_moisture_points")
    .update(input.patch)
    .eq("id", input.id);
  if (error) throw error;
}

/**
 * Upsert on the client id. A reading queued behind the point it belongs to
 * fails the foreign key until that point lands; the queue treats 23503 as
 * "try again next pass", which is exactly right here.
 */
export async function writeMoistureReading(
  row: MoistureReadingRow,
  client: typeof supabase = supabase,
): Promise<void> {
  const { error } = await db(client)
    .from("job_moisture_readings")
    .upsert(row, { onConflict: "id" });
  if (error) throw error;
}
