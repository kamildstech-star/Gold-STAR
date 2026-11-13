/**
 * Placing and retrieving a unit from the field.
 *
 * Same rule as every other capture on this app: nothing blocks on the network.
 * The crew is standing in the room with the machine, and the only thing they
 * need to know is whether the log went up now or is being held on the phone.
 * Split from equipment-scan.ts only so the offline queue can import the raw
 * writes without importing itself back.
 */
import { drain, enqueue, newId, writeOrQueue } from "@/lib/offline-queue";
import {
  isPermanentPlacementError,
  writeHourMeters,
  writePlacement,
  writeRetrieval,
  type HourMeterInput,
  type PlacementRowInput,
} from "@/lib/equipment-scan";
import { writeEquipmentNote } from "@/lib/offline-writes";
import { scheduleAutomaticTaskSync } from "@/lib/automatic-job-tasks";

export type PlaceInput = {
  equipmentId: string;
  assetTag: string;
  jobId: string;
  userId: string;
  expectedRetrievalDate: string | null;
  roomId: string | null;
  lat: number | null;
  lon: number | null;
  /** The dial as it went in, when the machine has one and it was read. */
  hourMeterStart?: number | null;
};

export async function placeUnit(input: PlaceInput): Promise<{ queued: boolean }> {
  // The queue item id is the placement row id, so a drain that runs twice
  // updates one placement instead of logging the unit out twice.
  const id = newId();
  const row: PlacementRowInput = {
    id,
    equipment_id: input.equipmentId,
    job_id: input.jobId,
    placed_by: input.userId,
    placed_lat: input.lat,
    placed_lon: input.lon,
    expected_retrieval_date: input.expectedRetrievalDate,
    room_id: input.roomId,
    // Capture time, so an offline scan keeps the day it happened.
    placed_at: new Date().toISOString(),
    // Only sent when read, so a database without the column (and every unit
    // with no meter) writes exactly the row it always did.
    ...(input.hourMeterStart != null ? { hour_meter_start: input.hourMeterStart } : {}),
  };
  const hold = async () => {
    await enqueue({
      id,
      kind: "equipment_place",
      payload: row as unknown as Record<string, unknown>,
      label: `${input.assetTag} placed`,
    });
    return { queued: true };
  };

  if (typeof navigator !== "undefined" && !navigator.onLine) return hold();
  try {
    await writePlacement(row);
    // "Whenever equipment is added": the job's Monitoring and Pick up
    // equipment tasks. The queued path does the same from the queue once the
    // placement lands; see automatic-job-tasks.ts.
    void scheduleAutomaticTaskSync(input.jobId, input.userId);
    return { queued: false };
  } catch (e) {
    // A refusal the server will repeat — the unit is out on another job — is
    // shown now rather than queued to fail quietly in an hour.
    if (isPermanentPlacementError(e)) throw e;
    await hold();
    void drain();
    return { queued: true };
  }
}

export type RetrieveInput = {
  placementId: string;
  assetTag: string;
  userId: string | null;
  condition: string;
  /** The dial as it came off the job. */
  hourMeterEnd?: number | null;
};

export async function retrieveUnit(input: RetrieveInput): Promise<{ queued: boolean }> {
  const id = newId();
  const payload = {
    placementId: input.placementId,
    userId: input.userId,
    condition: input.condition,
    hourMeterEnd: input.hourMeterEnd ?? null,
  };
  const hold = async () => {
    await enqueue({
      id,
      kind: "equipment_retrieve",
      payload,
      label: `${input.assetTag} retrieved`,
    });
    return { queued: true };
  };

  if (typeof navigator !== "undefined" && !navigator.onLine) return hold();
  try {
    await writeRetrieval({
      placementId: input.placementId,
      userId: input.userId,
      condition: input.condition,
      retrievedAt: new Date().toISOString(),
      hourMeterEnd: input.hourMeterEnd ?? null,
    });
    return { queued: false };
  } catch {
    await hold();
    void drain();
    return { queued: true };
  }
}

/**
 * The note on a unit: damage found, service done, where the plate is mounted.
 *
 * Written by whoever is standing next to the machine, which is where the
 * signal is worst. `updated_at` carries the moment it was typed rather than
 * the moment it synced, so "last touched" on the unit means what it says.
 *
 * Last-write-wins, and a repeat of the same write sets the same text again, so
 * the queue needs no key here beyond the one it uses to list the item.
 */
export async function saveEquipmentNote(input: {
  equipmentId: string;
  assetTag: string;
  notes: string | null;
}): Promise<{ queued: boolean }> {
  const capturedAt = new Date().toISOString();
  const write = { equipmentId: input.equipmentId, notes: input.notes, at: capturedAt };
  return writeOrQueue({
    kind: "equipment_note",
    id: newId(),
    payload: { ...write, capturedAt },
    label: `${input.assetTag} note`,
    write: () => writeEquipmentNote(write),
  });
}

/**
 * An hour-meter reading added or corrected on a placement after the fact,
 * through the queue like every other field write. Setting the same numbers
 * twice is the same row, so a replay needs no key beyond the item's own.
 */
export async function saveHourMeters(
  input: HourMeterInput & { assetTag: string },
): Promise<{ queued: boolean }> {
  const { assetTag, ...write } = input;
  return writeOrQueue({
    kind: "equipment_hours",
    id: newId(),
    payload: write as unknown as Record<string, unknown>,
    label: `${assetTag} hour meter`,
    write: () => writeHourMeters(write),
  });
}
