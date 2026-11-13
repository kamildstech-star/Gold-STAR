import { describe, expect, it } from "vitest";
import { validateEventTimes } from "./calendar-validation";

describe("calendar event times", () => {
  it("rejects empty or invalid dates before serialization", () => {
    expect(validateEventTimes("", "2026-09-07T12:00")).not.toBeNull();
    expect(validateEventTimes("2026-09-07T12:00", "bad")).not.toBeNull();
  });
  it("rejects equal and backwards ranges", () => {
    expect(validateEventTimes("2026-09-07T12:00", "2026-09-07T12:00")).not.toBeNull();
    expect(validateEventTimes("2026-09-07T12:00", "2026-09-07T11:00")).not.toBeNull();
  });
  it("accepts overnight and timezone-aware ranges", () => {
    expect(validateEventTimes("2026-09-07T23:00", "2026-09-08T01:00")).toBeNull();
    expect(validateEventTimes("2026-09-07T12:00-04:00", "2026-09-07T17:00Z")).toBeNull();
  });
});
