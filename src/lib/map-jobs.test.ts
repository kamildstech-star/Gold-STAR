import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark: "add jobs which is current jobs open or closed", "there should be no
 * limitation on the jobs", "by default keep closed jobs off". So the open
 * and closed reads are separate, neither is capped, and the closed one pages
 * through everything. The Routes page only issues the closed read once its
 * chip is on (guarded in map-pin-details.test.ts); this file pins the read.
 */

const db = vi.hoisted(() => ({
  calls: [] as { select: string; filters: [string, unknown][]; range: [number, number] }[],
  pages: [] as Record<string, unknown>[][],
}));

vi.mock("@/integrations/supabase/client", () => {
  const make = () => {
    const call = {
      select: "",
      filters: [] as [string, unknown][],
      range: [0, 0] as [number, number],
    };
    const q = {
      select: (s: string) => ((call.select = s), q),
      not: (col: string, op: string, v: unknown) => (call.filters.push([`${col} ${op}`, v]), q),
      in: (col: string, v: unknown) => (call.filters.push([`${col} in`, v]), q),
      eq: (col: string, v: unknown) => (call.filters.push([`${col} eq`, v]), q),
      order: () => q,
      range: (from: number, to: number) => {
        call.range = [from, to];
        db.calls.push(call);
        const page = db.pages.shift() ?? [];
        return Promise.resolve({ data: page, error: null });
      },
    };
    return q;
  };
  return { supabase: { from: () => make() } };
});

import { fetchMapJobs, MAP_JOBS_PAGE, mapJobStatuses } from "./map-jobs";

const jobRow = (id: string, status = "in_progress") => ({
  id,
  job_number: `GS-${id}`,
  address: "1 Main St",
  city: "Reno",
  state: "NV",
  postal_code: "89501",
  lat: 39.5,
  lon: -119.8,
  status,
  loss_type: "water",
  location_id: "loc-1",
  account_id: "acc-1",
  account: { name: "Acme", assigned_rep: "rep-1", owner: { full_name: "Alex Brown" } },
  assignments: [
    { role: "technician", end_date: null, person: { full_name: "Tech" } },
    { role: "project_manager", end_date: "2026-01-01", person: { full_name: "Old PM" } },
    { role: "project_manager", end_date: null, person: { full_name: "Dana Reyes" } },
  ],
});

beforeEach(() => {
  db.calls = [];
  db.pages = [];
});

describe("fetchMapJobs", () => {
  it("the open read asks for open statuses only, the closed read for closed only", async () => {
    expect(mapJobStatuses("open")).toEqual(["new", "scheduled", "in_progress", "drying"]);
    expect(mapJobStatuses("closed")).toEqual(["complete", "invoiced", "paid", "cancelled"]);
    db.pages = [[jobRow("1")]];
    await fetchMapJobs({ which: "open", locationIds: ["loc-1"], repId: null });
    expect(db.calls[0]!.filters).toContainEqual(["status in", mapJobStatuses("open")]);
    expect(db.calls[0]!.filters).toContainEqual(["location_id in", ["loc-1"]]);
    expect(db.calls[0]!.select).not.toContain("!inner");
  });

  it("maps the row: open flag, the account's rep as salesman, the current PM", async () => {
    db.pages = [[jobRow("1"), jobRow("2", "paid")]];
    const jobs = await fetchMapJobs({ which: "open", locationIds: [], repId: null });
    expect(jobs[0]).toMatchObject({
      id: "1",
      job_number: "GS-1",
      address: "1 Main St, Reno, NV, 89501",
      open: true,
      account_name: "Acme",
      owner_name: "Alex Brown",
      pm_name: "Dana Reyes",
    });
    expect(jobs[1]!.open).toBe(false);
  });

  it("pages until a short page — no cap on closed jobs", async () => {
    const full = Array.from({ length: MAP_JOBS_PAGE }, (_, i) => jobRow(`a${i}`, "paid"));
    db.pages = [full, [jobRow("last", "paid")]];
    const jobs = await fetchMapJobs({ which: "closed", locationIds: [], repId: null });
    expect(jobs).toHaveLength(MAP_JOBS_PAGE + 1);
    expect(db.calls.map((c) => c.range)).toEqual([
      [0, MAP_JOBS_PAGE - 1],
      [MAP_JOBS_PAGE, 2 * MAP_JOBS_PAGE - 1],
    ]);
  });

  it("narrows to a rep's book through the account join, and only then", async () => {
    db.pages = [[]];
    await fetchMapJobs({ which: "open", locationIds: [], repId: "rep-1" });
    expect(db.calls[0]!.select).toContain("accounts!jobs_account_id_fkey!inner");
    expect(db.calls[0]!.filters).toContainEqual(["account.assigned_rep eq", "rep-1"]);
  });
});
