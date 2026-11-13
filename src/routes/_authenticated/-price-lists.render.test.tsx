import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The price list admin screen, rendered without a database.
 *
 * The resolution rules are unit-tested in src/lib/price-lists.test.ts; what is
 * worth pinning here is that the screen says the true thing in each state —
 * above all that an unassigned list changes nothing, and that a list price is
 * shown BESIDE the catalog price it overrides rather than instead of it. A
 * screen that shows $80 with no $95 next to it is one an estimator cannot
 * check.
 */

const state = vi.hoisted(() => ({
  lists: [] as { id: string; name: string; description: string | null; is_active: boolean }[],
  assignments: [] as unknown[],
  items: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    const key = String(options.queryKey[0]);
    const data =
      key === "price-lists"
        ? state.lists
        : key === "price-list-assignments"
          ? state.assignments
          : key === "price-list-items"
            ? state.items
            : key === "estimate-catalog-items"
              ? [
                  {
                    id: "cat-daily",
                    header_id: null,
                    code: "DEHU-DAY",
                    name: "Dehumidifier, per day",
                    description: null,
                    uom: "DAY",
                    default_unit_price: 95,
                    taxable: true,
                    is_active: true,
                    sort_order: 0,
                  },
                ]
              : undefined;
    return { data, isLoading: false, isSuccess: true, isError: false, refetch: vi.fn() };
  },
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({
    userId: "qa-user",
    roles: ["admin"],
    writesDisabled: false,
    visibleLocations: [{ id: "loc-nj", name: "New Jersey", code: "NJ" }],
  }),
}));
vi.mock("@/components/account-picker", () => ({ AccountPicker: () => null }));

import { Route } from "./admin.price-lists";

const page = () =>
  renderToStaticMarkup(
    createElement((Route as unknown as { component: React.ComponentType }).component),
  );

beforeEach(() => {
  state.lists = [];
  state.assignments = [];
  state.items = [];
});

describe("price list admin", () => {
  it("says plainly that nothing changes until a list exists", () => {
    const html = page();
    expect(html).toContain("No price lists yet");
    expect(html).toContain("Estimate catalog price");
  });

  it("warns that a list assigned to nobody does nothing", () => {
    state.lists = [{ id: "l1", name: "Falcon 2026", description: null, is_active: true }];
    const html = page();
    expect(html).toContain("Falcon 2026");
    expect(html).toContain("this list changes nothing");
    // The order the resolver applies, said out loud on the screen that stores it.
    expect(html).toContain("A customer assignment beats an office one");
  });

  it("shows the catalog price beside the agreed price, not instead of it", () => {
    state.lists = [{ id: "l1", name: "Falcon 2026", description: null, is_active: true }];
    state.items = [
      { id: "pli-1", price_list_id: "l1", catalog_item_id: "cat-daily", unit_price: 80 },
    ];
    const html = page();
    expect(html).toContain("Dehumidifier, per day");
    expect(html).toContain("$95.00");
    expect(html).toContain('value="80"');
  });

  it("keeps the promise that a written line does not move", () => {
    expect(page()).toContain("never changes a line already written");
  });
});
