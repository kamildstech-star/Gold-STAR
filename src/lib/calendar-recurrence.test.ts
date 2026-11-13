import { describe, expect, it } from "vitest";
import {
  expandRecurringEvent,
  validateRecurrence,
  type RecurrenceRule,
} from "./calendar-recurrence";
const from = new Date("2026-01-01");
const to = new Date("2028-01-01");
function series(start: string, rule: Partial<RecurrenceRule> = {}) {
  return {
    id: "master",
    starts_at: start,
    ends_at: new Date(Date.parse(start) + 3_600_000).toISOString(),
    is_cancelled: false,
    recurrence: {
      frequency: "weekly",
      interval: 1,
      timeZone: "America/New_York",
      count: 3,
      ...rule,
    } as RecurrenceRule,
  };
}
describe("local recurrence", () => {
  it("keeps 9am through spring and fall daylight-saving transitions", () => {
    expect(
      expandRecurringEvent(series("2026-03-01T14:00:00Z"), [], from, to).map((e) => e.starts_at),
    ).toEqual(["2026-03-01T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-15T13:00:00.000Z"]);
    expect(
      expandRecurringEvent(series("2026-10-25T13:00:00Z"), [], from, to).map((e) => e.starts_at),
    ).toEqual(["2026-10-25T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-08T14:00:00.000Z"]);
  });
  it("skips missing DST wall times without consuming an occurrence", () => {
    expect(
      expandRecurringEvent(
        series("2026-03-07T07:30:00Z", { frequency: "daily", count: 2 }),
        [],
        from,
        to,
      ).map((e) => e.starts_at),
    ).toEqual(["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
  });
  it("uses the earlier instant for repeated wall times", () => {
    expect(
      expandRecurringEvent(
        series("2026-10-31T05:30:00Z", { frequency: "daily", count: 2 }),
        [],
        from,
        to,
      )[1].starts_at,
    ).toBe("2026-11-01T05:30:00.000Z");
  });
  it("skips months without the selected day", () => {
    expect(
      expandRecurringEvent(
        series("2026-01-31T14:00:00Z", { frequency: "monthly" }),
        [],
        from,
        to,
      ).map((e) => e.starts_at?.slice(0, 10)),
    ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });
  it("applies interval and inclusive ending date", () => {
    const master = series("2026-01-01T14:00:00Z", {
      frequency: "daily",
      interval: 2,
      count: undefined,
      until: "2026-01-05",
    });
    expect(
      expandRecurringEvent(master, [], from, to).map((e) => e.starts_at?.slice(0, 10)),
    ).toEqual(["2026-01-01", "2026-01-03", "2026-01-05"]);
  });
  it("replaces moved occurrences and excludes canceled ones, without duplicates", () => {
    const master = series("2026-03-01T14:00:00Z");
    const moved = {
      ...master,
      id: "exception",
      recurrence: null,
      recurrence_master_id: "master",
      recurrence_index: 1,
      starts_at: "2026-03-20T14:00:00Z",
      ends_at: "2026-03-20T15:00:00Z",
    };
    const cancelled = { ...moved, id: "cancelled", recurrence_index: 2, is_cancelled: true };
    const result = expandRecurringEvent<typeof moved | typeof master>(
      master,
      [moved, cancelled],
      from,
      to,
    );
    expect(result.map((e) => e.id)).toEqual(["master:0", "exception"]);
    expect(result[1].starts_at).toBe(moved.starts_at);
  });
  it("finds moved exceptions inside a window even when original occurrence is outside", () => {
    const master = series("2026-03-01T14:00:00Z");
    const moved = {
      ...master,
      id: "exception",
      recurrence: null,
      recurrence_master_id: "master",
      recurrence_index: 2,
      starts_at: "2026-02-20T14:00:00Z",
      ends_at: "2026-02-20T15:00:00Z",
    };
    expect(
      expandRecurringEvent<typeof moved | typeof master>(
        master,
        [moved],
        new Date("2026-02-01"),
        new Date("2026-03-01"),
      ).map((e) => e.id),
    ).toEqual(["exception"]);
  });
  it("cancels an entire series including overridden events", () => {
    const master = { ...series("2026-03-01T14:00:00Z"), is_cancelled: true };
    expect(expandRecurringEvent(master, [], from, to)).toEqual([]);
  });
  it("validates bounds and dates before expansion", () => {
    const rule = series("2026-03-01T14:00:00Z").recurrence;
    expect(validateRecurrence({ ...rule, count: 0 }, "2026-03-01T14:00:00Z")).not.toBeNull();
    expect(
      validateRecurrence({ ...rule, timeZone: "nowhere" }, "2026-03-01T14:00:00Z"),
    ).not.toBeNull();
    expect(
      validateRecurrence(
        { ...rule, count: undefined, until: "2026-02-30" },
        "2026-03-01T14:00:00Z",
      ),
    ).not.toBeNull();
    expect(validateRecurrence({ ...rule, interval: 0 }, "2026-03-01T14:00:00Z")).not.toBeNull();
  });
});
