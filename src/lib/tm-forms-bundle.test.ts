import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  TM_FORM_META,
  normalisePayload,
  type TmFormKind,
  type TmPayloadByKind,
} from "@/lib/tm-forms";
import { buildTmFormsBundle, spanText } from "@/lib/tm-forms-bundle";
import {
  WHOLE_JOB,
  groupTmForms,
  inRange,
  normaliseRange,
  tmBundleFilename,
  tmJobSpan,
} from "@/lib/tm-forms-bundle-plan";
import { TM_RATE_CODES_COMPILED } from "@/lib/tm-rate-codes";

/**
 * David, 15 Oct: "Download all" on the Field Form tab — every filled sign-in
 * sheet, crew chief report and supply list for the job, or a date range, as
 * one PDF for the carrier, grouped by the three sheet types.
 */

const rows = [
  { kind: "supply_list" as const, form_date: "2026-10-03" },
  { kind: "sign_in" as const, form_date: "2026-10-03" },
  { kind: "sign_in" as const, form_date: "2026-10-01" },
  { kind: "crew_chief" as const, form_date: "2026-10-02" },
  { kind: "sign_in" as const, form_date: "2026-10-05" },
  { kind: "supply_list" as const, form_date: "2026-10-01" },
];

describe("which sheets go in", () => {
  it("groups by sheet type in the order the sheets are kept, oldest day first", () => {
    const groups = groupTmForms(rows, WHOLE_JOB);
    expect(groups.map((g) => g.kind)).toEqual(["sign_in", "crew_chief", "supply_list"]);
    expect(groups[0]!.days).toEqual(["2026-10-01", "2026-10-03", "2026-10-05"]);
    expect(groups[2]!.days).toEqual(["2026-10-01", "2026-10-03"]);
    expect(groups[0]!.title).toBe("Crew sign-in sheets");
  });

  it("keeps a date range inclusive at both ends", () => {
    const groups = groupTmForms(rows, { from: "2026-10-02", to: "2026-10-03" });
    expect(groups.map((g) => [g.kind, g.days])).toEqual([
      ["sign_in", ["2026-10-03"]],
      ["crew_chief", ["2026-10-02"]],
      ["supply_list", ["2026-10-03"]],
    ]);
  });

  it("reads a backwards range the right way round and an open side as open", () => {
    expect(normaliseRange({ from: "2026-10-09", to: "2026-10-01" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-09",
    });
    expect(inRange("2026-12-31", { from: "2026-10-01", to: null })).toBe(true);
    expect(inRange("2026-09-30", { from: "2026-10-01", to: null })).toBe(false);
    expect(normaliseRange({ from: "garbage", to: "" })).toEqual(WHOLE_JOB);
  });

  it("leaves out a type with nothing in range, and types the user unticked", () => {
    expect(groupTmForms(rows, { from: "2026-10-05", to: "2026-10-05" }).map((g) => g.kind)).toEqual(
      ["sign_in"],
    );
    expect(groupTmForms(rows, WHOLE_JOB, ["supply_list"]).map((g) => g.kind)).toEqual([
      "supply_list",
    ]);
    expect(groupTmForms([], WHOLE_JOB)).toEqual([]);
  });

  it("names the job's first and last day, and the file after the range", () => {
    expect(tmJobSpan(rows)).toEqual({ first: "2026-10-01", last: "2026-10-05" });
    expect(tmJobSpan([])).toBeNull();
    expect(tmBundleFilename("GS-1042", WHOLE_JOB)).toBe("tm-field-forms-GS-1042-all.pdf");
    expect(tmBundleFilename("GS 1042", { from: "2026-10-01", to: "2026-10-03" })).toBe(
      "tm-field-forms-GS1042-2026-10-01-to-2026-10-03.pdf",
    );
    expect(tmBundleFilename(null, { from: "2026-10-02", to: "2026-10-02" })).toBe(
      "tm-field-forms-2026-10-02.pdf",
    );
    expect(spanText(["2026-10-01", "2026-10-05"])).toBe("10/01/2026 - 10/05/2026");
  });
});

describe("the PDF", () => {
  const template = async (kind: TmFormKind) =>
    new Uint8Array(readFileSync(join("public", TM_FORM_META[kind].template)));

  it("fills every sheet on Gold Star's paper, behind a cover and one divider per type", async () => {
    const groups = groupTmForms(rows, WHOLE_JOB);
    const loaded: string[] = [];
    const progress: number[] = [];
    const out = await buildTmFormsBundle({
      jobName: "Marriott Riverside",
      jobNumber: "GS-1042",
      range: WHOLE_JOB,
      groups,
      load: async <K extends TmFormKind>(kind: K, day: string) => {
        loaded.push(`${kind}:${day}`);
        return normalisePayload(kind, { jobName: "Marriott Riverside" }) as TmPayloadByKind[K];
      },
      template,
      catalogue: TM_RATE_CODES_COMPILED,
      onProgress: (done) => progress.push(done),
    });

    // Sheets in group order, oldest first inside each group.
    expect(loaded).toEqual([
      "sign_in:2026-10-01",
      "sign_in:2026-10-03",
      "sign_in:2026-10-05",
      "crew_chief:2026-10-02",
      "supply_list:2026-10-01",
      "supply_list:2026-10-03",
    ]);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.sheets).toBe(6);
    expect(out.skipped).toEqual([]);
    // Cover + 3 dividers + 6 single-page sheets.
    expect(out.pages).toBe(10);
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(10);
  });

  it("names a sheet that could not be filled instead of dropping it", async () => {
    const out = await buildTmFormsBundle({
      jobName: "Job",
      jobNumber: null,
      range: WHOLE_JOB,
      groups: groupTmForms(rows, WHOLE_JOB, ["crew_chief"]),
      load: async () => null,
      template,
      catalogue: TM_RATE_CODES_COMPILED,
    });
    expect(out.sheets).toBe(0);
    expect(out.skipped).toEqual([
      { name: "Daily Crew Chief - 10/02/2026", reason: "no longer on the job" },
    ]);
  });
});

describe("the button", () => {
  const panel = readFileSync("src/components/tm-field-forms-panel.tsx", "utf8");
  it("sits at the top of the Field Form panel and opens the range picker", () => {
    const header = panel.slice(panel.indexOf("<CardHeader"), panel.indexOf("</CardHeader>"));
    expect(header).toContain("data-tm-download-all");
    expect(header).toContain("setBundleOpen(true)");
    expect(panel).toContain("<TmFormsBundleDialog");
  });
});
