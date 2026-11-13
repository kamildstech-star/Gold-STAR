import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[][],
  children: [] as Record<string, unknown>[],
  parentWhy: null as string | null,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(async () => ({ data: mocks.children, error: null })),
          maybeSingle: vi.fn(async () => ({ data: { why: mocks.parentWhy }, error: null })),
        })),
      })),
      update: vi.fn((payload: Record<string, unknown>) => {
        mocks.updates.push(payload);
        return { eq: vi.fn(async () => ({ error: null })) };
      }),
      insert: vi.fn((payload: Record<string, unknown> | Record<string, unknown>[]) => {
        mocks.inserts.push(Array.isArray(payload) ? payload : [payload]);
        return {
          select: vi.fn(() => ({
            single: vi.fn(async () => ({ data: { id: "parent-1" }, error: null })),
          })),
          then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
        };
      }),
    })),
    rpc: vi.fn(async () => ({ error: null })),
  },
}));

import { GOAL_METRICS, saveAnnualGoal, splitAnnual } from "./goals";

describe("annual goal breakdown", () => {
  beforeEach(() => {
    mocks.updates = [];
    mocks.inserts = [];
    mocks.children = [];
    mocks.parentWhy = null;
  });

  it("keeps every month positive for annual counts below twelve", () => {
    const months = splitAnnual(5, "count");

    expect(months).toHaveLength(12);
    expect(months.every((target) => target > 0)).toBe(true);
    expect(months.reduce((sum, target) => sum + target, 0)).toBeCloseTo(5);
    expect(GOAL_METRICS.jobs_won.format(months[0]!)).toBe("0.42");
  });

  it("retains whole monthly work items for larger count targets", () => {
    const months = splitAnnual(50, "count");

    expect(months).toEqual([5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]);
    expect(months.reduce((sum, target) => sum + target, 0)).toBe(50);
  });

  it.each([
    ["percent", 60],
    ["minutes", 45],
  ] as const)("repeats non-additive %s targets for every month", (unit, target) => {
    expect(splitAnnual(target, unit)).toEqual(Array(12).fill(target));
  });

  it("does not erase the rep's why when a caller omits it", async () => {
    mocks.parentWhy = "Buy a family home";
    mocks.children = [
      {
        id: "month-1",
        starts_on: "2026-01-01",
        why: "Buy a family home",
      },
    ];

    await saveAnnualGoal({
      parentId: "parent-1",
      subject_user_id: "rep-1",
      location_id: "location-1",
      metric: "jobs_won",
      annual_target: 24,
      year: 2026,
      set_by: "manager-1",
      redistribute: false,
    });

    expect(mocks.updates).toHaveLength(2);
    expect(mocks.updates.every((payload) => payload.why === "Buy a family home")).toBe(true);
    expect(mocks.inserts.flat().every((payload) => payload.why === "Buy a family home")).toBe(true);
  });

  it("propagates an explicitly supplied why to the year and its months", async () => {
    await saveAnnualGoal({
      parentId: "parent-1",
      subject_user_id: "rep-1",
      location_id: "location-1",
      metric: "jobs_won",
      annual_target: 24,
      year: 2026,
      why: "  Buy a family home  ",
      set_by: "manager-1",
      redistribute: true,
    });

    expect(mocks.updates[0]).toMatchObject({ why: "Buy a family home" });
    expect(mocks.inserts.flat()).toHaveLength(12);
    expect(mocks.inserts.flat().every((payload) => payload.why === "Buy a family home")).toBe(true);
  });
});
