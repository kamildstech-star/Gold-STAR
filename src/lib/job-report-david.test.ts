import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { REPORT_SECTION_KEYS } from "@/lib/job-report-sections";
import { reportFileName, suggestedReportName } from "@/lib/job-reports";

/**
 * David Stern's 17 Sep walkthrough, on the generated report.
 *
 * Two complaints, both live on the call. He picked four photographs, downloaded
 * the PDF, and found none of them in it — while the text told him "there are
 * eight total in the system", which he called irrelevant and wrong to surface.
 * And on the writing: "I wanted it to look good and professional and not that
 * it's being pulled from somewhere else. 'The field form recorded' — I don't
 * want to reference stuff like that... I want it to look like somebody actually
 * went and wrote a report using that information."
 *
 * The PDF cannot be rendered here — pdf-lib needs a DOM and the photographs
 * need storage — so the builder is asserted at source level per the house
 * rules, each assertion pulling out the fragment it is about.
 */
const BUILDER = readFileSync("src/lib/job-reports.ts", "utf8").replace(/\r\n/g, "\n");
const PROMPT = readFileSync("src/lib/job-reports.functions.ts", "utf8").replace(/\r\n/g, "\n");
const SECTIONS = readFileSync("src/lib/job-report-sections.ts", "utf8").replace(/\r\n/g, "\n");

/** Comments explain the fix and quote the old wording; assert on code only. */
const codeOnly = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the photographs are in the PDF", () => {
  it("embeds the chosen pictures rather than describing them", () => {
    // It used to print "4 photographs selected by hand for this report" and
    // stop. A sentence about pictures is not pictures.
    const block = BUILDER.slice(BUILDER.indexOf("const photoIds = reportPhotoIds(report);"));
    expect(block).toContain("prepareReportPhotos(pdf, report.job_id, photoIds)");
    expect(block).toContain("target.drawImage(it.image");
    expect(codeOnly(block)).not.toContain("selected by hand for this report");
  });

  it("lays them out with the invoice's own grid, not a second one", () => {
    expect(BUILDER).toContain("layoutPhotoGrid({");
    expect(BUILDER).toContain('from "@/lib/invoice-photo-grid"');
    expect(BUILDER).toContain('from "@/lib/invoice-photos"');
  });

  it("counts a picture it cannot fetch instead of losing the report", () => {
    const fn = BUILDER.slice(
      BUILDER.indexOf("async function prepareReportPhotos"),
      BUILDER.indexOf("export async function buildReportPdf"),
    );
    expect(fn).toContain("missing += 1");
    expect(fn).toContain("} catch {");
  });

  it("says on the page when one could not be included", () => {
    expect(BUILDER).toContain("could not be included.");
  });
});

describe("the report never cites what exists elsewhere", () => {
  it("has no photo-count section left to tick", () => {
    // "There are eight total in the system" for a selection of four.
    expect(REPORT_SECTION_KEYS).not.toContain("photoSummary");
    expect(codeOnly(SECTIONS)).not.toContain("Photo counts by room");
  });

  it("no longer computes a Photos total figure", () => {
    expect(codeOnly(BUILDER)).not.toContain('label: "Photos"');
  });

  it("still tells the writer not to count the attached pictures", () => {
    // Attaching them and counting them were always two different requests.
    expect(SECTIONS).toContain("Do not count them, describe them, or state how many exist");
  });
});

describe("the report reads like a person wrote it", () => {
  it("has dropped the phrase David named", () => {
    expect(codeOnly(BUILDER)).not.toContain("Underlying figures");
    expect(codeOnly(BUILDER)).toContain('line("Summary", 11, bold, navy)');
  });

  it("no longer prints where each number came from", () => {
    // Every figure used to carry its own origin: "Crew hours: 16 (time_entries.minutes)".
    const block = BUILDER.slice(BUILDER.indexOf("const figures = figuresForSections"));
    expect(block).toContain("line(`${f.label}: ${f.value}`, 8, font, grey)");
    expect(block).not.toContain("(${f.source})");
  });

  it("stops instructing the writer to name its sources", () => {
    /*
     * This was the root of "the field form recorded": the prompt told it to.
     * "crew.source_note says where those hours came from — the daily field
     * forms, the time clock, or both. Name that source the first time you
     * quote an hours figure."
     */
    expect(PROMPT).not.toContain("Name that source the first time you quote an hours figure");
    expect(PROMPT).toContain("NEVER NAME WHERE ANY FIGURE CAME FROM");
  });

  it("names the vocabulary that is banned, so it is not left to taste", () => {
    const rule = PROMPT.slice(PROMPT.indexOf("NEVER NAME WHERE ANY FIGURE CAME FROM"));
    for (const word of ["field forms", "time clock", "records", "systems", "according to"]) {
      expect(rule.slice(0, 700), `the rule does not ban "${word}"`).toContain(word);
    }
  });

  it("describes an absence as a fact about the property, not about paperwork", () => {
    expect(PROMPT).toContain("No equipment was placed on this");
    expect(PROMPT).toContain('Do not say it was "not recorded"');
    expect(codeOnly(BUILDER)).not.toContain('"Data not recorded"');
  });
});

describe("the file name is his to type", () => {
  it("suggests a name from the loss, which is what the report is about", () => {
    // David: "we should have a box that we can type in whatever we want...
    // what the file name should be called", naming "Mitigation Report" off the
    // job type as the example.
    expect(suggestedReportName("water", "carrier_submission")).toBe("Mitigation Report");
    expect(suggestedReportName("fire", "carrier_submission")).toBe("Fire Damage Report");
    expect(suggestedReportName("mold", "internal_review")).toBe("Mold Remediation Report");
  });

  it("falls back to the report's own kind when the job has no loss type", () => {
    expect(suggestedReportName(null, "carrier_submission")).toBe("Carrier submission Report");
    expect(suggestedReportName("something-new", "internal_review")).toBe(
      "Internal job review Report",
    );
  });

  it("uses what he typed, and only fixes what a path cannot carry", () => {
    // Tidying his capitalisation or spacing would answer a question he did not
    // ask. Only the illegal characters go.
    expect(reportFileName("Mitigation Report", "x")).toBe("Mitigation Report.pdf");
    expect(reportFileName("Q3/Q4: final", "x")).toBe("Q3-Q4- final.pdf");
    expect(reportFileName("already.pdf", "x")).toBe("already.pdf");
    expect(reportFileName("ALREADY.PDF", "x")).toBe("ALREADY.PDF");
  });

  it("falls back rather than saving a file called nothing", () => {
    expect(reportFileName("", "Mitigation Report")).toBe("Mitigation Report.pdf");
    expect(reportFileName("   ", "Mitigation Report")).toBe("Mitigation Report.pdf");
  });

  it("is the name both the download and the attachment use", () => {
    const panel = readFileSync("src/components/job-report-panel.tsx", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(panel).toContain("downloadReportPdf(bytes, reportFileName(fileName, suggestedName))");
    expect(panel).toContain("documentName: fileName.trim() || suggestedName");
  });
});
