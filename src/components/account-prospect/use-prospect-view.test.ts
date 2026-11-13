import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("@/lib/visits", () => ({
  classifyStage: vi.fn(),
  fetchProspectingStages: vi.fn(),
  lookupStage: vi.fn(),
}));

import { fullRecordDestination } from "./use-prospect-view";

describe("fullRecordDestination", () => {
  it("switches the layout when the drawer is already on that account's page", () => {
    expect(fullRecordDestination("acc-1", "acc-1")).toEqual({ kind: "switch" });
  });

  it("navigates to the account from anywhere else", () => {
    const expected = { kind: "navigate", to: "/accounts/$id", params: { id: "acc-1" } };
    expect(fullRecordDestination("acc-1", "acc-2")).toEqual(expected);
    expect(fullRecordDestination("acc-1", null)).toEqual(expected);
    expect(fullRecordDestination("acc-1", undefined)).toEqual(expected);
  });
});
