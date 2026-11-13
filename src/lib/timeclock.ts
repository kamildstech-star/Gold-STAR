import { enqueue, newId, writeOrQueue, type QueuedItem } from "@/lib/offline-queue";
import { writeClockIn, writeClockOut, type ClockInRow } from "@/lib/offline-writes";
import type { Database } from "@/integrations/supabase/types";
import { TONE } from "@/lib/tone";

export type ShiftStatus = Database["public"]["Enums"]["shift_status"];

export const SHIFT_STATUS_LABEL: Record<ShiftStatus, string> = {
  open: "Clocked in",
  closed: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};

export const SHIFT_STATUS_TONE: Record<ShiftStatus, string> = {
  open: TONE.success,
  closed: TONE.warning,
  approved: TONE.brand,
  rejected: TONE.danger,
};

export function fmtMinutes(min: number | null | undefined): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function elapsedMinutes(fromIso: string, toIso?: string | null): number {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  return Math.max(0, Math.round((to - from) / 60000));
}

/** Monday-start week bounds for a given date. */
export function weekBounds(d = new Date()): { start: Date; end: Date } {
  const start = new Date(d);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

export function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export type Coords = { lat: number | null; lon: number | null };

/**
 * One-shot position read. Event-based only — we never start a watcher, and a
 * denied or unavailable fix still lets the clock event through.
 */
export function getPositionOnce(timeoutMs = 8000): Promise<Coords> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve({ lat: null, lon: null });
      return;
    }
    let settled = false;
    const done = (c: Coords) => {
      if (settled) return;
      settled = true;
      resolve(c);
    };
    navigator.geolocation.getCurrentPosition(
      (p) => done({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => done({ lat: null, lon: null }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 },
    );
    setTimeout(() => done({ lat: null, lon: null }), timeoutMs + 500);
  });
}

// ---------------------------------------------------------------------------
// Clocking in and out — a punch must never be lost because there's no signal.
//
// These go through the app-wide sync queue rather than a private list, so a
// crew sees one pending count for the whole shift instead of two places to
// check, and so a punch the server refuses is surfaced with its reason instead
// of being retried silently until someone notices the missing hours.
// ---------------------------------------------------------------------------

export type ClockResult = { queued: boolean; shiftId: string };

/**
 * The shift id is minted here, before the network is touched, and is used as
 * the row's primary key. That is what lets the same punch be written now or in
 * three hours without becoming two shifts — and it is what lets a clock-out be
 * queued against a clock-in that has not reached the server yet, because the
 * queue drains oldest first and the id is already known.
 */
export async function clockIn(input: {
  userId: string;
  locationId: string;
  at: string;
  lat: number | null;
  lon: number | null;
}): Promise<ClockResult> {
  const id = newId();
  const row: ClockInRow = {
    id,
    user_id: input.userId,
    location_id: input.locationId,
    clock_in_at: input.at,
    clock_in_lat: input.lat,
    clock_in_lon: input.lon,
  };
  const { queued } = await writeOrQueue({
    kind: "clock_in",
    id,
    payload: row as unknown as Record<string, unknown>,
    label: `Clock in ${fmtTime(input.at)}`,
    write: () => writeClockIn(row),
  });
  return { queued, shiftId: id };
}

export async function clockOut(input: {
  shiftId: string;
  at: string;
  lat: number | null;
  lon: number | null;
}): Promise<ClockResult> {
  const { queued } = await writeOrQueue({
    kind: "clock_out",
    id: newId(),
    payload: { ...input },
    label: `Clock out ${fmtTime(input.at)}`,
    write: () => writeClockOut(input),
  });
  return { queued, shiftId: input.shiftId };
}

/**
 * The shift a punch on this device says is open, when the server cannot be
 * asked or has not caught up. Built from the queue rather than from a second
 * store, so there is one record of pending work.
 *
 * Returns null when the device's own last punch was a clock-out, which is not
 * the same as "the server says you are clocked out" — the caller still has to
 * treat a failed read as unknown.
 */
export function pendingShift(items: QueuedItem[]): { shiftId: string; at: string } | null {
  const punches = items
    .filter((i) => i.kind === "clock_in" || i.kind === "clock_out")
    .sort((a, b) => a.createdAt - b.createdAt);
  const last = punches[punches.length - 1];
  if (!last || last.kind !== "clock_in") return null;
  return { shiftId: last.id, at: String(last.payload["clock_in_at"] ?? "") };
}

// ---------------------------------------------------------------------------
// Migration off the old private queue
// ---------------------------------------------------------------------------

const LEGACY_QUEUE_KEY = "rh:clockQueue";

type LegacyClockEvent = {
  id: string;
  kind: "clock_in" | "clock_out";
  shiftId?: string;
  locationId?: string;
  userId: string;
  at: string;
  lat: number | null;
  lon: number | null;
};

/**
 * Punches captured by the previous build sit in localStorage where nothing
 * drains them any more. They are hours of somebody's pay, so they are moved
 * into the sync queue on first load rather than left behind — keeping each
 * event's own `at`, and its own id as the shift id, so a punch that in fact
 * reached the server before the upgrade updates that row instead of opening a
 * second shift.
 */
export async function migrateLegacyClockQueue(): Promise<number> {
  if (typeof window === "undefined") return 0;
  let events: LegacyClockEvent[] = [];
  try {
    events = JSON.parse(window.localStorage.getItem(LEGACY_QUEUE_KEY) || "[]");
  } catch {
    return 0;
  }
  if (!Array.isArray(events) || events.length === 0) return 0;

  for (const ev of events) {
    if (ev.kind === "clock_in" && ev.locationId) {
      await enqueue({
        id: ev.id,
        kind: "clock_in",
        payload: {
          id: ev.id,
          user_id: ev.userId,
          location_id: ev.locationId,
          clock_in_at: ev.at,
          clock_in_lat: ev.lat,
          clock_in_lon: ev.lon,
        },
        label: `Clock in ${fmtTime(ev.at)}`,
      });
    } else if (ev.kind === "clock_out" && ev.shiftId) {
      await enqueue({
        id: ev.id,
        kind: "clock_out",
        payload: { shiftId: ev.shiftId, at: ev.at, lat: ev.lat, lon: ev.lon },
        label: `Clock out ${fmtTime(ev.at)}`,
      });
    }
  }
  window.localStorage.removeItem(LEGACY_QUEUE_KEY);
  return events.length;
}
