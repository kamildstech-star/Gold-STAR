import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  cleanWriteUp,
  writeUpAmount,
  writeUpDates,
  writeUpsByRoom,
  type WriteUpItem,
} from "./job-write-ups";

/* FE11, 28 Oct: the write-up sheet. */
const item = (over: Partial<WriteUpItem>): WriteUpItem => ({
  id: "w",
  job_id: "j",
  room_id: null,
  visit_date: "2026-10-28",
  description: "Flood cut",
  quantity: null,
  unit: null,
  sort_order: 0,
  created_by: "u",
  created_at: "2026-10-28T12:00:00Z",
  ...over,
});

describe("write-up lines", () => {
  it("cleans what was typed and refuses an empty line", () => {
    const base = {
      jobId: "j",
      roomId: null,
      visitDate: "2026-10-28",
      quantity: 12.345,
      unit: " sf ",
      userId: "u",
    };
    expect(cleanWriteUp({ ...base, description: "  Removed carpet  " })).toMatchObject({
      description: "Removed carpet",
      quantity: 12.35,
      unit: "sf",
    });
    expect(cleanWriteUp({ ...base, description: "   " })).toBeNull();
    expect(cleanWriteUp({ ...base, description: "x", visitDate: "10/28/2026" })).toBeNull();
    expect(cleanWriteUp({ ...base, description: "x", quantity: -1 })!.quantity).toBeNull();
  });

  it("reads an amount the way a crew writes it", () => {
    expect(writeUpAmount({ quantity: 120, unit: "SF" })).toBe("120 SF");
    expect(writeUpAmount({ quantity: 2.5, unit: null })).toBe("2.50");
    expect(writeUpAmount({ quantity: null, unit: null })).toBe("");
  });

  it("groups a visit by room in the job's room order, no-room lines last", () => {
    const groups = writeUpsByRoom(
      [
        item({ id: "1", room_id: "kitchen" }),
        item({ id: "2", room_id: null }),
        item({ id: "3", room_id: "bath" }),
        item({ id: "4", room_id: "kitchen" }),
        item({ id: "5", room_id: "deleted-room" }),
      ],
      ["bath", "kitchen"],
    );
    expect(groups.map((g) => [g.roomId, g.items.map((i) => i.id)])).toEqual([
      ["bath", ["3"]],
      ["kitchen", ["1", "4"]],
      [null, ["2", "5"]],
    ]);
  });

  it("lists the visit dates newest first, once each", () => {
    expect(
      writeUpDates([
        item({ visit_date: "2026-10-26" }),
        item({ visit_date: "2026-10-28" }),
        item({ visit_date: "2026-10-26" }),
      ]),
    ).toEqual(["2026-10-28", "2026-10-26"]);
  });
});

describe("wiring", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("lives on the Rooms tab and feeds the Scope of work card", () => {
    const page = read("src/routes/_authenticated/jobs.$id.tsx");
    const rooms = page.match(/<TabsContent value="rooms"[\s\S]*?<\/TabsContent>/)![0];
    expect(rooms).toContain("<JobWriteUpsPanel jobId={job.id} />");
    expect(read("src/components/scope-of-work-card.tsx")).toContain("fetchWriteUps(job.id)");
  });

  it("the table is job-scoped with row security, and anyone on the job writes as themselves", () => {
    const sql = read("supabase/migrations/20261028120000_job_write_ups.sql");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON public.job_write_up_items FROM anon, authenticated;");
    expect(sql).toMatch(
      /FOR INSERT[\s\S]*?can_view_job\(auth\.uid\(\), job_id\) AND created_by = auth\.uid\(\)/,
    );
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  });
});
