import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  allowed: true,
  error: false,
  loading: false,
  queries: [] as { queryKey: unknown[]; enabled?: boolean }[],
}));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    state.queries.push(options);
    return {
      data: undefined,
      isLoading: state.loading,
      isSuccess: !state.error && !state.loading,
      isError: state.error,
      refetch: vi.fn(),
    };
  },
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "qa-user", roles: ["admin"], writesDisabled: false }),
}));
vi.mock("@/lib/permissions", () => ({
  useMyPermissions: () => ({
    loading: false,
    allowed: new Set(state.allowed ? ["expenses.approve"] : []),
  }),
}));
vi.mock("@/components/location-picker", () => ({ useDefaultLocationId: () => null }));
vi.mock("@/lib/managed-options", () => ({
  optionsFrom: () => [],
  useManagedOptions: () => ({ label: (s: string) => s }),
}));
vi.mock("@/components/managed-option-items", () => ({ ManagedOptionItems: () => null }));
vi.mock("@/components/export-excel-button", () => ({ ExportExcelButton: () => null }));
vi.mock("@/components/ui-density", () => ({
  PageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) =>
    createElement("header", null, title, children),
}));

import { Route as Expenses } from "./expenses.index";
import { Route as Approvals } from "./expenses.approvals";
const page = (route: unknown) =>
  renderToStaticMarkup(createElement((route as { component: React.ComponentType }).component));

beforeEach(() => {
  state.allowed = true;
  state.error = false;
  state.loading = false;
  state.queries = [];
});

describe("expense page states", () => {
  it("renders the standard shell and identifies personal requests", () => {
    const html = page(Expenses);
    expect(html).toContain("page-shell w-full min-w-0");
    expect(html).toContain("My requests");
  });
  it("does not show empty success or an invented approval threshold on failure", () => {
    state.error = true;
    const html = page(Expenses);
    expect(html).toContain("Could not load your requests");
    expect(html).toContain("Your approval limit could not be loaded");
    expect(html).not.toContain("Nothing requested yet");
    expect(html).not.toContain("$50.00");
  });
  it("shows an explicit request loading state", () => {
    state.loading = true;
    expect(page(Expenses)).toContain("Loading your requests");
  });
  it("does not query approver data after an explicit capability revoke", () => {
    state.allowed = false;
    const html = page(Approvals);
    expect(html).toBe("");
    expect(html).not.toContain("limited");
    expect(state.queries).toHaveLength(3);
    expect(state.queries.every((q) => q.enabled === false)).toBe(true);
  });
  it("scopes approval caches to the current identity and reports failures", () => {
    state.error = true;
    const html = page(Approvals);
    expect(html).toContain("Could not load approval requests");
    expect(html).not.toContain("Nothing waiting on you");
    expect(state.queries.every((q) => q.queryKey.includes("qa-user"))).toBe(true);
  });
});
