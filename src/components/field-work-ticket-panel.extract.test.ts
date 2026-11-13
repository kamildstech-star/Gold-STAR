/**
 * The wiring between the upload dialog, the reader and the review step.
 *
 * There is no DOM testing library in this repo, so the panel is read as
 * source and the specific fragments are pulled out with a regex. The things
 * being held to account here are the ones that would quietly undo the point
 * of the feature: a read that saves without a person, a review that loses
 * the photo, or a failure that leaves a crew with nowhere to file a ticket.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  join(process.cwd(), "src/components/field-work-ticket-panel.tsx"),
  "utf8",
).replace(/\r\n/g, "\n");

/** The body of a named arrow function in the panel, braces balanced. */
function fn(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = async (`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  let depth = 0;
  let i = SOURCE.indexOf("{", start);
  const from = i;
  for (; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "{") depth += 1;
    else if (SOURCE[i] === "}") {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(from, i + 1);
    }
  }
  throw new Error(`${name} never closes`);
}

describe("reading the photographed sheet", () => {
  const readScan = fn("readScan");

  it("goes through the one reader, not its own gateway call", () => {
    expect(readScan).toContain("await readPaperTicket(sheet,");
    expect(readScan).toContain("const sheet = picked ?? scanFile;");
    expect(SOURCE).not.toContain("ai.gateway.lovable.dev");
  });

  it("hands the reader the job's own address and an explicit date", () => {
    expect(readScan).toContain("jobAddress,");
    expect(readScan).toContain('unitNumber: unitNumber ?? "",');
    expect(readScan).toContain("today: new Date().toISOString().slice(0, 10),");
  });

  it("writes nothing — it opens the form for a person", () => {
    expect(readScan).not.toMatch(/writeFieldWorkTicket|enqueue\(|supabase/);
    expect(readScan).toContain("setFormOpen(true)");
    expect(readScan).toContain("setDraft({ ...read.values, tags: [] })");
  });

  it("keeps the sheet so the save can file it as a document", () => {
    expect(readScan).toContain("setReviewFile(sheet)");
  });

  it("shows a failure in the dialog instead of closing it", () => {
    const failure = readScan.match(/if \(!read\.ok\) \{[\s\S]*?\n\s*\}/)![0];
    expect(failure).toContain("setReadError({ message: read.error, retryable: read.retryable })");
    expect(failure).toContain("return;");
    expect(failure).not.toContain("setFormOpen");
  });
});

describe("the review step", () => {
  it("is the ordinary ticket form, so every field is editable", () => {
    // The read fills `draft`, which is what the full form is bound to. If
    // this ever became its own read-only summary, this would stop matching.
    expect(SOURCE).toContain("<ReviewBanner read={reviewRead} bi={bi} />");
    expect(fn("readScan")).toContain("setDraft(");
  });

  it("tells the crew nothing is saved until they say so", () => {
    const banner = SOURCE.match(/function ReviewBanner\(\{[\s\S]*?\n\}\n/)![0];
    expect(banner).toContain("check every line before you save");
    expect(banner).toContain("Nothing is saved until you press Save.");
    expect(banner).toContain("uncertainLabels(read.uncertain)");
  });

  it("flags the fields the reader was unsure of, by their printed label", () => {
    for (const key of [
      "job_address",
      "work_date",
      "crew_chief_name",
      "gsr_crew_size",
      "temp_crew_size",
      "job_start_time",
      "job_end_time",
      "scope_completed",
      "materials_used",
      "job_types",
      "trash_disposition",
      "work_notes",
    ]) {
      expect(SOURCE).toContain(`flagged.has("${key}")`);
    }
    // Equipment is flagged per machine, by the column name.
    expect(SOURCE).toContain("flag={flagged.has(`equip_${o.key}`)}");
  });

  it("abandons the review when the form is closed, so the next ticket is clean", () => {
    expect(SOURCE).toContain("if (!open) clearReview();");
    const clear = SOURCE.match(/const clearReview = \(\) => \{[\s\S]*?\n {2}\};/)![0];
    expect(clear).toContain("setReviewFile(null)");
    expect(clear).toContain("setReviewRead(null)");
  });
});

describe("saving a reviewed paper ticket", () => {
  const submit = fn("submit");

  it("files the photo on the job, as the old dialog did", () => {
    expect(submit).toContain("if (reviewFile) {");
    expect(submit).toContain("uploadDocumentFile({");
    expect(submit).toContain("file: reviewFile,");
  });

  it("saves the ticket even when the photo could not be filed, and says so", () => {
    expect(submit).toContain("photoLost = true");
    expect(submit).toContain("The ticket saved, but the photo did not file.");
    // The failed upload must not abort the save.
    expect(submit).not.toMatch(/photoLost = true;[\s\S]{0,80}return;/);
  });

  it("marks a ticket that came off paper as scanned, with its document", () => {
    const buildRow = SOURCE.match(/source: reviewFile \? "scanned" : "digital",\n[^\n]*/)![0];
    expect(buildRow).toContain("documentId ? { document_id: documentId } : {}");
  });
});

describe("the manual fallback still exists", () => {
  it("keeps the three-field filing underneath the reader", () => {
    expect(SOURCE).toContain("const submitScan = async ()");
    expect(SOURCE).toContain("File paper ticket");
    expect(SOURCE).toContain('source: "scanned"');
  });

  it("still takes an image or a PDF", () => {
    expect(SOURCE).toContain('accept="image/*,application/pdf"');
  });

  it("points a failed read at both ways out", () => {
    const error = SOURCE.match(/\{readError && \([\s\S]*?\n {12}\)\}/)![0];
    expect(error).toContain("You can still file it below");
    expect(error).toContain("New ticket");
  });
});

/*
 * 6 Oct: "the reading the paper isn't working to fill out all the forms."
 * The read sat on its own button above the old three-field filing, whose
 * footer button was the obvious next press after choosing a photo.
 */
describe("the read is on the path people take", () => {
  it("starts as soon as a photo is picked", () => {
    const pick = SOURCE.match(/const pickScan = \(file: File\) => \{[\s\S]*?\n {2}\};/)![0];
    expect(pick).toContain("setScanFile(file)");
    expect(pick).toContain("void readScan(file)");
  });

  it("both pickers, camera and file, go through that one handler", () => {
    const picks = SOURCE.match(/<FilePick[\s\S]*?\/>/g)!;
    expect(picks.length).toBeGreaterThanOrEqual(2);
    for (const p of picks) expect(p).toContain("onPick={pickScan}");
  });

  it("drops the answer to a photo since replaced, or a dialog since closed", () => {
    const readScan = fn("readScan");
    expect(readScan).toContain("const seq = ++readSeq.current;");
    expect(readScan).toMatch(/if \(seq !== readSeq\.current\) return;[\s\S]*setFormOpen\(true\)/);
    const dialog = SOURCE.match(/<Dialog\s+open=\{scanOpen\}[\s\S]*?\n {6}>/)![0];
    expect(dialog).toContain("readSeq.current += 1;");
  });

  it("shows the failure loudly, with its code, and offers a retry only when one could work", () => {
    const error = SOURCE.match(/\{readError && \([\s\S]*?\n {12}\)\}/)![0];
    expect(error).toContain('role="alert"');
    expect(error).toContain("The ticket was not read.");
    expect(error).toContain("{readError.message}");
    expect(error).toMatch(/\{readError\.retryable && scanFile && \(/);
    expect(error).toContain("Try again");
  });
});
