import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, 2026-10-06: "there needs to be a way to run a report that can make
 * something like this for each job." What the report says is pinned in
 * src/lib/drying-report.test.ts and drying-report-pdf.test.ts; this pins that
 * the Drying log tab hands it the rows it already loaded, and that the file
 * leaves through the same gate as the workbook beside it. Fragments are
 * extracted before asserting, so a comment can neither satisfy nor break one.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const LOG = read("src/components/job-drying-log.tsx");
const BUTTON = read("src/components/drying-report-button.tsx");

const mount = LOG.match(/<DryingReportButton\b[\s\S]*?\/>/)?.[0] ?? "";

describe("the Drying report button on the Drying log tab", () => {
  it("is drawn, and imported from its own file", () => {
    expect(mount).not.toBe("");
    expect(LOG).toMatch(
      /import \{ DryingReportButton \} from "@\/components\/drying-report-button";/,
    );
  });

  it("is given the rows the tab already loaded — no second read of the readings", () => {
    expect(mount).toMatch(/readings=\{readings\}/);
    expect(mount).toMatch(/rooms=\{rooms\}/);
    expect(mount).toMatch(/placements=\{placementsQ\.data\?\.rows \?\? \[\]\}/);
    expect(mount).toMatch(/moisture=\{moistureQ\.data \?\? null\}/);
    expect(mount).toMatch(/jobNumber=\{jobNumber\}/);
    expect(mount).toMatch(/address=\{address\}/);
    expect(BUTTON.match(/\.from\("job_drying_readings"\)/)).toBeNull();
  });

  it("waits for everything it draws, and for something to report", () => {
    const disabled = mount.match(/disabled=\{[\s\S]*?\}\n/)?.[0] ?? "";
    expect(disabled).toMatch(/readings\.length === 0/);
    expect(disabled).toMatch(/roomsQ\.isLoading/);
    expect(disabled).toMatch(/placementsQ\.isLoading/);
    expect(disabled).toMatch(/moistureQ\.isLoading/);
  });
});

describe("where the report goes", () => {
  it("downloads only through the export gate, logged as a pdf", () => {
    const download = BUTTON.match(/async function download\(\) \{[\s\S]*?\n  \}\n/)?.[0] ?? "";
    expect(download).toMatch(/gate\.runExport\(\{/);
    expect(download).toMatch(/format: "pdf"/);
    expect(download).toMatch(/download: \(\) => downloadPdf\(built\.bytes, built\.filename\)/);
    // The Download button is not even drawn for someone the gate refuses.
    expect(BUTTON).toMatch(
      /\{gate\.allowed && \(\s*<Button[^>]*onClick=\{\(\) => void download\(\)\}/,
    );
  });

  it("files into the job's documents as a report", () => {
    const save = BUTTON.match(/async function save\(\) \{[\s\S]*?\n  \}\n/)?.[0] ?? "";
    expect(save).toMatch(/uploadDocumentFile\(\{/);
    expect(save).toMatch(/docType: "job_report"/);
    expect(save).toMatch(
      /scope: \{ locationId: facts\.location_id, jobId, accountId: facts\.account_id \}/,
    );
    expect(save).toMatch(/invalidateQueries\(\{ queryKey: \["job-documents", jobId\] \}\)/);
  });

  it("is refused while writes are off", () => {
    const saveButton =
      BUTTON.match(/<Button[^>]*onClick=\{\(\) => void save\(\)\}[\s\S]*?>/)?.[0] ?? "";
    expect(saveButton).toMatch(/app\.writesDisabled/);
  });

  it("is built from the shared data assembly, with the clock read once at click time", () => {
    const build = BUTTON.match(/async function build\(\) \{[\s\S]*?\n  \}\n/)?.[0] ?? "";
    expect(build).toMatch(/const generatedAt = new Date\(\);/);
    expect(build).toMatch(/now = todayLocal\(generatedAt\)/);
    expect(build).toMatch(/const today = cut\.today;/);
    expect(build).toMatch(/buildDryingReportData\(\{/);
    expect(build).toMatch(/buildDryingReportPdf\(\{/);
  });
});
