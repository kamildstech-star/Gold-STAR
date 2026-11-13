import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  equipmentLeftSentence,
  fieldFormEquipment,
  ticketEquipmentLeft,
  ticketStatusPhrase,
} from "@/lib/job-report-field-forms";
import { REPORT_SECTION_DEFS, REPORT_SECTION_GROUPS } from "@/lib/job-report-sections";

/**
 * David's 16 Sep walkthrough of the generated report.
 *
 * Three of his complaints were the same fault wearing different clothes: the
 * snapshot is the only thing the report model may state, so anything the
 * snapshot does not carry cannot appear however the prompt is worded — and
 * anything the snapshot words badly is repeated verbatim.
 */

/* ------------------------------------------ 2. equipment left on the job */

const FORM = {
  work_date: "2026-09-16",
  equip_dehumidifier: 1,
  equip_air_mover: 3,
};

describe("equipment written on a field form reaches the report", () => {
  it("reads the machines off the form", () => {
    expect(ticketEquipmentLeft(FORM)).toEqual([
      { item: "dehumidifier", count: 1 },
      { item: "air movers", count: 3 },
    ]);
  });

  it("says it the way a report would", () => {
    expect(equipmentLeftSentence(ticketEquipmentLeft(FORM))).toBe(
      "1 dehumidifier and 3 air movers",
    );
    expect(equipmentLeftSentence([{ item: "generators", count: 2 }])).toBe("2 generators");
    expect(equipmentLeftSentence([])).toBeNull();
  });

  it("ignores a form that recorded no equipment at all", () => {
    expect(ticketEquipmentLeft({ work_date: "2026-09-15" })).toEqual([]);
    expect(ticketEquipmentLeft({ equip_air_mover: 0 })).toEqual([]);
    // A negative or nonsense count is not equipment either.
    expect(ticketEquipmentLeft({ equip_air_mover: -2 })).toEqual([]);
  });

  it("counts the most on site at once, never the sum of every mention", () => {
    /*
     * The same dehumidifier recorded on Monday and again on Tuesday is one
     * machine standing for two days. Adding them would report equipment that
     * never existed — the trap the running-cost engine avoids by charging a
     * placement per day rather than per mention.
     */
    const summary = fieldFormEquipment([
      { work_date: "2026-09-16", equip_dehumidifier: 1, equip_air_mover: 3 },
      { work_date: "2026-09-15", equip_dehumidifier: 1, equip_air_mover: 2 },
    ]);
    expect(summary.peak).toEqual([
      { item: "dehumidifier", count: 1 },
      { item: "air movers", count: 3 },
    ]);
    expect(summary.forms_with_equipment).toBe(2);
  });

  it("names the latest form that recorded any", () => {
    const summary = fieldFormEquipment([
      { work_date: "2026-09-16" },
      { work_date: "2026-09-15", equip_air_mover: 2 },
    ]);
    expect(summary.latest?.work_date).toBe("2026-09-15");
    expect(summary.latest?.sentence).toBe("2 air movers");
  });

  it("is actually selected, and unlocked for the equipment section", () => {
    // Normalised to LF: git checks this repo out with CRLF on Windows, so a
    // pattern spanning a line break passes where it was written and fails
    // on main. See .claude/AGENT-BRIEF.md.
    const server = readFileSync("src/lib/job-reports.server.ts", "utf8").replace(/\r\n/g, "\n");
    // The columns were never asked for, which is why nothing could report them.
    expect(server).toContain("equip_dehumidifier");
    expect(server).toContain("equipment_from_field_forms");
    // `notes` on a placement is the other half: "full left on site" is written
    // against the machine, and that column was not selected either.
    expect(server).toMatch(/expected_retrieval_date, notes, equipment:equipment_id/);

    // narrowSnapshot strips any key a section does not name, so declaring the
    // key is what lets the model see it.
    const equipment = REPORT_SECTION_DEFS.find((d) => d.key === "equipment");
    expect(equipment?.snapshotKeys).toContain("equipment_from_field_forms");
  });
});

/* --------------------------------- 3. an unfinished job is not a failure */

describe("an unticked 'completed' reads as work still pending", () => {
  it("never says the work was not completed", () => {
    const phrase = ticketStatusPhrase(false, true);
    expect(phrase).toBe("Additional work is still pending on the job.");
    expect(phrase).not.toMatch(/not completed|incomplete|false/i);
  });

  it("treats a form that ticked neither box as still in progress", () => {
    const phrase = ticketStatusPhrase(false, false);
    expect(phrase).toBe("Work on this job is still in progress.");
    expect(phrase).not.toMatch(/not |false|never/i);
  });

  it("still says plainly when the visit is finished", () => {
    expect(ticketStatusPhrase(true, false)).toBe("Work on this visit is complete.");
    expect(ticketStatusPhrase(true, true)).toMatch(/complete.*still outstanding/i);
  });

  it("treats a missing flag as unfinished rather than as a finding", () => {
    expect(ticketStatusPhrase(null, null)).toBe("Work on this job is still in progress.");
    expect(ticketStatusPhrase(undefined, undefined)).not.toMatch(/not recorded/i);
  });

  it("puts that phrase in the snapshot, where the model can quote it", () => {
    const server = readFileSync("src/lib/job-reports.server.ts", "utf8").replace(/\r\n/g, "\n");
    expect(server).toContain("status: ticketStatusPhrase(");
  });

  it("forbids the model inventing absences of its own", () => {
    const prompt = readFileSync("src/lib/job-reports.functions.ts", "utf8").replace(/\r\n/g, "\n");
    expect(prompt).toContain('The "missing" array is the ONLY list of absences to report');
    expect(prompt).toMatch(/never write that something is "false"/i);
    expect(prompt).toMatch(/still pending/);
  });
});

/* --------------------------------------------------- 1. the six data gaps */

describe("a gap is only reported when the data is genuinely absent", () => {
  const server = readFileSync("src/lib/job-reports.server.ts", "utf8").replace(/\r\n/g, "\n");

  it("accepts scope written on a daily form, not just on the job", () => {
    expect(server).toContain("const formScope");
    expect(server).toMatch(/!job\.scope && !formScope/);
  });

  it("accepts equipment noted on a form as equipment", () => {
    expect(server).toMatch(/placements\.data \?\? \[\]\)\.length === 0 && !formEquipment/);
  });

  it("accepts a Job Calculator sheet as an estimate", () => {
    // `quotes` alone reported a priced job as unpriced, because the calculator
    // writes its own table and can price a job with no carrier quote at all.
    expect(server).toContain('.from("job_calculations")');
    expect(server).toMatch(/quotes\.data \?\? \[\]\)\.length === 0 && calculationCount === 0/);
  });

  it("accepts a photo report document as photographic evidence", () => {
    expect(server).toContain("photoReportDocs");
    expect(server).toMatch(/photoCount === 0 && photoReportDocs === 0/);
  });

  it("does not call an unfinished job's missing invoice a gap", () => {
    /*
     * A job still running has not FAILED to be invoiced; it is not there yet.
     * Reporting it as an absence is what made a healthy live job look neglected.
     */
    expect(server).toContain("const jobIsFinished");
    expect(server).toMatch(/jobIsFinished && invoiceRows\.length === 0/);
  });

  it("does not call an unfinished job's missing completion date a gap", () => {
    expect(server).toMatch(/jobIsFinished && !job\.completion_date/);
  });

  it("still reports the things that are genuinely absent", () => {
    // The point is not to silence the section — a real gap must still be said.
    // Worded as facts about the job, not about paperwork: "recorded" is the
    // figure-quoting voice David objected to on 22 Sep (report-voice.test).
    expect(server).toContain('missing.push("No date of loss on the job.")');
    expect(server).toContain('missing.push("No status changes on this job yet.")');
    expect(server).toContain('"No crew hours on this job yet."');
  });
});

/* ------------------------------------------------ 4. a panel worth reading */

describe("the report picker is four columns, not one long scroll", () => {
  it("gives every section a column", () => {
    for (const def of REPORT_SECTION_DEFS) {
      expect(REPORT_SECTION_GROUPS, `${def.key} has no group`).toContain(def.group);
    }
  });

  it("uses all four columns, so none is a dumping ground", () => {
    const used = new Set(REPORT_SECTION_DEFS.map((d) => d.group));
    expect(used.size).toBe(REPORT_SECTION_GROUPS.length);
  });

  it("keeps every section on offer — this was a layout change, not a cull", () => {
    const panel = readFileSync("src/components/job-report-panel.tsx", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(panel).toContain("REPORT_SECTION_GROUPS.map");
    expect(panel).toContain("xl:grid-cols-4");
    // Still driven by the catalogue, so a new section cannot be forgotten.
    expect(panel).toContain("defs.filter((d) => d.group === group)");
  });
});

/* --------------------------------------- 5 & 6: documents and running costs */

describe("the documents screen is two columns with folder icons", () => {
  const page = readFileSync("src/routes/_authenticated/documents.index.tsx", "utf8").replace(
    /\r\n/g,
    "\n",
  );

  it("splits reports from the rest of the paperwork", () => {
    expect(page).toContain("shownReports");
    expect(page).toContain("shownOther");
    expect(page).toContain("xl:grid-cols-2");
  });

  it("draws folders as icons rather than a column of text", () => {
    expect(page).toContain('variant="tiles"');
    const rail = readFileSync("src/components/document-folder-rail.tsx", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(rail).toContain("FolderTile");
    // The tile keeps everything the row had: drop target, counts, actions.
    expect(rail).toMatch(/variant === "tiles"/);
    expect(rail).toContain("New subfolder");
  });
});

describe("the labor box reads as running costs and shows what is accepted", () => {
  const panel = readFileSync("src/components/job-labour-panel.tsx", "utf8").replace(/\r\n/g, "\n");

  it("is named as the labor leg of running costs", () => {
    expect(panel).toContain("Running costs · labor");
    expect(panel).not.toContain("Labor & profitability");
  });

  it("is smaller — three headline figures instead of six", () => {
    expect(panel).toContain('<div className="grid grid-cols-3 gap-px');
    expect(panel).not.toContain("sm:grid-cols-6");
  });

  it("says how many hours are still waiting to be accepted", () => {
    expect(panel).toContain("still to accept");
    expect(panel).toContain("have not been\n            accepted yet");
  });
});
