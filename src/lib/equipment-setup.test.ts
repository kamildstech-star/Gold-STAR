import { describe, expect, it } from "vitest";

import { countsFromTags, describeSetup, planSetup, type SetupUnit } from "@/lib/equipment-setup";

/**
 * David's scope of work, 2 Sep: "Set up equipment – Scan."
 *
 * One scan has to do two things — tag the ticket and log the unit out — and
 * the failure this guards against is the two drifting apart: a machine counted
 * on the ticket that the placement log has never heard of, or placed twice
 * because a crew re-scanned the room they set up this morning.
 */
const AM: SetupUnit = { id: "e1", asset_tag: "GSR-AM00034-NJ", equipment_type: "air_mover" };
const DH: SetupUnit = { id: "e2", asset_tag: "GSR-DH1-NY", equipment_type: "dehumidifier" };
const AM2: SetupUnit = { id: "e3", asset_tag: "GSR-AM00099-NJ", equipment_type: "air_mover" };
const HEPA: SetupUnit = { id: "e4", asset_tag: "GSR-HP7-NJ", equipment_type: "hepa" };
const METER: SetupUnit = { id: "e5", asset_tag: "GSR-MM2-NJ", equipment_type: "moisture_meter" };

describe("planning what a setup scan has to write", () => {
  it("places everything that is not already out on this job", () => {
    const plan = planSetup({ scanned: [AM, DH], alreadyOut: new Set(), ticketTags: [] });
    expect(plan.toPlace.map((u) => u.id)).toEqual(["e1", "e2"]);
    expect(plan.alreadyOnJob).toEqual([]);
  });

  it("does not log a unit out twice when the crew re-scans the room", () => {
    // Confirming is not a mistake and must not cost a second placement row —
    // the partial unique index would refuse it anyway, loudly.
    const plan = planSetup({ scanned: [AM, DH], alreadyOut: new Set(["e1"]), ticketTags: [] });
    expect(plan.toPlace.map((u) => u.id)).toEqual(["e2"]);
    expect(plan.alreadyOnJob.map((u) => u.id)).toEqual(["e1"]);
  });

  it("still adds the ticket tag for a unit that was already placed", () => {
    // The two records answer different questions. A machine placed this
    // morning by the crew chief belongs on tonight's ticket all the same.
    const plan = planSetup({ scanned: [AM], alreadyOut: new Set(["e1"]), ticketTags: [] });
    expect(plan.toPlace).toEqual([]);
    expect(plan.newTags).toEqual([{ tag: "GSR-AM00034-NJ", key: "air_mover" }]);
  });

  it("does not add a tag the ticket already carries, whatever the case", () => {
    const plan = planSetup({
      scanned: [AM],
      alreadyOut: new Set(),
      ticketTags: [{ tag: "gsr-am00034-nj", key: "air_mover" }],
    });
    expect(plan.newTags).toEqual([]);
    // It is still placed: being on the ticket says nothing about the log.
    expect(plan.toPlace.map((u) => u.id)).toEqual(["e1"]);
  });

  it("does not add the same tag twice within one scan", () => {
    const plan = planSetup({ scanned: [AM, AM], alreadyOut: new Set(), ticketTags: [] });
    expect(plan.newTags).toHaveLength(1);
  });

  it("maps a unit onto the paper form's line, not its own type name", () => {
    // The form has "Scrubber"; the register has air_scrubber AND hepa.
    const plan = planSetup({ scanned: [HEPA], alreadyOut: new Set(), ticketTags: [] });
    expect(plan.newTags).toEqual([{ tag: "GSR-HP7-NJ", key: "scrubber" }]);
  });

  it("places a unit with no line on the form and says it has none", () => {
    // A moisture meter is tracked equipment with nothing to count on the
    // ticket. Refusing to place it would lose the machine to save a number.
    const plan = planSetup({ scanned: [METER], alreadyOut: new Set(), ticketTags: [] });
    expect(plan.toPlace.map((u) => u.id)).toEqual(["e5"]);
    expect(plan.uncategorized.map((u) => u.id)).toEqual(["e5"]);
    expect(plan.newTags).toEqual([{ tag: "GSR-MM2-NJ", key: null }]);
  });
});

describe("the counts a scan sets on the ticket", () => {
  it("counts each line from the tags", () => {
    const tags = [
      { tag: "a", key: "air_mover" },
      { tag: "b", key: "air_mover" },
      { tag: "c", key: "dehumidifier" },
    ];
    expect(countsFromTags(tags)).toEqual({ air_mover: "2", dehumidifier: "1" });
  });

  it("leaves a line nobody scanned alone rather than zeroing it", () => {
    // A crew that scans four air movers and types "2 injectors" keeps their 2:
    // the scan is evidence about air movers and says nothing about injectors.
    const counts = countsFromTags([{ tag: "a", key: "air_mover" }]);
    expect(counts).not.toHaveProperty("injector");
    expect(counts).not.toHaveProperty("dehumidifier");
  });

  it("ignores a tag with no line on the form", () => {
    expect(countsFromTags([{ tag: "m", key: null }])).toEqual({});
  });
});

describe("what the crew is told a scan did", () => {
  it("reports both halves so a seventh unit is never a mystery", () => {
    const plan = planSetup({ scanned: [AM, DH, AM2], alreadyOut: new Set(["e3"]), ticketTags: [] });
    expect(describeSetup(plan)).toBe("2 units placed · 1 already on this job");
  });

  it("says the units were already out rather than reading as a failure", () => {
    const plan = planSetup({ scanned: [AM], alreadyOut: new Set(["e1"]), ticketTags: [] });
    expect(describeSetup(plan)).toBe("1 already on this job");
  });

  it("gets the singular right on one unit", () => {
    const plan = planSetup({ scanned: [AM], alreadyOut: new Set(), ticketTags: [] });
    expect(describeSetup(plan)).toBe("1 unit placed");
  });

  it("says nothing was scanned rather than an empty sentence", () => {
    const plan = planSetup({ scanned: [], alreadyOut: new Set(), ticketTags: [] });
    expect(describeSetup(plan)).toBe("Nothing scanned.");
  });
});
