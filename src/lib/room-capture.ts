/**
 * Field capture's database side: reading a job's doors, windows and cabinet
 * runs, and the raw writes behind every capture op.
 *
 * Tables: `job_room_openings`, `job_room_cabinets`, and the `flooring` /
 * `extra_sf` columns on `job_rooms` (migration 20261006140000). Written by
 * hand and applied by hand, so a missing table is "not set up yet" — the
 * Rooms tab hides the sections and says so — never an error on the tab.
 *
 * Every write here is a raw write, shared by the immediate attempt and by the
 * offline queue draining hours later. The queue imports this file, so nothing
 * here may import the queue back; the Rooms tab wraps these in `writeOrQueue`.
 */
import { supabase } from "@/integrations/supabase/client";
import { PermanentWriteError } from "@/lib/offline-writes";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { CabinetKind, OpeningKind, RoomCabinet, RoomOpening } from "@/lib/room-takeoff";
import type { RoomCaptureOp } from "@/lib/room-capture-ops";

type Client = typeof supabase;

export type RoomCaptureRows = { openings: RoomOpening[]; cabinets: RoomCabinet[] };

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Null when the tables are not in this database yet, so the tab can say
 * "waiting on a migration" rather than showing a room with no doors that
 * looks measured.
 */
export async function fetchRoomCapture(jobId: string): Promise<RoomCaptureRows | null> {
  const [o, c] = await Promise.all([
    supabase
      .from("job_room_openings")
      .select("id, job_id, room_id, kind, width_in, height_in, qty")
      .eq("job_id", jobId)
      .order("created_at"),
    supabase
      .from("job_room_cabinets")
      .select("id, job_id, room_id, kind, length_ft")
      .eq("job_id", jobId)
      .order("created_at"),
  ]);
  const error = o.error ?? c.error;
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return {
    openings: (o.data ?? []).map((r) => ({
      ...r,
      kind: r.kind as OpeningKind,
      width_in: num(r.width_in),
      height_in: num(r.height_in),
      qty: num(r.qty) ?? 1,
    })),
    cabinets: (c.data ?? []).map((r) => ({
      ...r,
      kind: r.kind as CabinetKind,
      length_ft: num(r.length_ft),
    })),
  };
}

/**
 * An UPDATE that RLS refuses does not error — it matches no rows. Without the
 * read-back, a crew member who may see a job but not manage it would be told
 * their measurements were saved, and the queue would drop them as sent. The
 * select policy (can_view_job) is wider than the update one (can_manage_job),
 * so anyone who could make the change can read the row back.
 */
async function updateOne(
  client: Client,
  table: "job_rooms" | "job_room_openings" | "job_room_cabinets",
  id: string,
  patch: Record<string, unknown>,
  refused: string,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const { data, error } = await client
    .from(table)
    .update(patch as never)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new PermanentWriteError(refused);
}

const REFUSED_ROOM =
  "This room could not be changed — it was removed, or you can see this job but not edit its rooms.";
const REFUSED_PART =
  "This could not be changed — it was removed, or you can see this job but not edit its rooms.";

/**
 * Replays one capture op. Adds are upserts on the client id, so the
 * immediate attempt and a later drain land one row; patches are updates (an
 * upsert would also check the insert policy); deletes are idempotent. A
 * child queued behind a room that has not landed yet fails the foreign key,
 * which the queue retries on the next pass rather than rejecting.
 */
export async function applyRoomCaptureOp(op: RoomCaptureOp, client: Client = supabase) {
  switch (op.op) {
    case "measure":
      await updateOne(client, "job_rooms", op.roomId, op.patch, REFUSED_ROOM);
      return;
    case "opening_add": {
      const { error } = await client.from("job_room_openings").upsert(op.row, { onConflict: "id" });
      if (error) throw error;
      return;
    }
    case "opening_patch":
      await updateOne(client, "job_room_openings", op.id, op.patch, REFUSED_PART);
      return;
    case "opening_delete": {
      const { error } = await client.from("job_room_openings").delete().eq("id", op.id);
      if (error) throw error;
      return;
    }
    case "cabinet_add": {
      const { error } = await client.from("job_room_cabinets").upsert(op.row, { onConflict: "id" });
      if (error) throw error;
      return;
    }
    case "cabinet_patch":
      await updateOne(client, "job_room_cabinets", op.id, op.patch, REFUSED_PART);
      return;
    case "cabinet_delete": {
      const { error } = await client.from("job_room_cabinets").delete().eq("id", op.id);
      if (error) throw error;
      return;
    }
    case "copy_layout": {
      // Rooms first, then what hangs off them. Insert-if-absent on the ids
      // the plan chose: a replay after a lost response — or after the doors
      // failed and the rooms did not — lands nothing twice, and never
      // overwrites a room someone has measured since.
      const once = { onConflict: "id", ignoreDuplicates: true } as const;
      if (op.rooms.length) {
        const { error } = await client.from("job_rooms").upsert(op.rooms, once);
        if (error) throw error;
      }
      if (op.openings.length) {
        const { error } = await client.from("job_room_openings").upsert(op.openings, once);
        if (error) throw error;
      }
      if (op.cabinets.length) {
        const { error } = await client.from("job_room_cabinets").upsert(op.cabinets, once);
        if (error) throw error;
      }
      return;
    }
  }
}
