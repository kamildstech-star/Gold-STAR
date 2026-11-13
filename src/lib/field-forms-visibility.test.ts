import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fieldFormsFor, isTmJob } from "@/lib/field-forms-visibility";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("what the Field Form tab offers, by job type", () => {
  it("T&M gets the three daily sheets and the full ticket, Upload paper included (11 Nov)", () => {
    expect(fieldFormsFor("t_m")).toEqual({ tmForms: true, ticket: "full" });
    expect(isTmJob("t_m")).toBe(true);
  });

  it.each(["insurance", "cash"])("%s gets the field work ticket, as today", (t) => {
    expect(fieldFormsFor(t)).toEqual({ tmForms: false, ticket: "full" });
  });

  it.each([null, undefined, "", "undetermined", "reconstruction"])(
    "%s keeps the ticket, so nothing disappears from unclassified jobs",
    (t) => {
      expect(fieldFormsFor(t)).toEqual({ tmForms: false, ticket: "full" });
      expect(isTmJob(t)).toBe(false);
    },
  );
});

describe("wiring", () => {
  const PAGE = read("src/routes/_authenticated/jobs.$id.tsx");
  const TICKET = read("src/components/field-work-ticket-panel.tsx");

  it("the job's Field Form tab decides by job_type through fieldFormsFor", () => {
    expect(PAGE).toMatch(/const fieldForms = fieldFormsFor\(job\?\.job_type\);/);
    const tab = PAGE.match(/<TabsContent value="ticket"[^]*?<\/TabsContent>/)![0];
    expect(tab).toMatch(/<TmFieldFormsPanel/);
    expect(tab).toMatch(/readOnly=\{fieldForms\.ticket === "history"\}/);
    // FE10: every job gets the panel; the job type picks the list — the three
    // T&M sheets with the detailed rate sheet, or the condensed supply list.
    expect(tab).toMatch(/supplyList=\{supplyListKind\(job\.job_type\)\}/);
  });

  it("a read-only ticket panel offers neither New ticket nor Upload paper", () => {
    const header = TICKET.match(/<CardHeader[^]*?<\/CardHeader>/)![0];
    expect(header).toMatch(/\{!readOnly && \(/);
    const guarded = header.slice(header.indexOf("{!readOnly && ("));
    expect(guarded).toContain("New ticket");
    expect(guarded).toContain("Upload paper");
  });

  it("a read-only ticket panel with no tickets renders nothing", () => {
    const guard = TICKET.match(/if \(readOnly && [^\n]*?\) return null;/);
    expect(guard).not.toBeNull();
    expect(guard![0]).toContain("!available");
    expect(guard![0]).toContain("rows.length === 0");
  });
});
