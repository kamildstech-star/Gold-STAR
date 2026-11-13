import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The drying log leaves the app as a workbook, from the Drying log tab. What
 * the file says is pinned in src/lib/drying-log-export.test.ts; this pins that
 * the tab actually hands it the job's readings and goes through the export
 * gate. Fragments are extracted before asserting, so an explanatory comment
 * can neither satisfy nor break a check.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const LOG = read("src/components/job-drying-log.tsx");
const JOB_PAGE = read("src/routes/_authenticated/jobs.$id.tsx");

const button = LOG.match(/<ExportExcelButton\b[^>]*?\/>/)?.[0] ?? "";

describe("the drying log download", () => {
  it("is drawn on the Drying log tab, through the gated export button", () => {
    expect(button).not.toBe("");
    expect(LOG).toMatch(
      /import \{ ExportExcelButton \} from "@\/components\/export-excel-button";/,
    );
    expect(button).toMatch(/surface="drying-log"/);
    expect(button).toMatch(/sheets=\{exportSheets\}/);
    expect(button).toMatch(/report=\{dryingLogReportName\(jobNumber\)\}/);
  });

  it("is built from every reading the tab loaded, with the room names", () => {
    const build = LOG.match(/const exportSheets = dryingLogWorkbook\(\{[^}]*\}\)/)?.[0] ?? "";
    expect(build).toMatch(/rows: readings\b/);
    expect(build).toMatch(/\broomNames\b/);
    expect(build).toMatch(/\bjobNumber\b/);
    expect(build).toMatch(/\baddress\b/);
  });

  it("waits for the room names, and for something to export", () => {
    const disabled = button.match(/disabled=\{[^}]*\}/)?.[0] ?? "";
    expect(disabled).toMatch(/readings\.length === 0/);
    expect(disabled).toMatch(/roomsQ\.isLoading/);
  });

  it("is given the job number and address by the job page", () => {
    const mount = JOB_PAGE.match(/<JobDryingLog\b[^>]*?\/>/)?.[0] ?? "";
    expect(mount).toMatch(/jobId=\{job\.id\}/);
    expect(mount).toMatch(/jobNumber=\{job\.job_number\}/);
    expect(mount).toMatch(/address=\{\[job\.address,/);
  });
});
