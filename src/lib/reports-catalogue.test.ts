import { describe, expect, it } from "vitest";

import { REPORTS, reportById } from "@/lib/reports-engine";

/**
 * The report buttons are addressed by id in the URL and numbered on screen,
 * so a duplicate would quietly shadow a report and a gap would misnumber the
 * row. Cheap to check, and it covers the six presets added for Melly.
 */
describe("the report catalog", () => {
  it("has a unique id and a unique number for every report", () => {
    expect(new Set(REPORTS.map((r) => r.id)).size).toBe(REPORTS.length);
    expect(new Set(REPORTS.map((r) => r.num)).size).toBe(REPORTS.length);
  });

  it("numbers the reports 1..n with no gaps", () => {
    expect([...REPORTS.map((r) => r.num)].sort((a, b) => a - b)).toEqual(
      REPORTS.map((_, i) => i + 1),
    );
  });

  it("says what populates every report, so an empty one is never a mystery", () => {
    for (const r of REPORTS) {
      expect(r.title.length, r.id).toBeGreaterThan(0);
      expect(r.question.length, r.id).toBeGreaterThan(0);
      expect(r.populatedBy.length, r.id).toBeGreaterThan(20);
    }
  });

  it("carries the pulls Melly asked for", () => {
    const pulls = REPORTS.filter((r) => r.group === "pulls").map((r) => r.id);
    expect(pulls).toEqual([
      "open-jobs",
      "jobs-invoiced",
      "jobs-paid",
      "jobs-unpaid",
      "public-adjuster",
      "jobs-by-salesperson",
    ]);
  });

  it("Jobs paid can list each payment, not only the total per invoice (6 Nov)", () => {
    const paid = reportById("jobs-paid");
    const view = paid.options?.find((o) => o.key === "view");
    expect(view?.choices.map((c) => c.value)).toEqual(["invoices", "payments"]);
    // The default is the roll-up the report always showed; the switch adds the detail.
    expect(view?.choices[0]?.label).toBe("By invoice");
    expect(view?.choices[1]?.label).toBe("Each payment");
  });

  it("falls back to the first report for an unknown or missing id", () => {
    expect(reportById(undefined).id).toBe(REPORTS[0]!.id);
    expect(reportById("not-a-report").id).toBe(REPORTS[0]!.id);
    expect(reportById("jobs-unpaid").id).toBe("jobs-unpaid");
  });
});
