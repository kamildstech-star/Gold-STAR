/**
 * TM6: saving or filing a T&M sign-in sheet updates the job ledger and the
 * T&M bill at once — online, and when an offline save syncs later.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { refreshTmDerived, tmDerivedQueryKeys } from "./tm-derived";

describe("refreshTmDerived", () => {
  it("marks the forms, the ledger's effort and the T&M bill's source stale for the job", () => {
    const invalidateQueries = vi.fn();
    refreshTmDerived({ invalidateQueries } as never, "job-1");
    const keys = invalidateQueries.mock.calls.map(
      (c) => (c[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        ["tm-forms", "job-1"],
        ["tm-bill-source", "job-1"],
        ["job-ledger-effort", "job-1"],
      ]),
    );
    expect(keys.every((k) => k[1] === "job-1")).toBe(true);
  });

  it("covers the exact keys the ledger and the bill dialog read", () => {
    const ledger = readFileSync("src/components/job-ledger-panel.tsx", "utf8");
    const dialog = readFileSync("src/components/tm-bill-dialog.tsx", "utf8");
    expect(ledger).toContain('queryKey: ["job-ledger-effort", jobId]');
    expect(dialog).toMatch(/queryKey: \["tm-bill-source", job\.id/);
    const prefixes = tmDerivedQueryKeys("x").map((k) => k[0]);
    expect(prefixes).toContain("job-ledger-effort");
    expect(prefixes).toContain("tm-bill-source");
  });
});

describe("wiring", () => {
  it("the sign-in sheet's save refreshes everything derived, not just the forms list", () => {
    const panel = readFileSync("src/components/tm-field-forms-panel.tsx", "utf8");
    const save = panel.slice(
      panel.indexOf("async function save("),
      panel.indexOf("const previousLines"),
    );
    expect(save).toContain("refreshTmDerived(qc, job.id)");
  });

  it("a daily field form's save does the same", () => {
    const panel = readFileSync("src/components/field-work-ticket-panel.tsx", "utf8");
    expect(panel.match(/refreshTmDerived\(qc, jobId\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("a form synced from the offline queue refreshes the ledger strip and the open bill", () => {
    const queue = readFileSync("src/lib/offline-queue.ts", "utf8");
    expect(queue.match(/notifySynced\(item\)/g)?.length).toBe(2);
    expect(readFileSync("src/components/job-ledger-panel.tsx", "utf8")).toContain(
      "useRefreshTmDerivedOnSync(jobId)",
    );
    expect(readFileSync("src/components/tm-bill-dialog.tsx", "utf8")).toContain(
      "useRefreshTmDerivedOnSync(job.id)",
    );
  });
});
