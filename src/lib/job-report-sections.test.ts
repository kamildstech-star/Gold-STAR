import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { reportSectionsForAudience, INTERNAL_ONLY_REPORT_SECTIONS } from "@/lib/document-audience";
import {
  EMPTY_REPORT_SECTIONS,
  REPORT_SECTION_DEFS,
  REPORT_SECTION_KEYS,
  chosenSections,
  emptyReportReason,
  emptySections,
  isEmptyReport,
  lastUsedSections,
  narrowSnapshot,
  normalizeSections,
  sectionBrief,
  type ReportSectionKey,
  type ReportSections,
} from "@/lib/job-report-sections";
import { figuresForSections, snapshotFigures } from "@/lib/job-reports";

/**
 * David, 2026, reading a generated job report on a recorded call:
 *
 *   "That's pulling random information... I don't need all this information in
 *   here... we should have a report section here that's blank. And you
 *   manually have to choose what updates you want to put in, meaning the
 *   updates from today's field form, the updates, today's updated pictures...
 *   instead of just giving me this all this jibber... amount of photos, you
 *   know, here's the photos attached... Invoices, this, I don't have to share
 *   with them like what's going on here... It's talking too much irrelevant
 *   stuff."
 *
 * This document goes to a homeowner or an adjuster. So the interesting
 * property is not that the office CAN untick the invoice block — it is that
 * the invoice block was never on. Everything below is a way of asking the same
 * question: can anything reach the paper that nobody ticked?
 */

/** A snapshot with something in every key `gatherJobSnapshot` produces. */
const FULL_SNAPSHOT: Record<string, unknown> = {
  generated_at: "2026-09-10T12:00:00.000Z",
  job: { job_number: "GS-2026-09006", address: "12 Maple Avenue" },
  timeline: { cycle_time_days: 9 },
  crew: { source: "field_form", total_hours: 7.3, crew_days: 4, distinct_people: 3 },
  equipment: [{ asset_tag: "AM-1" }, { asset_tag: "DH-2" }],
  // The same machines as the crew wrote them on the daily sheet — the only
  // record on a job whose equipment was never asset-tagged.
  equipment_from_field_forms: {
    peak: [{ item: "air movers", count: 3 }],
    peak_sentence: "3 air movers",
    latest: null,
    forms_with_equipment: 1,
  },
  field_forms: [{ work_date: "2026-09-01", scope_completed: ["extraction"] }],
  drying: { points_total: 2, points_at_goal: 1, crew_reading_days: 3, moisture_points: [] },
  photos: { total: 14, by_folder: [{ name: "Kitchen", photos: 14 }] },
  notes: [{ body: "Homeowner called" }],
  documents: [{ name: "COS", status: "signed" }],
  money: { estimated: 4000, billed: 811.04, collected: 0 },
  invoices: [{ invoice_number: "INV-1", billed_amount: 811.04 }],
  payments: [{ amount: 100 }],
  estimates: [{ version: 1, total: 4000 }],
  calculator_estimates: [{ job_date: "2026-09-01", customer_price: 1850 }],
  missing: ["No completion date recorded."],
};

const allOn = (): ReportSections =>
  Object.fromEntries(REPORT_SECTION_KEYS.map((k) => [k, true])) as ReportSections;

const only = (...keys: ReportSectionKey[]): ReportSections => {
  const s = emptySections();
  for (const k of keys) s[k] = true;
  return s;
};

/* ------------------------------------------------------------------ */
/* The blank start                                                     */
/* ------------------------------------------------------------------ */

describe("a report starts blank", () => {
  it("has every section off by default", () => {
    expect(chosenSections(EMPTY_REPORT_SECTIONS)).toEqual([]);
    for (const key of REPORT_SECTION_KEYS) {
      expect(EMPTY_REPORT_SECTIONS[key], key).toBe(false);
    }
  });

  it("covers every section in the catalog, so a new one cannot arrive switched on", () => {
    // `EMPTY_REPORT_SECTIONS` is built from the defs rather than written out.
    // Adding a section to the catalogue therefore adds it here, off.
    expect(Object.keys(EMPTY_REPORT_SECTIONS).sort()).toEqual([...REPORT_SECTION_KEYS].sort());
    expect(REPORT_SECTION_DEFS.length).toBe(REPORT_SECTION_KEYS.length);
  });

  it("cannot be mutated by a caller that forgot to copy it", () => {
    expect(() => {
      (EMPTY_REPORT_SECTIONS as ReportSections).invoices = true;
    }).toThrow();
    expect(EMPTY_REPORT_SECTIONS.invoices).toBe(false);
  });

  it("hands out an independent copy", () => {
    const a = emptySections();
    a.photos = true;
    expect(emptySections().photos).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Nothing internal by default — the rule this feature exists for       */
/* ------------------------------------------------------------------ */

describe("nothing internal can be included by default", () => {
  it("leaves every internal-only section off", () => {
    for (const key of INTERNAL_ONLY_REPORT_SECTIONS) {
      expect(EMPTY_REPORT_SECTIONS[key], key).toBe(false);
    }
    // "Invoices, this, I don't have to share with them like what's going on
    // here." Named explicitly so a rename cannot quietly drop the rule.
    expect(INTERNAL_ONLY_REPORT_SECTIONS).toContain("invoices");
  });

  it("marks every internal-only section as a money option, so a rep never sees the toggle", () => {
    for (const key of INTERNAL_ONLY_REPORT_SECTIONS) {
      const def = REPORT_SECTION_DEFS.find((d) => d.key === key);
      expect(def?.finance, key).toBe(true);
    }
  });

  it("shows the model nothing at all on a blank selection", () => {
    const narrowed = narrowSnapshot(FULL_SNAPSHOT, EMPTY_REPORT_SECTIONS);
    // Only the job's own identity survives. Every figure the client objected
    // to is not withheld from the model — it is absent from the prompt.
    expect(Object.keys(narrowed).sort()).toEqual(["generated_at", "job"]);
    for (const leak of ["money", "invoices", "payments", "estimates", "photos", "missing"]) {
      expect(narrowed, leak).not.toHaveProperty(leak);
    }
  });

  it("prints no figures at all on a blank selection", () => {
    expect(figuresForSections(FULL_SNAPSHOT, EMPTY_REPORT_SECTIONS)).toEqual([]);
  });

  it("strips the cost sections from a customer copy even when they were ticked", () => {
    const safe = reportSectionsForAudience(allOn(), "customer");
    for (const key of INTERNAL_ONLY_REPORT_SECTIONS) expect(safe[key], key).toBe(false);
    // Everything else the sender chose is untouched: the rule narrows, never
    // second-guesses.
    expect(safe.fieldForm).toBe(true);
    expect(safe.photos).toBe(true);
  });

  it("leaves an internal copy exactly as chosen", () => {
    const chosen = allOn();
    expect(reportSectionsForAudience(chosen, "internal")).toEqual(chosen);
  });
});

/* ------------------------------------------------------------------ */
/* Reading a stored selection back                                     */
/* ------------------------------------------------------------------ */

describe("normalizeSections", () => {
  it("reads a stored object back", () => {
    const s = normalizeSections({ fieldForm: true, photos: true });
    expect(chosenSections(s)).toEqual(["fieldForm", "photos"]);
  });

  it("treats anything that is not exactly true as off", () => {
    // jsonb round-trips can carry 1, "true", or "yes" from an older writer.
    // A report is not a place to guess what somebody meant.
    const s = normalizeSections({ money: 1, invoices: "true", gaps: "yes", notes: null });
    expect(chosenSections(s)).toEqual([]);
  });

  it("drops keys it does not recognize", () => {
    const s = normalizeSections({ fieldForm: true, everything: true, "*": true });
    expect(Object.keys(s).sort()).toEqual([...REPORT_SECTION_KEYS].sort());
    expect(chosenSections(s)).toEqual(["fieldForm"]);
  });

  it("reads null, an array and a string as nothing chosen", () => {
    for (const value of [null, undefined, [], "fieldForm", 7]) {
      expect(chosenSections(normalizeSections(value))).toEqual([]);
    }
  });
});

describe("lastUsedSections — the job remembers what was ticked last time", () => {
  it("takes the newest report that recorded a selection", () => {
    const s = lastUsedSections([
      { sections: { fieldForm: true, photos: true } },
      { sections: { gaps: true } },
    ]);
    expect(chosenSections(s)).toEqual(["fieldForm", "photos"]);
  });

  it("skips reports made before selections were recorded", () => {
    const s = lastUsedSections([{ sections: null }, {}, { sections: { timeline: true } }]);
    expect(chosenSections(s)).toEqual(["timeline"]);
  });

  it("falls back to the blank start on a job with no history", () => {
    expect(chosenSections(lastUsedSections([]))).toEqual([]);
    expect(chosenSections(lastUsedSections([{ sections: null }]))).toEqual([]);
    // A recorded selection of nothing is not a preference worth repeating.
    expect(chosenSections(lastUsedSections([{ sections: {} }]))).toEqual([]);
  });

  it("does not re-tick a money section for a job whose last report had one", () => {
    // The memory is convenience, not authority: the role gate and
    // `reportSectionsForAudience` still run over whatever it hands back.
    const remembered = lastUsedSections([{ sections: { money: true, fieldForm: true } }]);
    expect(chosenSections(reportSectionsForAudience(remembered, "customer"))).toEqual([
      "fieldForm",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* An empty report says so                                             */
/* ------------------------------------------------------------------ */

describe("an empty report refuses rather than producing a blank page", () => {
  it("explains itself when nothing is ticked", () => {
    const why = emptyReportReason(EMPTY_REPORT_SECTIONS);
    expect(why).toMatch(/nothing has been chosen/i);
    expect(isEmptyReport(EMPTY_REPORT_SECTIONS)).toBe(true);
  });

  it("counts photos-with-no-photos as empty, and says which problem it is", () => {
    const why = emptyReportReason(only("photos"), []);
    expect(why).toMatch(/none are selected/i);
    expect(isEmptyReport(only("photos"), ["01J..."])).toBe(false);
  });

  it("is satisfied by one ticked section", () => {
    expect(emptyReportReason(only("fieldForm"))).toBeNull();
    expect(emptyReportReason(only("photos"), ["01J..."])).toBeNull();
  });

  it("ignores photo ids left over from a selection that no longer includes photos", () => {
    // The picker keeps its list while the toggle is off; that stale list must
    // not make a report out of nothing.
    expect(emptyReportReason(EMPTY_REPORT_SECTIONS, ["01J...", "01K..."])).toMatch(
      /nothing has been chosen/i,
    );
  });
});

/* ------------------------------------------------------------------ */
/* What each tick actually unlocks                                     */
/* ------------------------------------------------------------------ */

describe("narrowSnapshot", () => {
  it("keeps the job's identity whatever is chosen", () => {
    const narrowed = narrowSnapshot(FULL_SNAPSHOT, only("fieldForm"));
    expect(narrowed.job).toBeDefined();
    expect(narrowed.generated_at).toBeDefined();
  });

  it("unlocks exactly the keys its section names", () => {
    expect(Object.keys(narrowSnapshot(FULL_SNAPSHOT, only("fieldForm"))).sort()).toEqual([
      "field_forms",
      "generated_at",
      "job",
    ]);
    expect(Object.keys(narrowSnapshot(FULL_SNAPSHOT, only("labour"))).sort()).toEqual([
      "crew",
      "generated_at",
      "job",
    ]);
  });

  it("never carries the photo count, because nothing prints it any more", () => {
    /*
     * Mark drew the line first — "Amount of photos, you know, here's the
     * photos attached... I don't necessarily have to give this type of
     * information" — and the count survived as its own tickable section.
     *
     * David, 17 Sep, met it: a report he had picked four photographs for told
     * him "there are eight total in the system". Irrelevant, and wrong to put
     * in front of an adjuster. The section is gone, so attaching pictures is
     * now the only thing photographs do to a report.
     */
    expect(narrowSnapshot(FULL_SNAPSHOT, only("photos"))).not.toHaveProperty("photos");
    expect(REPORT_SECTION_KEYS).not.toContain("photoSummary");
  });

  it("offers no Amounts section, so a report can never carry amounts", () => {
    // David, 27 Oct: the Amounts toggle is gone; Invoice detail stays.
    expect(REPORT_SECTION_DEFS.map((d) => d.label)).not.toContain("Amounts");
    expect(REPORT_SECTION_DEFS.map((d) => d.label)).toContain("Invoice detail");
    const narrowed = narrowSnapshot(FULL_SNAPSHOT, allOn());
    expect(narrowed).not.toHaveProperty("money");
    expect(narrowed).not.toHaveProperty("estimates");
  });

  it("can only remove — it never invents a key", () => {
    const narrowed = narrowSnapshot({ job: {}, crew: { total_hours: 1 } }, allOn());
    expect(Object.keys(narrowed).sort()).toEqual(["crew", "job"]);
  });

  it("gives every catalog section a home in the snapshot, or says so deliberately", () => {
    // A section whose keys are never present in a snapshot would be a tick
    // that does nothing. `photos` is the one legitimate exception: the
    // pictures are chosen by hand and are not narrated from snapshot data.
    for (const def of REPORT_SECTION_DEFS) {
      if (def.key === "photos") {
        expect(def.snapshotKeys).toEqual([]);
        continue;
      }
      expect(def.snapshotKeys.length, def.key).toBeGreaterThan(0);
      for (const k of def.snapshotKeys) {
        expect(FULL_SNAPSHOT, `${def.key} -> ${k}`).toHaveProperty(k);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* The instruction the model receives                                  */
/* ------------------------------------------------------------------ */

describe("sectionBrief", () => {
  it("names only what was ticked", () => {
    const brief = sectionBrief(only("fieldForm", "timeline"));
    expect(brief).toContain("Field form updates");
    expect(brief).toContain("Dates & timeline");
    expect(brief).not.toContain("Invoice detail");
    expect(brief).not.toContain("Photo counts by room");
  });

  it("forbids the subjects the client listed, by name", () => {
    const brief = sectionBrief(only("fieldForm"));
    expect(brief).toMatch(/nothing else/i);
    expect(brief).toMatch(/do not mention money, invoices, photo counts/i);
  });

  it("tells the model the photos are attached but not to count them", () => {
    const brief = sectionBrief(only("photos"));
    expect(brief).toMatch(/attached photographs/i);
    expect(brief).toMatch(/do not count them/i);
  });
});

/* ------------------------------------------------------------------ */
/* The figures panel and the PDF's figure block                        */
/* ------------------------------------------------------------------ */

describe("figuresForSections", () => {
  it("gives every figure a section it belongs to", () => {
    const keys = new Set<string>(REPORT_SECTION_KEYS);
    for (const f of snapshotFigures(FULL_SNAPSHOT)) {
      expect(keys.has(f.section), `${f.label} -> ${f.section}`).toBe(true);
    }
  });

  it("shows only the ticked blocks", () => {
    const labels = figuresForSections(FULL_SNAPSHOT, only("timeline")).map((f) => f.label);
    expect(labels).toContain("Cycle time (days)");
    expect(labels).not.toContain("Billed");
    expect(labels).not.toContain("Photos");
    expect(labels).not.toContain("Man-hours on site");
  });

  it("never prints a money figure, whatever was ticked", () => {
    const withoutMoney = figuresForSections(FULL_SNAPSHOT, allOn()).map((f) => f.label);
    for (const label of ["Estimated", "Billed", "Approved", "Collected", "Carrier shortfall"]) {
      expect(withoutMoney, label).not.toContain(label);
    }
  });

  it("shows a pre-assembly report everything it was built with", () => {
    // A report generated before this feature has no `sections` recorded.
    // Blanking its figures panel would be rewriting the past, not fixing the
    // next report.
    expect(figuresForSections(FULL_SNAPSHOT, null).length).toBe(
      snapshotFigures(FULL_SNAPSHOT).length,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Wiring — asserted against the source, this repo carries no DOM       */
/* testing library. Precedent: src/components/qty-takes-a-sum.test.ts.  */
/* ------------------------------------------------------------------ */

describe("the panel and the server function are wired to the blank start", () => {
  const panel = readFileSync("src/components/job-report-panel.tsx", "utf8");
  const fn = readFileSync("src/lib/job-reports.functions.ts", "utf8");
  const server = readFileSync("src/lib/job-reports.server.ts", "utf8");

  it("seeds the panel from an empty selection, not from a preset", () => {
    expect(panel).toContain("emptySections()");
    expect(panel).toContain("lastUsedSections");
  });

  it("sends the chosen sections and photos with the request", () => {
    expect(panel).toMatch(/sections\s*[,:]/);
    expect(panel).toContain("photo_ids");
  });

  it("refuses an empty report in the panel and again on the server", () => {
    expect(panel).toContain("emptyReportReason");
    expect(fn).toContain("emptyReportReason");
  });

  it("narrows the snapshot on the server before the model is called", () => {
    // The brief the model reads is built from the narrowed snapshot, and the
    // model is only called (through draftJobReport) after that.
    const narrowAt = fn.indexOf("snapshot = narrowSnapshot(");
    const factsAt = fn.indexOf("buildReportFacts(snapshot");
    const completeAt = fn.indexOf("await draftJobReport(");
    expect(narrowAt).toBeGreaterThan(-1);
    expect(factsAt).toBeGreaterThan(narrowAt);
    expect(completeAt).toBeGreaterThan(factsAt);
  });

  it("keeps the role-based redaction that runs before it", () => {
    // Narrowing is an extra gate, never a replacement: a rep still loses the
    // money block by role even if the section is somehow ticked.
    expect(fn).toContain("scope.caps.financials");
    expect(fn).toContain("delete snapshot.invoices");
    expect(fn).toContain("reportSectionsForAudience");
  });

  it("puts the daily field form's own content in the snapshot", () => {
    // "The updates from today's field form" — the words, not the hours.
    expect(server).toContain("field_work_tickets");
    expect(server).toContain("scope_completed");
    expect(server).toContain("work_notes");
  });
});
