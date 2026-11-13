import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Tables } from "@/integrations/supabase/types";

const fixture = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  scopes: [] as string[][],
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: () => Promise.resolve({ data: [{ user_id: "rep", full_name: "QA Rep" }], error: null }),
    from: (table: string) => {
      const query = {
        select: () => query,
        gte: () => query,
        in: (_column: string, values: string[]) => {
          fixture.scopes.push(values);
          return query;
        },
        then: (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: fixture.tables[table] ?? [], error: null })),
      };
      return query;
    },
  },
}));
import { fetchChasePerformance, fetchSalesActivity } from "./reports";

beforeEach(() => {
  fixture.tables = {};
  fixture.scopes = [];
});

describe("report enum compatibility", () => {
  it("counts current in-person and virtual meetings, and preserves legacy meetings", async () => {
    const currentTypes = [
      "meeting_in_person",
      "meeting_virtual",
      "call",
      "email",
      "gift",
    ] satisfies Tables<"touchpoints">["type"][];
    fixture.tables.touchpoints = [...currentTypes, "meeting"].map((type) => ({
      type,
      created_by: "rep",
      account_id: null,
    }));
    const [row] = await fetchSalesActivity(null, "2026-09-01");
    expect(row).toMatchObject({ meetings: 3, calls: 1, emails: 1, gifts: 1, touchpoints: 6 });
  });
  it("counts not-real-loss outcomes without labeling declined or minor-loss leads false", async () => {
    const currentOutcomes = [
      "not_real_loss",
      "homeowner_declined",
      "damage_too_minor",
      null,
    ] satisfies Tables<"incidents">["outcome"][];
    fixture.tables.incidents = [...currentOutcomes, "false_alarm", "no_damage"].map((outcome) => ({
      outcome,
      location_id: "office",
    }));
    const [row] = await fetchChasePerformance(null, "2026-09-01", { office: "Office" });
    expect(row).toMatchObject({ dispatched: 6, falseAlarms: 3, label: "Office" });
  });
  it("retains a deny-all location filter for an empty authorized scope", async () => {
    await fetchChasePerformance([], "2026-09-01", {});
    expect(fixture.scopes).toEqual([["00000000-0000-0000-0000-000000000000"]]);
  });
});
