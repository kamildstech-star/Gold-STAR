import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  previewOffices: null as string[] | null,
  snapshotProps: [] as { officeIds: string[] | null; periodLabel: string; from: Date; to: Date }[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Navigate: () => null,
  Link: () => null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ visibleLocations: [{ id: "nwk", name: "Newark" }] }),
  usePreviewOfficeScope: () => state.previewOffices,
}));
vi.mock("@/lib/permissions", () => ({ useCan: () => true }));
vi.mock("@/lib/chase-settings", () => ({
  useChaseSettings: () => ({ settings: { chronic_no_action_pct: 50 } }),
}));
vi.mock("@/components/export-excel-button", () => ({ ExportExcelButton: () => null }));
vi.mock("@/components/live-map", () => ({ LiveMap: () => null }));
vi.mock("@/components/chase/competitor-activity-snapshot", () => ({
  CompetitorActivitySnapshot: (props: (typeof state.snapshotProps)[number]) => {
    state.snapshotProps.push(props);
    return createElement("div", { "data-testid": "competitor-snapshot" }, "SNAPSHOT");
  },
}));

import { Route } from "./chase.performance";

const page = () =>
  renderToStaticMarkup(
    createElement((Route as unknown as { component: React.ComponentType }).component),
  );

beforeEach(() => {
  state.previewOffices = null;
  state.snapshotProps = [];
});

describe("Chase performance page", () => {
  it("replaces the lead progression funnel with the competitor snapshot, same slot", () => {
    const html = page();
    expect(html).not.toContain("Lead progression funnel");
    expect(html).not.toContain("Overall conversion rate");
    expect(html).toContain('data-testid="competitor-snapshot"');

    // Row 2 keeps three col-span-4 cards: trend, competitor snapshot, map.
    const trendAt = html.indexOf("Average response time trend");
    const snapAt = html.indexOf("SNAPSHOT");
    const mapAt = html.indexOf("Geographic performance");
    expect(trendAt).toBeGreaterThan(-1);
    expect(trendAt).toBeLessThan(snapAt);
    expect(snapAt).toBeLessThan(mapAt);
    const slotOpen = html.lastIndexOf(
      "<div",
      html.indexOf('data-testid="competitor-snapshot"') - 1,
    );
    expect(html.slice(slotOpen, slotOpen + 200)).toContain("lg:col-span-4");
  });

  it("feeds the snapshot the page's range and the View-As office scope", () => {
    state.previewOffices = ["nwk"];
    page();
    const props = state.snapshotProps[0]!;
    expect(props.periodLabel).toBe("Last 7 days");
    expect(props.officeIds).toEqual(["nwk"]);
    expect(props.to.getTime() - props.from.getTime()).toBe(7 * 86_400_000);
  });

  it("leaves scoping to RLS when not viewing as anyone", () => {
    page();
    expect(state.snapshotProps[0]!.officeIds).toBeNull();
  });
});
