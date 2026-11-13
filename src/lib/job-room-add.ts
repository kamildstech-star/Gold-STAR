/**
 * Adding a room to a job — the one path, wherever the room is added from.
 *
 * The Rooms tab was the only place a room could be made. Mark, 7 Oct 2026,
 * looking at the Inside card on the Drying log: "add a way to add a room from
 * here too." A technician standing in a room nobody recorded should not have
 * to leave the reading half typed, go to Rooms, and come back. But a room made
 * from the drying log has to be the same room the Rooms tab would have made —
 * same row, same photo folder, same refreshed lists — or the two places drift
 * and the folder quietly goes missing. So both call this.
 *
 * What a room add is, in order:
 *  1. The row (`createJobRoom`), with the unit dropped and said so when the
 *     column is not in this database yet. The id is minted here so the caller
 *     can select the new room without a read-back.
 *  2. Every list of the job's rooms is refreshed (`["job-rooms", jobId]` —
 *     the Rooms tab, the drying log and every other picker share that key).
 *  3. The room's photo folder, made in the job album (the album too, if the
 *     job has none). Never awaited by the add: the room is committed first and
 *     a folder problem costs a folder, not a room. The caller is told how it
 *     went and decides where to say so.
 *
 * Not offline-queued, because the Rooms tab's add never was: a room added with
 * no signal fails and says so, from either place. Measurements and layout
 * copies go through the room-capture queue; the add itself is a plain insert.
 *
 * Who may add one is the database's call (`job_rooms_insert`:
 * `can_manage_job`). The caller hides the control from anyone else, but a
 * refusal still comes back as the thrown error, for `toastDbError`.
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ensureJobAlbum } from "./job-photos";
import {
  createJobRoom,
  fetchJobRooms,
  syncRoomFolders,
  type JobRoom,
  type RoomFolderSyncResult,
} from "./job-rooms";
import type { JobForAlbum } from "./photo-projects";

/** Said once when a write had to go in without its unit, not once per field. */
export const UNIT_PENDING =
  "Unit numbers need a database migration that has not been applied yet — the room was saved without one.";

export type FolderOutcome =
  { ok: true; result: RoomFolderSyncResult } | { ok: false; message: string };

export type AlbumContext = {
  job: JobForAlbum;
  /** The job's album, when the page already knows it. Null makes one. */
  projectId: string | null | undefined;
  userId: string | null;
  /** The album was made here rather than by a photo — the page should refetch it. */
  onAlbumCreated?: () => void;
};

/**
 * Bring the album's folders up to date with the rooms. Folders live in the
 * album; without one there is nowhere to put them, so it is made —
 * idempotently, so a stale null finds the existing album.
 */
export async function followRoomFolders(ctx: AlbumContext): Promise<FolderOutcome> {
  try {
    let albumId = ctx.projectId ?? null;
    if (!albumId) {
      albumId = await ensureJobAlbum(ctx.job, ctx.userId);
      ctx.onAlbumCreated?.();
    }
    const fresh = await fetchJobRooms(ctx.job.id);
    const result = await syncRoomFolders(albumId, fresh.rooms, ctx.userId);
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Photo folders could not be updated.",
    };
  }
}

export type RoomFields = {
  unit: string | null;
  name: string;
  floor: string | null;
  lengthFt?: number | null;
  widthFt?: number | null;
  heightFt?: number | null;
};

/**
 * Add the room. Resolves once the row is saved and the room lists have been
 * refreshed; throws what the database said if it was refused. The folder pass
 * runs on after and reports through `onFolders`.
 *
 * Returns the room as saved, so a picker can choose it straight away — with
 * `unit: null` when the unit had to be dropped, because that is the room the
 * list will show.
 */
export async function addJobRoom(
  opts: AlbumContext & {
    queryClient: QueryClient;
    room: RoomFields;
    /** Where the room sits in the list: the tab's `rooms.length * 10`. */
    sortOrder: number;
    onFolders?: (outcome: FolderOutcome) => void;
  },
): Promise<JobRoom> {
  const jobId = opts.job.id;
  const name = opts.room.name.trim();
  if (!name) throw new Error("A room needs a name");
  const unit = opts.room.unit?.trim() || null;
  const floor = opts.room.floor?.trim() || null;
  const { id, unitDropped } = await createJobRoom({
    jobId,
    unit,
    name,
    floor,
    lengthFt: opts.room.lengthFt ?? null,
    widthFt: opts.room.widthFt ?? null,
    heightFt: opts.room.heightFt ?? null,
    createdBy: opts.userId,
    sortOrder: opts.sortOrder,
  });
  if (unitDropped) toast.warning(UNIT_PENDING);
  // Awaited so a picker that selects the new room finds it in the list it
  // draws from. A failed refetch does not throw; the room is saved either way.
  await opts.queryClient.invalidateQueries({ queryKey: ["job-rooms", jobId] });
  void followRoomFolders(opts).then((outcome) => opts.onFolders?.(outcome));
  return {
    id,
    job_id: jobId,
    unit: unitDropped ? null : unit,
    name,
    floor,
    length_ft: opts.room.lengthFt ?? null,
    width_ft: opts.room.widthFt ?? null,
    height_ft: opts.room.heightFt ?? null,
    affected_materials: [],
    notes: null,
    sort_order: opts.sortOrder,
    flooring: null,
    extra_sf: 0,
  };
}
