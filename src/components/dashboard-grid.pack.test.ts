import { describe, expect, it } from "vitest";

import { packSpans } from "@/components/dashboard-grid";

describe("packSpans — no row ends short of 12 columns", () => {
  it("gives a short row's spare columns to its last card", () => {
    // Map 5, feed 3, crew 3 = 11; inspections 5 + revenue 4 = 9.
    expect(packSpans([12, 5, 3, 3, 5, 4])).toEqual([12, 5, 3, 4, 5, 7]);
  });

  it("leaves full rows alone and skips cards that render nothing", () => {
    expect(packSpans([4, 4, 4, 6, 0, 6])).toEqual([4, 4, 4, 6, 0, 6]);
    expect(packSpans([8, 0])).toEqual([12, 0]);
  });
});
