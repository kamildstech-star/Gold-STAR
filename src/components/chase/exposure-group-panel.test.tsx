import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Incident } from "@/lib/incidents";

const permission = vi.hoisted(() => ({
  commission: false,
  margin: false,
  calls: [] as string[],
  canSeeMoney: false,
}));
vi.mock("@/lib/permissions", () => ({
  useCan: (key: string) => {
    permission.calls.push(key);
    return key === "commission.view" ? permission.commission : permission.margin;
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    permission.canSeeMoney = queryKey[3] as boolean;
    return { data: null };
  },
}));
vi.mock("@/lib/exposures", () => ({ fetchExposureGroupDetail: vi.fn() }));
import { ExposureGroupPanel } from "./exposure-group-panel";

const incident = { id: "incident", exposure_group_id: null } as Incident;
it("keeps both permission hooks in order when permissions resolve or change", () => {
  for (const [commission, margin] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    permission.commission = commission;
    permission.margin = margin;
    permission.calls = [];
    renderToStaticMarkup(createElement(ExposureGroupPanel, { incident }));
    expect(permission.calls).toEqual(["commission.view", "job.view_margin"]);
    expect(permission.canSeeMoney).toBe(commission || margin);
  }
});
