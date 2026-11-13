import { describe, expect, it } from "vitest";

import { isoToUS, joinIsoDateTime, maskUSDate, splitIsoDateTime, usToIso } from "./us-date-input";

describe("US date box text (FE5)", () => {
  it("shows ISO as MM/DD/YYYY", () => {
    expect(isoToUS("2026-10-28")).toBe("10/28/2026");
    expect(isoToUS("2026-03-04T09:30")).toBe("03/04/2026");
    expect(isoToUS("")).toBe("");
    expect(isoToUS(null)).toBe("");
  });

  it("reads month first, never day first", () => {
    expect(usToIso("10/28/2026")).toBe("2026-10-28");
    expect(usToIso("03/04/2026")).toBe("2026-03-04");
    expect(usToIso("1/5/2026")).toBe("2026-01-05");
    expect(usToIso("1-5-26")).toBe("2026-01-05");
    // 28 is no month: a day-first entry is refused, not silently swapped.
    expect(usToIso("28/10/2026")).toBeNull();
  });

  it("refuses dates that do not exist or are not whole", () => {
    expect(usToIso("02/30/2026")).toBeNull();
    expect(usToIso("02/29/2028")).toBe("2028-02-29");
    expect(usToIso("10/28")).toBeNull();
    expect(usToIso("10/28/202")).toBeNull();
  });

  it("puts the slashes in while digits are typed", () => {
    expect(maskUSDate("1")).toBe("1");
    expect(maskUSDate("102")).toBe("10/2");
    expect(maskUSDate("10282026")).toBe("10/28/2026");
    expect(maskUSDate("102820261")).toBe("10/28/2026");
    expect(maskUSDate("1/5/2026")).toBe("1/5/2026");
  });

  it("splits and joins date + time", () => {
    expect(splitIsoDateTime("2026-10-28T14:05")).toEqual({ date: "2026-10-28", time: "14:05" });
    expect(splitIsoDateTime("2026-10-28")).toEqual({ date: "2026-10-28", time: "" });
    expect(joinIsoDateTime("2026-10-28", "14:05")).toBe("2026-10-28T14:05");
    expect(joinIsoDateTime("2026-10-28", "")).toBe("");
  });
});
