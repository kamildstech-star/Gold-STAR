import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/*
 * FE7, 28 Oct: "Clear generated data" gives the next report a fresh start —
 * the job's unapproved drafts only, marked superseded (never deleted), and
 * nothing else on the job.
 */
const calls: { op: string; args: unknown[] }[] = [];
vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  for (const op of ["from", "update", "eq", "neq", "select", "order"]) {
    chain[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      if (op === "select" && calls.some((c) => c.op === "update")) {
        return Promise.resolve({ data: [{ id: "r1" }, { id: "r2" }], error: null });
      }
      if (op === "order") return Promise.resolve({ data: [], error: null });
      return chain;
    };
  }
  return { supabase: chain };
});

import { clearDraftReports, listJobReports } from "./job-reports";

describe("clearing generated report data", () => {
  it("supersedes this job's drafts and nothing else", async () => {
    calls.length = 0;
    await expect(clearDraftReports("job-1")).resolves.toBe(2);
    expect(calls[0]).toEqual({ op: "from", args: ["job_reports"] });
    expect(calls).toContainEqual({ op: "update", args: [{ status: "superseded" }] });
    expect(calls).toContainEqual({ op: "eq", args: ["job_id", "job-1"] });
    expect(calls).toContainEqual({ op: "eq", args: ["status", "draft"] });
    expect(calls.some((c) => c.op === "delete")).toBe(false);
  });

  it("a cleared draft is no longer listed", async () => {
    calls.length = 0;
    await listJobReports("job-1");
    expect(calls).toContainEqual({ op: "neq", args: ["status", "superseded"] });
  });

  it("asks first, and resets the composer to blank", () => {
    const panel = readFileSync("src/components/job-report-panel.tsx", "utf8");
    expect(panel).toContain("Clear generated report data?");
    const m = panel.match(/const clearGenerated = useMutation\(\{[\s\S]*?\n {2}\}\);/)![0];
    for (const reset of ["setSections(emptySections())", "setPhotoIds([])", "setDates(ALL_DAYS)"]) {
      expect(m).toContain(reset);
    }
  });
});
