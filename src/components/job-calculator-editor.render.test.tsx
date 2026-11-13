// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark's QC fixture (2026-09-09): a fresh "new estimate" — one day, no hours,
 * water — prices at $350 with a $300 internal cost and $50 overall profit.
 * With View As -> Sales Person those two internal figures were on screen.
 *
 * The editor is rendered here exactly as it is on /estimates/new, once as a
 * viewer without job.view_costs and once as a holder, and the DOM is read
 * the way Mark read it.
 */
const state = vi.hoisted(() => ({ allowed: new Set<string>() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => createElement("a", null, children),
  useNavigate: () => vi.fn(),
  // The screen's back control is the shared `BackLink`, which asks the router
  // where the user came from. Nothing here exercises that; it just has to exist.
  useRouter: () => ({
    history: { location: { state: {} }, canGoBack: () => false, back: vi.fn() },
  }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: "/estimates/new", search: {}, searchStr: "" } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, error: null }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "qa-user", currentLocationId: "loc-1", writesDisabled: false }),
}));
vi.mock("@/components/location-picker", () => ({
  LocationPicker: () => null,
  useWritableLocations: () => [],
  useJobCreatableLocations: () => [],
}));
// The editor asks which office is the viewer's own, to file a new sheet under
// something they can predict. It reads the whole app context to answer that,
// and this fixture's context is a stub; the answer is irrelevant to what is
// being tested here.
vi.mock("@/lib/use-own-location", () => ({
  useOwnLocationId: () => null,
  useLocationChoice: () => "all",
}));
vi.mock("@/components/address-autocomplete", () => ({ AddressAutocomplete: () => null }));
vi.mock("@/components/pdf-preview-dialog", () => ({ PdfPreviewDialog: () => null }));
vi.mock("@/lib/permissions", () => ({
  useCan: (key: string) => state.allowed.has(key),
}));
vi.mock("@/lib/job-calculations", () => ({
  attachJobCalculation: vi.fn(),
  listJobsForCalculation: vi.fn(),
  loadJobCalculation: vi.fn(),
  saveJobCalculation: vi.fn(),
}));
// Spy on the internal arithmetic without changing it: the point is that it is
// never invoked for a viewer who may not see the result.
vi.mock("@/lib/job-calculator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/job-calculator")>();
  return { ...actual, calculateInternalFigures: vi.fn(actual.calculateInternalFigures) };
});

import { JobCalculatorEditor } from "./job-calculator-editor";
import { calculateInternalFigures, emptyJobCalculationInput } from "@/lib/job-calculator";

const FIXTURE = {
  ...emptyJobCalculationInput(),
  jobDate: "2026-09-09",
  jobType: "water" as const,
  days: 1,
  workers: 1,
  regularHours: 0,
  afterHours: 0,
};

function render() {
  const html = renderToStaticMarkup(createElement(JobCalculatorEditor, { prefill: FIXTURE }));
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = (testId: string) =>
    doc.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? null;
  return { html, doc, text };
}

beforeEach(() => {
  state.allowed = new Set();
  vi.mocked(calculateInternalFigures).mockClear();
});

describe("job calculator cost visibility", () => {
  it("draws no internal cost or profit at all for a viewer without job.view_costs", () => {
    state.allowed = new Set(["job.view_margin"]);
    const { html, text } = render();

    expect(text("calculator-customer-price")).toBe("$350.00");
    expect(text("calculator-customer-price-bar")).toBe("$350.00");
    // Not "Hidden", not "n/a": the rows are not there.
    expect(text("calculator-internal-cost")).toBeNull();
    expect(text("calculator-equipment-profit")).toBeNull();
    expect(text("calculator-overall-profit")).toBeNull();
    expect(html).not.toContain("Internal cost");
    expect(html).not.toContain("Hidden");
    expect(html).not.toContain("n/a");
    // Not hidden — never computed.
    expect(calculateInternalFigures).not.toHaveBeenCalled();
  });

  it("shows the real figures to a holder of job.view_costs and job.view_margin", () => {
    state.allowed = new Set(["job.view_costs", "job.view_margin"]);
    const { text } = render();

    expect(text("calculator-customer-price")).toBe("$350.00");
    expect(text("calculator-customer-price-bar")).toBe("$350.00");
    expect(text("calculator-internal-cost")).toBe("$300.00");
    expect(text("calculator-equipment-profit")).toBe("$0.00");
    expect(text("calculator-overall-profit")).toBe("$50.00");
    expect(calculateInternalFigures).toHaveBeenCalled();
  });

  it("shows the cost but no profit rows to a cost holder without job.view_margin", () => {
    state.allowed = new Set(["job.view_costs"]);
    const { html, text } = render();

    expect(text("calculator-internal-cost")).toBe("$300.00");
    expect(text("calculator-equipment-profit")).toBeNull();
    expect(text("calculator-overall-profit")).toBeNull();
    expect(html).not.toContain("profit");
  });

  it("never prints a cost rate: equipment lines carry the customer rate only", () => {
    const { html } = render();
    // Air mover: $45 customer, $5 internal. Dehumidifier: $225 / $20.
    expect(html).toContain("$45.00 / day");
    expect(html).toContain("$225.00 / day");
    expect(html).not.toContain("$5.00");
    expect(html).not.toContain("$20.00");
    expect(html).not.toMatch(/internalRate|internal_cost|overallProfit/);
  });
});
