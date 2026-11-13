import { describe, expect, it } from "vitest";

import {
  compareToBaseline,
  daysSinceBaseline,
  describeBaselineAlignment,
  describeDelta,
  findBaselineSet,
  interiorDeltaF,
} from "@/lib/drying-baseline";
import type { DryingReading } from "@/lib/drying-log";

/**
 * The baseline is the sentence a claim is argued in: "the chamber was 71° dew
 * point the day we set the dehus and it is 58 today". Every failure mode here
 * is a way that sentence could come out flattering the job.
 */

let seq = 0;
function reading(
  over: Partial<DryingReading> & { reading_date: string; point?: string },
): DryingReading {
  seq += 1;
  return {
    id: `r${seq}`,
    job_id: "job-1",
    room_id: null,
    equipment_id: null,
    point: "affected",
    label: null,
    source: "manual",
    source_detail: null,
    temperature_f: 75,
    relative_humidity: 60,
    dew_point_f: 60,
    grains_per_pound: 78,
    notes: null,
    captured_at: `${over.reading_date}T15:00:00Z`,
    created_by: null,
    created_at: `${over.reading_date}T15:00:00Z`,
    updated_at: `${over.reading_date}T15:00:00Z`,
    is_demo: false,
    is_baseline: false,
    photo_path: null,
    photo_thumb_path: null,
    photo_mime: null,
    values_source: "typed",
    ...over,
  } as DryingReading;
}

describe("finding the baseline set", () => {
  it("has none when nothing has been logged", () => {
    expect(findBaselineSet([])).toBeNull();
  });

  it("prefers the day a crew actually flagged", () => {
    const set = findBaselineSet([
      reading({ reading_date: "2026-08-01", point: "interior", dew_point_f: 70 }),
      reading({
        reading_date: "2026-08-03",
        point: "interior",
        dew_point_f: 66,
        is_baseline: true,
      }),
    ]);
    expect(set?.date).toBe("2026-08-03");
    expect(set?.declared).toBe(true);
  });

  it("falls back to the first logged day, and says the day was inferred", () => {
    const set = findBaselineSet([
      reading({ reading_date: "2026-08-04", point: "interior", dew_point_f: 62 }),
      reading({ reading_date: "2026-08-01", point: "interior", dew_point_f: 70 }),
    ]);
    expect(set?.date).toBe("2026-08-01");
    // The flag is the whole point: a baseline taken three days after the
    // equipment went in must never be presented as the starting condition.
    expect(set?.declared).toBe(false);
  });

  it("never lets the nightly weather fill become the baseline day", () => {
    const set = findBaselineSet([
      reading({
        reading_date: "2026-07-30",
        point: "exterior",
        source: "weather",
        dew_point_f: 55,
      }),
      reading({ reading_date: "2026-08-01", point: "interior", dew_point_f: 70 }),
    ]);
    // A modelled exterior figure is not evidence anybody was in the building.
    expect(set?.date).toBe("2026-08-01");
  });

  it("keeps the modeled exterior figure once the day is chosen", () => {
    const set = findBaselineSet([
      reading({ reading_date: "2026-08-01", point: "interior", dew_point_f: 70 }),
      reading({
        reading_date: "2026-08-01",
        point: "exterior",
        source: "weather",
        dew_point_f: 54,
      }),
    ]);
    expect(set?.points.map((p) => p.point)).toEqual(["exterior", "interior"]);
  });

  it("takes the wettest reading of a point, not the last one typed", () => {
    const set = findBaselineSet([
      reading({ reading_date: "2026-08-01", point: "affected", label: "Kitchen", dew_point_f: 64 }),
      reading({ reading_date: "2026-08-01", point: "affected", label: "Hall", dew_point_f: 71 }),
    ]);
    expect(set?.points.find((p) => p.point === "affected")?.dewPointF).toBe(71);
  });

  it("prefers a crew's meter over the modeled figure for the same point", () => {
    const set = findBaselineSet([
      reading({
        reading_date: "2026-08-01",
        point: "exterior",
        source: "weather",
        dew_point_f: 80,
      }),
      reading({ reading_date: "2026-08-01", point: "exterior", dew_point_f: 54 }),
    ]);
    const exterior = set?.points.find((p) => p.point === "exterior");
    expect(exterior?.source).toBe("manual");
    expect(exterior?.dewPointF).toBe(54);
  });
});

describe("reading a day against the baseline", () => {
  const baseline = findBaselineSet([
    reading({
      reading_date: "2026-08-01",
      point: "interior",
      dew_point_f: 70,
      grains_per_pound: 110,
      is_baseline: true,
    }),
    reading({
      reading_date: "2026-08-01",
      point: "affected",
      dew_point_f: 74,
      grains_per_pound: 120,
      is_baseline: true,
    }),
  ]);

  it("calls a fallen dew point drying, with the gap to one decimal", () => {
    const deltas = compareToBaseline(baseline, [
      reading({ reading_date: "2026-08-05", point: "interior", dew_point_f: 63.7 }),
    ]);
    const inside = deltas.find((d) => d.point === "interior")!;
    expect(inside.deltaF).toBe(-6.3);
    expect(inside.verdict).toBe("drying");
    expect(describeDelta(inside)).toBe("6.3° drier than the baseline");
  });

  it("calls a risen dew point wetter — a stalled job must not read as progress", () => {
    const deltas = compareToBaseline(baseline, [
      reading({ reading_date: "2026-08-05", point: "interior", dew_point_f: 73 }),
    ]);
    expect(deltas.find((d) => d.point === "interior")?.verdict).toBe("wetter");
  });

  it("treats movement inside the meter's own error as no movement", () => {
    // A field thermo-hygrometer is good to about a degree of dew point.
    // Calling 0.4° a day of drying is claiming the instrument, not the house.
    const deltas = compareToBaseline(baseline, [
      reading({ reading_date: "2026-08-05", point: "interior", dew_point_f: 69.6 }),
    ]);
    expect(deltas.find((d) => d.point === "interior")?.verdict).toBe("flat");
    expect(describeDelta(deltas.find((d) => d.point === "interior")!)).toBe(
      "level with the baseline",
    );
  });

  it("says unknown rather than inventing a comparison for a point with no baseline", () => {
    const deltas = compareToBaseline(baseline, [
      reading({ reading_date: "2026-08-05", point: "unaffected", dew_point_f: 50 }),
    ]);
    const unaffected = deltas.find((d) => d.point === "unaffected")!;
    expect(unaffected.deltaF).toBeNull();
    expect(unaffected.verdict).toBe("unknown");
  });

  it("still reports a baseline point that was not read today", () => {
    const deltas = compareToBaseline(baseline, [
      reading({ reading_date: "2026-08-05", point: "interior", dew_point_f: 63 }),
    ]);
    // The affected chamber is in the baseline and missing today: it has to
    // appear as unknown, not silently vanish from the comparison.
    expect(deltas.find((d) => d.point === "affected")?.verdict).toBe("unknown");
  });

  it("carries grains per pound alongside the dew point", () => {
    const deltas = compareToBaseline(baseline, [
      reading({
        reading_date: "2026-08-05",
        point: "interior",
        dew_point_f: 63,
        grains_per_pound: 88,
      }),
    ]);
    expect(deltas.find((d) => d.point === "interior")?.deltaGpp).toBe(-22);
  });

  it("with no baseline at all, compares nothing", () => {
    const deltas = compareToBaseline(null, [
      reading({ reading_date: "2026-08-05", point: "interior", dew_point_f: 63 }),
    ]);
    expect(deltas.every((d) => d.verdict === "unknown")).toBe(true);
  });

  it("pulls the inside delta out for the day square", () => {
    const deltas = compareToBaseline(baseline, [
      reading({ reading_date: "2026-08-05", point: "interior", dew_point_f: 64 }),
    ]);
    expect(interiorDeltaF(deltas)).toBe(-6);
    expect(interiorDeltaF([])).toBeNull();
  });
});

describe("the baseline against the equipment drop", () => {
  it("says nothing when they are the same day, which is the rule", () => {
    expect(describeBaselineAlignment("2026-08-01", "2026-08-01")).toBeNull();
  });

  it("says nothing when there is nothing to compare", () => {
    expect(describeBaselineAlignment(null, "2026-08-01")).toBeNull();
    expect(describeBaselineAlignment("2026-08-01", null)).toBeNull();
  });

  it("warns when the baseline was taken after the machines went in", () => {
    expect(describeBaselineAlignment("2026-08-03", "2026-08-01")).toContain("2 days after");
  });

  it("warns the other way too, in the singular", () => {
    expect(describeBaselineAlignment("2026-07-31", "2026-08-01")).toContain("1 day before");
  });

  it("counts whole days across a clock change", () => {
    // Parsed at UTC noon: a DST transition can neither eat nor invent a day of
    // equipment rental.
    expect(daysSinceBaseline("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysSinceBaseline("2026-11-01", "2026-11-02")).toBe(1);
  });
});

/**
 * Per-room inside readings landed on 2026-09-07. The baseline comparison is
 * grouped by POINT, not by room, so it needed nothing new — but the rule it
 * already applied (wettest wins) is now load-bearing for a different reason,
 * and it has to keep agreeing with the day square, which shows the same
 * reading. These pin that agreement.
 */
describe("inside readings taken in several rooms", () => {
  it("compares the wettest room against the wettest room", () => {
    const baseline = findBaselineSet([
      reading({
        reading_date: "2026-08-01",
        point: "interior",
        room_id: "kitchen",
        dew_point_f: 64,
      }),
      reading({
        reading_date: "2026-08-01",
        point: "interior",
        room_id: "cellar",
        dew_point_f: 71,
      }),
    ]);
    expect(baseline!.points.find((p) => p.point === "interior")!.dewPointF).toBe(71);

    const deltas = compareToBaseline(baseline, [
      reading({
        reading_date: "2026-08-05",
        point: "interior",
        room_id: "kitchen",
        dew_point_f: 55,
      }),
      reading({
        reading_date: "2026-08-05",
        point: "interior",
        room_id: "cellar",
        dew_point_f: 63,
      }),
    ]);
    // 63 against 71, not 55 against 64: the house is dry when its worst room is.
    expect(interiorDeltaF(deltas)).toBe(-8);
  });

  it("does not let one dry room hide a room that got wetter", () => {
    const baseline = findBaselineSet([
      reading({
        reading_date: "2026-08-01",
        point: "interior",
        room_id: "cellar",
        dew_point_f: 60,
      }),
    ]);
    const deltas = compareToBaseline(baseline, [
      reading({
        reading_date: "2026-08-05",
        point: "interior",
        room_id: "kitchen",
        dew_point_f: 50,
      }),
      reading({
        reading_date: "2026-08-05",
        point: "interior",
        room_id: "cellar",
        dew_point_f: 68,
      }),
    ]);
    expect(interiorDeltaF(deltas)).toBe(8);
    expect(deltas.find((d) => d.point === "interior")!.verdict).toBe("wetter");
  });
});
