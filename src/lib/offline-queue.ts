// Offline capture queue for everything that isn't a photo: notes, voice
// memos, task completions and call outcomes. Reps work in basements, stairwells
// and vehicles with no bars — work captured there has to hold locally and go
// up when service returns, and the rep has to be able to see that it did.
//
// Photos have their own queue (photos.ts) because they need variant encoding
// and signed uploads. This queue is the small-payload sibling and uses the
// same IndexedDB store.

import { get as idbGet, set as idbSet, del as idbDel, entries as idbEntries } from "idb-keyval";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { describeDbError, errText } from "@/lib/db-errors";
import { writeFieldWorkTicket, type FieldWorkTicketInsert } from "./field-work-ticket";
import {
  writeDryingReading,
  type DryingReadingInsert,
  type DryingReadingBlobs,
} from "./drying-log";
import {
  writeHourMeters,
  writePlacement,
  writeRetrieval,
  type HourMeterInput,
  type PlacementRowInput,
} from "./equipment-scan";
import {
  patchMoisturePoint,
  writeMoisturePoint,
  writeMoistureReading,
  type MoisturePointPatch,
  type MoisturePointRow,
  type MoistureReadingRow,
} from "./drying-materials-data";
import { writeDryingReset, type DryingResetInsert } from "./drying-reset";
import { scheduleAutomaticTaskSync } from "./automatic-job-tasks";
import {
  writeTradeshowLead,
  type TradeshowLeadPayload,
  type TradeshowLeadBlobs,
} from "./tradeshow-lead-writes";
import { applyTodoOp, type TodoOp } from "./todo-writes";
import { applyRoomCaptureOp } from "./room-capture";
import { writeTmForm, type TmFormWrite } from "./tm-forms";
import type { RoomCaptureOp } from "./room-capture-ops";

const PREFIX = "sync-queue:";

export type QueuedKind =
  | "note"
  | "voice_memo"
  | "task_complete"
  | "call_outcome"
  | "touchpoint"
  | "exposure"
  | "outcome"
  | "decline"
  | "arrival"
  | "incident_note"
  | "field_work_ticket"
  | "equipment_place"
  | "equipment_retrieve"
  | "equipment_hours"
  | "clock_in"
  | "clock_out"
  | "job_note"
  | "job_field"
  | "photo_caption"
  | "photo_tags"
  | "equipment_note"
  | "drying_reading"
  | "drying_reset"
  | "moisture_point"
  | "moisture_reading"
  | "tradeshow_lead"
  | "room_capture"
  | "tm_field_form"
  | "todo";

export type QueuedItem = {
  id: string;
  /** Missing on legacy records: preserved in place, never shown or replayed. */
  ownerId?: string;
  kind: QueuedKind;
  /** Payload shape depends on kind; see flush() below. */
  payload: Record<string, unknown>;
  blob?: Blob;
  blobMime?: string;
  /**
   * A capture that carries more than one file — a trade show lead is a photo
   * and a voice note. Keyed by role; the kind's writer knows the keys.
   */
  blobs?: Record<string, { blob: Blob; mime: string }>;
  createdAt: number;
  attempts: number;
  status: "queued" | "sending" | "error" | "rejected";
  /** When this attempt started, so an abandoned one can be told from a live one. */
  sendingSince?: number;
  lastError?: string;
  label: string;
};

/** How long a "sending" item is left alone before another pass reclaims it. */
const SENDING_STALE_MS = 2 * 60_000;

export const KIND_LABEL: Record<QueuedKind, string> = {
  note: "Note",
  voice_memo: "Voice memo",
  task_complete: "Task completion",
  call_outcome: "Call outcome",
  touchpoint: "Touch point",
  exposure: "Exposure lead",
  outcome: "Lead outcome",
  decline: "Decline",
  arrival: "Arrival",
  incident_note: "Lead note",
  field_work_ticket: "Field work ticket",
  equipment_place: "Equipment placed",
  equipment_retrieve: "Equipment retrieved",
  equipment_hours: "Hour meter",
  clock_in: "Clock in",
  clock_out: "Clock out",
  job_note: "Job note",
  job_field: "Job update",
  photo_caption: "Photo description",
  photo_tags: "Photo tags",
  equipment_note: "Equipment note",
  drying_reading: "Drying reading",
  drying_reset: "3-day drying reset",
  moisture_point: "Moisture test point",
  moisture_reading: "Material moisture reading",
  tradeshow_lead: "Trade show lead",
  todo: "To-do",
  room_capture: "Room measurement",
  tm_field_form: "T&M daily sheet",
};

/**
 * The label to show for a queued item. A kind added without a KIND_LABEL entry
 * used to render as a blank line in the pending list — an item the user can
 * see the count of but not name. Falling back to the raw kind keeps it at
 * worst ugly rather than invisible.
 */
export function kindLabel(kind: QueuedKind | string): string {
  return KIND_LABEL[kind as QueuedKind] ?? String(kind).replace(/_/g, " ");
}

/**
 * Postgres codes for a refusal the payload itself causes: no policy allows the
 * write, a check constraint rejects the values, a required column is absent,
 * or the text will not parse as the column's type. Sending it again produces
 * the same answer.
 *
 * Deliberately absent: 23503 (foreign key — the parent row may be sitting
 * further up this same queue and will exist by the next pass) and 23505
 * (duplicate key — usually a replay of a write that in fact succeeded).
 */
const PERMANENT_CODES = new Set(["42501", "23514", "23502", "22P02", "22007", "22003"]);

/**
 * A rejection the server will never accept on retry — the incident was
 * released, claimed by someone else, the lead is already dead, or no policy
 * lets this user write the row at all. These stay in the list with the reason
 * rather than being retried forever or dropped.
 *
 * Three tests, cheapest and most certain first. The typed flag is what new
 * writes should throw: matching on error text meant a genuinely permanent
 * failure whose wording missed the phrase list retried forever, and a transient
 * one whose wording hit it was marked rejected and effectively lost. The
 * string list survives for callers that still throw plain messages.
 */
export function isPermanent(err: unknown): boolean {
  if ((err as { permanent?: boolean } | null)?.permanent === true) return true;
  const code = String((err as { code?: string } | null)?.code ?? "");
  if (code && PERMANENT_CODES.has(code)) return true;
  return isPermanentMessage(errText(err));
}

function isPermanentMessage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not claimed") ||
    m.includes("no longer") ||
    m.includes("released") ||
    /*
     * "already claimed", not bare "already". Postgres says "duplicate key
     * value ... already exists" when a retry lands a write that in fact
     * succeeded the first time - calling that permanent strands a note the
     * user did save, marked rejected.
     */
    m.includes("already claimed") ||
    m.includes("already taken") ||
    m.includes("already closed") ||
    m.includes("not yours") ||
    m.includes("permission") ||
    m.includes("violates row-level security") ||
    m.includes("unknown offline operation")
  );
}

export function newId() {
  return (
    globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

// Local attribution uses the persisted session so capture still works offline.
// Server authorization remains mandatory; this is not a replacement for RLS.
export type QueueScope = { ownerId: string; token: string; revision: number };
let authRevision = 0;
let watchingAuth = false;
export async function queueScope(): Promise<QueueScope | null> {
  if (!watchingAuth) {
    watchingAuth = true;
    supabase.auth.onAuthStateChange(() => {
      authRevision += 1;
      queueMicrotask(notify);
    });
  }
  const revision = authRevision;
  const { data, error } = await supabase.auth.getSession();
  if (revision !== authRevision) return null;
  const session = data.session;
  if (error || !session?.user.id || session.user.is_anonymous || !session.access_token) return null;
  return { ownerId: session.user.id, token: session.access_token, revision };
}
export async function assertQueueScope(scope: QueueScope): Promise<void> {
  const current = await queueScope();
  if (
    !current ||
    current.ownerId !== scope.ownerId ||
    current.token !== scope.token ||
    current.revision !== scope.revision ||
    authRevision !== scope.revision
  )
    throw new Error("Account changed; unsent work remains on this device.");
}
export async function requireQueueScope(): Promise<QueueScope> {
  const scope = await queueScope();
  if (!scope) throw new Error("Sign in before saving offline work.");
  return scope;
}
/** Every request uses the captured bearer, never the singleton's later session. */
export function queueClient(scope: QueueScope) {
  return createClient<Database>(
    import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL!,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      accessToken: async () => {
        await assertQueueScope(scope);
        return scope.token;
      },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
}
function queueKey(ownerId: string, id: string) {
  return PREFIX + encodeURIComponent(ownerId) + ":" + encodeURIComponent(id);
}
type Capture = Omit<QueuedItem, "ownerId" | "createdAt" | "attempts" | "status" | "id"> & {
  id?: string;
};
async function hold(item: Capture, scope: QueueScope): Promise<string> {
  const id = item.id ?? newId();
  const full: QueuedItem = {
    kind: item.kind,
    payload: item.payload,
    blob: item.blob,
    blobMime: item.blobMime,
    blobs: item.blobs,
    label: item.label,
    ownerId: scope.ownerId,
    id,
    createdAt: Date.now(),
    attempts: 0,
    status: "queued",
  };
  // Keep the initiating owner even if auth changes while IndexedDB is writing.
  await idbSet(queueKey(scope.ownerId, id), full);
  notify();
  return id;
}
export async function enqueue(item: Capture): Promise<string> {
  return hold(item, await requireQueueScope());
}
export async function listQueue(): Promise<QueuedItem[]> {
  const scope = await queueScope();
  if (!scope) return [];
  const all = await idbEntries<string, QueuedItem>();
  try {
    await assertQueueScope(scope);
  } catch {
    return [];
  }
  return all
    .filter(([k, v]) => v?.ownerId === scope.ownerId && k === queueKey(scope.ownerId, v.id))
    .map(([, v]) => v)
    .sort((a, b) => a.createdAt - b.createdAt);
}
/**
 * Count-only notice for the pending-work UI: never expose legacy labels/blobs
 * to whoever happens to sign in next. The sync status UI shows this
 * notice when either count is nonzero, with a support/recovery action.
 *
 * Recovery procedure: retain this browser profile/IndexedDB (do not clear site
 * data); support must independently establish the original owner and intended
 * targets before a reviewed recovery tool exports/requeues each capture under
 * that owner. Neither a payload userId nor the current login proves ownership.
 * There is deliberately no automatic "claim all" or deletion API here.
 */
export async function queueRecoveryStatus(): Promise<{
  syncItems: number;
  photos: number;
  message: string;
}> {
  const scope = await requireQueueScope();
  const all = await idbEntries<string, { id?: string; ownerId?: string }>();
  await assertQueueScope(scope);
  let syncItems = 0;
  let photos = 0;
  for (const [key, value] of all) {
    if (typeof key !== "string") continue;
    const prefix = key.startsWith(PREFIX)
      ? PREFIX
      : key.startsWith("photo-queue:")
        ? "photo-queue:"
        : null;
    if (!prefix) continue;
    const attributedKey =
      value?.ownerId && value.id
        ? prefix + encodeURIComponent(value.ownerId) + ":" + encodeURIComponent(value.id)
        : null;
    if (key === attributedKey) continue;
    if (prefix === PREFIX) syncItems += 1;
    else photos += 1;
  }
  return {
    syncItems,
    photos,
    message:
      "Older unsent work is preserved on this device but its owner could not be verified. Contact support for recovery. Do not clear this browser's site data.",
  };
}

export async function removeItem(id: string) {
  const scope = await requireQueueScope();
  await idbDel(queueKey(scope.ownerId, id));
  notify();
}
async function patch(id: string, p: Partial<QueuedItem>, scope: QueueScope) {
  const key = queueKey(scope.ownerId, id);
  const cur = await idbGet<QueuedItem>(key);
  if (!cur || cur.ownerId !== scope.ownerId) return;
  await idbSet(key, { ...cur, ...p, id: cur.id, ownerId: cur.ownerId });
  notify();
}

// ---------- subscribers ----------
type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  listeners.forEach((l) => l());
}

/**
 * Told once per item the moment it reaches the server — from the queue's
 * drain or from writeOrQueue's first online attempt. TM6: a daily form saved
 * offline and synced later must refresh the job ledger and the T&M bill, and
 * the generic `subscribe` fires on every enqueue and patch as well.
 */
type SyncedListener = (item: Pick<QueuedItem, "kind" | "payload">) => void;
const syncedListeners = new Set<SyncedListener>();
export function onItemSynced(fn: SyncedListener) {
  syncedListeners.add(fn);
  return () => syncedListeners.delete(fn);
}
function notifySynced(item: Pick<QueuedItem, "kind" | "payload">) {
  syncedListeners.forEach((l) => {
    try {
      l(item);
    } catch {
      // A listener's failure never undoes a sync.
    }
  });
}

// ---------- sending ----------

/**
 * When the user did this, as an ISO string.
 *
 * `createdAt` is stamped at enqueue, which is the tap — but a write that
 * reached the network first and only queued after it failed captured its own
 * timestamp a moment earlier, and that one is the record. Falls back to the
 * enqueue time, never to now.
 */
function capturedAt(item: QueuedItem, key = "capturedAt"): string {
  const fromPayload = item.payload[key];
  if (typeof fromPayload === "string" && fromPayload) return fromPayload;
  return new Date(item.createdAt).toISOString();
}

async function send(item: QueuedItem, scope: QueueScope): Promise<void> {
  await assertQueueScope(scope);
  if (item.ownerId !== scope.ownerId) throw new Error("Queue owner mismatch");
  const supabase = queueClient(scope);
  // These local writers use the captured client. Consolidate with offline-writes
  // once that shared module accepts an explicit client dependency.
  /**
   * A refusal the server will repeat however many times it is asked. The queue
   * tests for this flag before it tests error text, so a permanent failure is
   * classified by type rather than by whether its wording happens to match a
   * phrase list. `equipment-scan.ts` throws its own class with the same flag.
   */
  class PermanentWriteError extends Error {
    readonly permanent = true;
    constructor(message: string) {
      super(message);
      this.name = "PermanentWriteError";
    }
  }

  function code(error: unknown): string {
    return String((error as { code?: string } | null)?.code ?? "");
  }

  function text(error: unknown): string {
    return String((error as { message?: string } | null)?.message ?? "");
  }

  /* ------------------------------------------------------------------ */
  /* Time clock                                                          */
  /* ------------------------------------------------------------------ */

  type ClockInRow = {
    /** The queue item id, so a drain that runs twice cannot open two shifts. */
    id: string;
    user_id: string;
    location_id: string;
    /** When the crew tapped the button. */
    clock_in_at: string;
    clock_in_lat: number | null;
    clock_in_lon: number | null;
  };

  /**
   * `shifts_one_open_idx` allows a user one shift with no clock-out. A queued
   * punch draining onto a day where another shift is already open hits it, and
   * no number of retries will change that — someone has to close the other
   * shift. Told apart from a primary-key conflict, which is what a write that in
   * fact succeeded looks like when its response was lost, and which the upsert
   * absorbs.
   */
  async function writeClockIn(row: ClockInRow): Promise<void> {
    const { error } = await supabase.from("shifts").upsert(row as never, { onConflict: "id" });
    if (!error) return;
    if (code(error) === "23505" && /one_open/i.test(text(error))) {
      throw new PermanentWriteError(
        "You already have a shift open that was never clocked out, so this clock-in cannot be filed. Close that shift, then add these hours by hand.",
      );
    }
    throw error;
  }

  type ClockOutInput = {
    shiftId: string;
    /** When the crew tapped the button. */
    at: string;
    lat: number | null;
    lon: number | null;
  };

  /**
   * The read-back is not decoration. An update that matches no row returns
   * success with zero rows — a shift deleted, reassigned, or hidden from this
   * user by RLS all look identical to a clean save, and the queue would drop the
   * punch as sent. `shifts_select` always covers the user's own shifts, so an
   * empty result here really does mean the shift is not theirs any more.
   */
  async function writeClockOut(input: ClockOutInput): Promise<void> {
    const { data, error } = await supabase
      .from("shifts")
      .update({
        clock_out_at: input.at,
        clock_out_lat: input.lat,
        clock_out_lon: input.lon,
        status: "closed",
      })
      .eq("id", input.shiftId)
      .select("id");
    if (error) throw error;
    if (!data?.length) {
      throw new PermanentWriteError(
        "The shift these hours belong to is no longer on your record. Give the times to your manager to enter by hand.",
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Job record                                                          */
  /* ------------------------------------------------------------------ */

  type JobNoteRow = {
    /** The queue item id, so a replay rewrites one note instead of filing two. */
    id: string;
    job_id: string;
    author_id: string | null;
    body: string;
    /** When it was written, not when it landed — the timeline reads by this. */
    created_at: string;
  };

  async function writeJobNote(row: JobNoteRow): Promise<void> {
    const { error } = await supabase.from("job_notes").upsert(row as never, { onConflict: "id" });
    if (error) throw error;
  }

  /**
   * A field patch is idempotent on its own — the same columns set to the same
   * values, however many times it runs. There is deliberately no read-back: not
   * every role that may update a job may select it afterwards, and a false
   * "row not found" would reject an edit that had in fact been applied.
   */
  async function writeJobFields(jobId: string, patch: Record<string, unknown>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    const { error } = await supabase
      .from("jobs")
      .update(patch as never)
      .eq("id", jobId);
    if (error) throw error;
  }

  /* ------------------------------------------------------------------ */
  /* Photo annotations                                                   */
  /* ------------------------------------------------------------------ */

  type PhotoCaptionInput = {
    /** Existing caption comment to rewrite, or null to write the first one. */
    commentId: string | null;
    /** New comment id — the queue item id — used only when commentId is null. */
    id: string;
    photoId: string;
    authorId: string;
    body: string;
    /** When the caption was typed. */
    at: string;
  };

  /**
   * The caption is the photo's first comment, so an edit rewrites that row.
   * RLS lets only the comment's author change it, and refuses by returning zero
   * rows rather than an error — which is why the count is checked and turned
   * into a refusal a person can read.
   */
  async function writePhotoCaption(input: PhotoCaptionInput): Promise<void> {
    const body = input.body.trim();

    if (input.commentId) {
      const { data, error } = await supabase
        .from("photo_comments")
        .update(body ? { body } : { deleted_at: input.at })
        .eq("id", input.commentId)
        .select("id");
      if (error) throw error;
      if (!data?.length) {
        throw new PermanentWriteError("Only whoever wrote that description can change it.");
      }
      return;
    }
    if (!body) return;
    const { error } = await supabase.from("photo_comments").upsert(
      {
        id: input.id,
        photo_id: input.photoId,
        body,
        author_id: input.authorId,
        created_at: input.at,
      } as never,
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  type PhotoTagsInput = {
    photoId: string;
    /** Tag ids to attach and to detach. Replaying either is a no-op. */
    add: string[];
    remove: string[];
    userId: string | null;
  };

  async function writePhotoTags(input: PhotoTagsInput): Promise<void> {
    if (input.remove.length) {
      const { error } = await supabase
        .from("photo_tags")
        .delete()
        .eq("photo_id", input.photoId)
        .in("tag_id", input.remove);
      if (error) throw error;
    }
    if (input.add.length) {
      // Ignore-duplicates rather than insert: a second drain of the same item
      // finds the links already there, and a duplicate key would reject the
      // whole batch including the tags that are not yet attached.
      const { error } = await supabase.from("photo_tags").upsert(
        input.add.map((tag_id) => ({ photo_id: input.photoId, tag_id, created_by: input.userId })),
        { onConflict: "photo_id,tag_id", ignoreDuplicates: true },
      );
      if (error) throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Equipment                                                           */
  /* ------------------------------------------------------------------ */

  type EquipmentNoteInput = {
    equipmentId: string;
    notes: string | null;
    /** When the note was typed, so `updated_at` is not the sync time. */
    at: string;
  };

  async function writeEquipmentNote(input: EquipmentNoteInput): Promise<void> {
    const { error } = await supabase
      .from("equipment")
      .update({ notes: input.notes, updated_at: input.at })
      .eq("id", input.equipmentId);
    if (error) throw error;
  }

  const p = item.payload;
  switch (item.kind) {
    case "note": {
      const { error } = await supabase.from("account_notes").insert({
        account_id: p["accountId"] as string,
        body: p["body"] as string,
        created_by: p["userId"] as string,
      } as never);
      if (error) throw error;
      break;
    }
    case "voice_memo": {
      if (!item.blob) throw new Error("Voice memo lost its recording");
      const path = `voice/${p["userId"]}/${item.id}.webm`;
      const { error: upErr } = await supabase.storage
        .from("documents")
        .upload(path, item.blob, { contentType: item.blobMime ?? "audio/webm", upsert: true });
      if (upErr) throw upErr;
      const { error } = await supabase.from("account_notes").insert({
        account_id: p["accountId"] as string,
        body: (p["transcript"] as string) || "Voice memo",
        created_by: p["userId"] as string,
      } as never);
      if (error) throw error;
      break;
    }
    case "task_complete": {
      // `reopen` is absent on items queued by older builds, which only ever
      // meant "completed" — so its absence has to keep meaning that.
      const reopen = p["reopen"] === true;
      const { error } = await supabase
        .from("tasks")
        .update({
          status: reopen ? "open" : "done",
          completed_at: reopen ? null : capturedAt(item),
          ...(!reopen && typeof p["note"] === "string" && p["note"]
            ? { completion_note: p["note"] }
            : reopen
              ? { completion_note: null }
              : {}),
        })
        .eq("id", p["taskId"] as string);
      if (error) throw error;
      break;
    }
    case "exposure":
    case "outcome":
    case "decline":
    case "arrival":
    case "incident_note": {
      // Everything on the chase path goes through the idempotent applier: the
      // queue item id is the idempotency key, so a retry can never double-create.
      const { error } = await supabase.rpc("apply_offline_op", {
        _key: item.id,
        _kind: item.kind,
        _payload: p as never,
        _client_created_at: new Date(item.createdAt).toISOString(),
      });
      if (error) throw error;
      break;
    }

    case "field_work_ticket":
      await writeFieldWorkTicket({ ...(p as FieldWorkTicketInsert), id: item.id }, supabase);
      break;
    case "drying_reading":
      await writeDryingReading(
        { ...(p as unknown as DryingReadingInsert), id: item.id },
        (item.blobs ?? {}) as DryingReadingBlobs,
        supabase,
      );
      break;
    case "drying_reset":
      await writeDryingReset({ ...(p as unknown as DryingResetInsert), id: item.id }, supabase);
      break;
    case "equipment_place":
      await writePlacement(p as unknown as PlacementRowInput, supabase);
      break;
    case "equipment_retrieve":
      await writeRetrieval(
        {
          placementId: p["placementId"] as string,
          userId: (p["userId"] as string) ?? null,
          condition: p["condition"] as string,
          retrievedAt: new Date(item.createdAt).toISOString(),
          // Absent on items queued before hour meters existed.
          hourMeterEnd: (p["hourMeterEnd"] as number | null | undefined) ?? null,
        },
        supabase,
      );
      break;
    case "equipment_hours":
      await writeHourMeters(p as unknown as HourMeterInput, supabase);
      break;
    case "moisture_point":
      // A new point is the row itself; a change to one is a patch. Kept on one
      // kind so the pending list reads "Moisture test point" either way.
      if (p["op"] === "patch") {
        await patchMoisturePoint(p["change"] as unknown as MoisturePointPatch, supabase);
      } else {
        await writeMoisturePoint({ ...(p["row"] as unknown as MoisturePointRow) }, supabase);
      }
      break;
    case "moisture_reading":
      await writeMoistureReading(
        { ...(p as unknown as MoistureReadingRow), id: item.id },
        supabase,
      );
      break;
    case "tradeshow_lead":
      await writeTradeshowLead(
        p as unknown as TradeshowLeadPayload,
        (item.blobs ?? {}) as TradeshowLeadBlobs,
        supabase,
      );
      break;
    case "todo":
      // A rep's to-do list: add, pin, tick, reorder, promote. Every op is
      // keyed so a replay is a no-op — see todo-writes.ts.
      await applyTodoOp(p as unknown as TodoOp, supabase);
      break;
    case "tm_field_form":
      // A T&M daily sheet. Keyed on (job, kind, day), not the item id, so two
      // phones' saves land on one sheet; a sign-in sheet merges its rows with
      // what is stored first — see tm-forms.ts.
      await writeTmForm(p as unknown as TmFormWrite, supabase as unknown as SupabaseClient);
      break;
    case "room_capture":
      // Field capture on the Rooms tab: a length, a door, a cabinet run.
      // Adds are keyed by the client id and patches are by id, so a replay
      // lands the same row — see room-capture.ts.
      await applyRoomCaptureOp(p as unknown as RoomCaptureOp, supabase);
      break;

    case "clock_in": {
      // The queue item id is the shift row id, so a drain that starts twice
      // updates one shift instead of opening two against the same morning.
      // `clock_in_at` is the moment of the tap: a punch at 7am that reaches
      // the server at noon is five hours of somebody's pay.
      await writeClockIn({ ...(p as unknown as ClockInRow), id: item.id });
      break;
    }

    case "clock_out": {
      await writeClockOut({
        shiftId: p["shiftId"] as string,
        at: capturedAt(item, "at"),
        lat: (p["lat"] as number | null) ?? null,
        lon: (p["lon"] as number | null) ?? null,
      });
      break;
    }

    case "job_note": {
      // Same idempotency key rule as the ticket, and `created_at` is when the
      // note was typed — the job timeline is read in order, and a note filed
      // out of order is a different account of the day.
      await writeJobNote({
        id: item.id,
        job_id: p["jobId"] as string,
        author_id: (p["authorId"] as string) ?? null,
        body: p["body"] as string,
        created_at: capturedAt(item),
      });
      break;
    }

    case "job_field": {
      await writeJobFields(p["jobId"] as string, p["patch"] as Record<string, unknown>);
      break;
    }

    case "photo_caption": {
      await writePhotoCaption({
        ...(p as unknown as Omit<PhotoCaptionInput, "id" | "at">),
        id: item.id,
        at: capturedAt(item),
      });
      break;
    }

    case "photo_tags": {
      await writePhotoTags(p as unknown as PhotoTagsInput);
      break;
    }

    case "equipment_note": {
      await writeEquipmentNote({
        equipmentId: p["equipmentId"] as string,
        notes: (p["notes"] as string | null) ?? null,
        at: capturedAt(item),
      });
      break;
    }

    case "call_outcome":
    case "touchpoint": {
      const { error } = await supabase.from("touchpoints").insert({
        account_id: p["accountId"] as string,
        contact_id: (p["contactId"] as string) ?? null,
        type: (p["type"] as string) ?? "call",
        occurred_at: new Date(item.createdAt).toISOString(),
        notes: (p["notes"] as string) ?? null,
        capture_source: "mobile_offline",
        direction: (p["direction"] as string) ?? "outbound",
        created_by: p["userId"] as string,
      } as never);
      if (error) throw error;
      break;
    }
  }

  /*
   * "Whenever equipment is added" and the drying reset both change what the
   * job's checklist should hold — Monitoring and Pick up equipment appear with
   * the first unit and are re-dated by a reset. Hooked here, after the write
   * has landed, because this is the one path every placement and reset takes
   * once it reaches the server: a reset's first attempt, and every drained
   * item from a basement hours later. Not awaited and never thrown: the
   * checklist must not hold a scan up or mark it failed.
   */
  if (item.kind === "equipment_place" || item.kind === "drying_reset") {
    const jobId = p["job_id"];
    if (typeof jobId === "string") void scheduleAutomaticTaskSync(jobId, scope.ownerId);
  }
}

let draining = false;

/** Push everything queued. Safe to call repeatedly; one drain at a time. */
export async function drain(opts?: { includeRejected?: boolean }): Promise<{
  sent: number;
  failed: number;
}> {
  if (draining || (typeof navigator !== "undefined" && !navigator.onLine)) {
    return { sent: 0, failed: 0 };
  }
  const scope = await queueScope();
  if (!scope || draining) return { sent: 0, failed: 0 };
  draining = true;
  let sent = 0;
  let failed = 0;
  try {
    for (const item of await listQueue()) {
      try {
        await assertQueueScope(scope);
      } catch {
        break;
      }
      if (item.ownerId !== scope.ownerId) break;
      /*
       * A phone killed mid-send used to strand its item in "sending" forever,
       * skipped by every later pass — the work sat on the device and nobody
       * was told. It is reclaimed once the attempt is old enough to be dead,
       * which is safe because every kind here is keyed so a double send lands
       * one row. A second tab genuinely mid-send is left its two minutes.
       */
      if (item.status === "sending" && Date.now() - (item.sendingSince ?? 0) < SENDING_STALE_MS) {
        continue;
      }
      if (item.status === "rejected" && !opts?.includeRejected) continue;
      await patch(item.id, { status: "sending", sendingSince: Date.now() }, scope);
      try {
        await send(item, scope);
        await assertQueueScope(scope);
        await idbDel(queueKey(scope.ownerId, item.id));
        notifySynced(item);
        sent += 1;
      } catch (e) {
        failed += 1;
        await patch(
          item.id,
          {
            // A server refusal is surfaced with its reason, not retried forever.
            status: isPermanent(e) ? "rejected" : "error",
            attempts: item.attempts + 1,
            /*
             * Not `String(e)`. A blocked row throws a PostgrestError and a dead
             * connection throws a bare `{message, code}` object, and stringifying
             * either gave the crew "[object Object]" to act on.
             */
            lastError: describeDbError(e, { action: kindLabel(item.kind) }),
          },
          scope,
        );
      }
    }
  } finally {
    draining = false;
    notify();
  }
  return { sent, failed };
}

/**
 * Try the write now; hold it on the device if the network will not carry it.
 *
 * The one shape every field capture uses, so "saved here, going up later"
 * cannot come to mean something different on each screen. Two rules it exists
 * to enforce:
 *
 *  - `id` is generated before the attempt and is the row's primary key, so the
 *    immediate write and a later drain address the same row. That is what
 *    makes a lost response harmless instead of a duplicate record.
 *  - a refusal the server will repeat is thrown, not queued. Queueing it would
 *    tell the user their work is safe and then bury the refusal in a list an
 *    hour later.
 *
 * The caller must render `queued: true` as pending, never as saved.
 */
export async function writeOrQueue(input: {
  kind: QueuedKind;
  id: string;
  payload: Record<string, unknown>;
  label: string;
  /** Files the write needs; held on the device alongside the payload. */
  blobs?: QueuedItem["blobs"];
  write: () => Promise<void>;
}): Promise<{ queued: boolean }> {
  const scope = await requireQueueScope();
  // Persist first; an account switch or failed response cannot reattribute work.
  const id = await hold(input, scope);
  if (typeof navigator !== "undefined" && !navigator.onLine) return { queued: true };
  const item = await idbGet<QueuedItem>(queueKey(scope.ownerId, id));
  try {
    if (!item) return { queued: true };
    // The callback may close over the mutable singleton; replay through the
    // scoped dispatcher instead, including the first online attempt.
    await send(item, scope);
    await assertQueueScope(scope);
    await idbDel(queueKey(scope.ownerId, id));
    notify();
    notifySynced(item);
    return { queued: false };
  } catch (e) {
    await patch(
      id,
      { status: isPermanent(e) ? "rejected" : "error", lastError: errText(e) },
      scope,
    );
    if (isPermanent(e)) throw e;
    return { queued: true };
  }
}

/** Retry one item by hand from the sync list, rejections included. */
export async function retryItem(id: string): Promise<void> {
  const scope = await requireQueueScope();
  const cur = await idbGet<QueuedItem>(queueKey(scope.ownerId, id));
  if (!cur || cur.ownerId !== scope.ownerId) return;
  await assertQueueScope(scope);
  await patch(id, { status: "queued", lastError: undefined }, scope);
  await drain({ includeRejected: true });
}

/** Wire once at app start: drain on load and whenever the network returns. */
export function startAutoDrain() {
  if (typeof window === "undefined") return () => {};
  const run = () => {
    void drain();
  };
  run();
  window.addEventListener("online", run);
  const timer = window.setInterval(run, 30_000);
  return () => {
    window.removeEventListener("online", run);
    window.clearInterval(timer);
  };
}
