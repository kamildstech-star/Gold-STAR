import { describe, expect, it } from "vitest";

import type { ActivityEntry } from "@/lib/activity";
import {
  buildHistoryItems,
  childrenLabel,
  historyKind,
  mergeTimeline,
  statusMessage,
  type HistoryRow,
} from "@/lib/record-history";

/**
 * The client side of 20261006200000 (photos, crew, contact methods, answers,
 * drying and moisture readings): how their entries read, and the one overlap
 * with the activity feed it removes.
 */

const row = (over: Partial<HistoryRow & { actor_name: string | null }>) => ({
  id: "h1",
  seq: 1,
  occurred_at: "2026-10-06T10:00:00Z",
  table_name: "photos" as const,
  row_pk: "01P1",
  op: "delete" as const,
  job_id: "j1",
  actor_id: "u1",
  actor_name: "Mona",
  summary: "3 photos",
  changes: null,
  changed_columns: null,
  parent_id: null,
  restores_id: null,
  ...over,
});

const photoDeleted = (at: string): ActivityEntry => ({
  occurred_at: at,
  module: "photos",
  event_type: "photo.deleted",
  actor_id: null,
  actor_name: null,
  via: "user",
  summary: "Photo deleted — Removed from job Pictures",
  detail: { path: "p/1.jpg" },
  record_type: "job",
  record_id: "j1",
  record_label: null,
  location_id: null,
});

describe("what comes back with an entry", () => {
  it("reads a batch of photos, an estimate's lines, a point's readings", () => {
    expect(childrenLabel({ photos: 11 })).toBe("11 more photos");
    expect(childrenLabel({ photos: 1 })).toBe("1 more photo");
    expect(childrenLabel({ lines: 3, scopes: 1 })).toBe("3 lines in 1 scope");
    expect(childrenLabel({ scopes: 2, lines: 0 })).toBe("2 scopes");
    expect(childrenLabel({ readings: 2, photos: 0, lines: 0, scopes: 0 })).toBe("2 readings");
    expect(childrenLabel({ photos: 0, lines: 0, scopes: 0, readings: 0 })).toBeNull();
    expect(childrenLabel(null)).toBeNull();
  });

  it("names the new kinds", () => {
    expect(historyKind("photos")).toBe("photo");
    expect(historyKind("job_assignments")).toBe("crew member");
    expect(historyKind("job_moisture_points")).toBe("moisture point");
  });

  it("explains a photo deleted for good", () => {
    expect(statusMessage({ status: "purged", op: "delete" })).toMatch(/deleted for good/);
  });
});

describe("the feed's plain 'Photo deleted' rows", () => {
  it("give way once photos have history entries (they carry no id to match on)", () => {
    const merged = mergeTimeline(
      [photoDeleted("2026-10-06T09:00:00Z"), photoDeleted("2026-09-25T09:00:00Z")],
      buildHistoryItems([row({})]),
    );
    expect(merged.filter((m) => m.kind === "activity")).toHaveLength(0);
    expect(merged.filter((m) => m.kind === "history")).toHaveLength(1);
  });

  it("stay while there are none — before 20261006200000 is applied", () => {
    const merged = mergeTimeline(
      [photoDeleted("2026-10-06T09:00:00Z")],
      buildHistoryItems([row({ table_name: "job_section_notes", summary: "note" })]),
    );
    expect(merged.filter((m) => m.kind === "activity")).toHaveLength(1);
  });
});
