// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { JobRoom } from "@/lib/job-rooms";

/**
 * The Rooms tab, rendered. Every room row showed its Measure button twice
 * once the field-capture PRs had all merged: #299 put one at the end of the
 * row and #315 added another beside the photo buttons without taking the
 * first one out. A room has one Measure panel, so it has one button.
 */
const room = (id: string, name: string, unit: string | null = null): JobRoom => ({
  id,
  job_id: "job-1",
  unit,
  name,
  floor: null,
  length_ft: 12,
  width_ft: 10,
  height_ft: 8,
  affected_materials: [],
  notes: null,
  sort_order: 0,
  flooring: null,
  extra_sf: 0,
});

const ROOMS = [room("r1", "Kitchen", "4B"), room("r2", "Bedroom", "4B"), room("r3", "Hall")];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const answers: Record<string, unknown> = {
      "job-rooms": { rooms: ROOMS, unitAvailable: true, captureColumnsAvailable: true },
      "job-room-placements": [],
      "room-photo-folders": [],
    };
    return { data: answers[String(queryKey[0])], isLoading: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
// The photo buttons now carry a Field Camera link; there is no router here.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children?: unknown; [k: string]: unknown }) =>
    createElement("a", { "aria-label": rest["aria-label"] as string }, children as never),
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "u1", writesDisabled: false, roles: [] }),
}));
vi.mock("@/lib/export-guard", () => ({
  useExportGate: () => ({ allowed: false, runExport: () => {} }),
}));
vi.mock("@/lib/use-room-capture", () => ({
  useRoomCapture: (_jobId: string, rooms: JobRoom[]) => ({
    rooms,
    openings: [],
    cabinets: [],
    partsAvailable: true,
    run: () => {},
  }),
}));

import { JobRoomsTab } from "./job-rooms-tab";

const renderRows = () => {
  const html = renderToStaticMarkup(
    createElement(JobRoomsTab, {
      job: { id: "job-1", job_number: "J-1" } as never,
      projectId: "album-1",
    }),
  );
  document.body.innerHTML = html;
  // Each room row is the block that holds that room's delete button.
  return [...document.querySelectorAll("button")]
    .filter((b) => b.querySelector(".lucide-trash2, .lucide-trash-2"))
    .map((trash) => trash.closest("div.border-b") as HTMLElement);
};

const measureButtons = (row: HTMLElement) =>
  [...row.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Measure");

describe("the Rooms tab, rendered", () => {
  it("renders a row for every room", () => {
    expect(renderRows()).toHaveLength(ROOMS.length);
  });

  it("gives each room row exactly one Measure button", () => {
    for (const row of renderRows()) expect(measureButtons(row)).toHaveLength(1);
  });

  it("keeps Measure beside the photo buttons, before delete", () => {
    for (const row of renderRows()) {
      const controls = [...row.querySelectorAll(":scope > div:first-child > *")];
      const measure = controls.indexOf(measureButtons(row)[0]);
      const photos = controls.findIndex((c) => c.textContent?.includes("Photo"));
      expect(photos).toBeGreaterThan(-1);
      expect(measure).toBe(photos + 1);
      expect(controls[measure + 1].querySelector("svg")?.getAttribute("class")).toMatch(/trash/);
      // Same touch height as the photo button: 44px on a phone, 28px on desktop.
      expect(measureButtons(row)[0].className).toMatch(/\bh-11\b.*\bsm:h-7\b/);
    }
  });
});
