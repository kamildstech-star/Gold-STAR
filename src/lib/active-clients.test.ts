import { describe, expect, it } from "vitest";

import { isOpenClientJobStatus } from "./active-clients";

describe("isOpenClientJobStatus", () => {
  it.each(["new", "scheduled", "in_progress", "drying"])("keeps %s on Active Clients", (status) => {
    expect(isOpenClientJobStatus(status)).toBe(true);
  });

  it.each(["complete", "invoiced", "paid", "cancelled", null])(
    "does not let %s history keep a reverted account active",
    (status) => {
      expect(isOpenClientJobStatus(status)).toBe(false);
    },
  );
});
