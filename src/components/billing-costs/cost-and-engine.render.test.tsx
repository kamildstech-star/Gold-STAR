// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing & Costs › Cost and the overhead engine, driven for real (prompt 3):
 * field labor locked to the engine with its breakdown, management typed, a
 * class switch, the cost save's payload, the missing-cost banner, margin
 * below the minimum, and the engine's publish (note required, temp wage,
 * added component, the live total). Loaders and saves are stubbed — the
 * arithmetic is in overhead.test.ts and the database in the pglite fixture.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  saves: [] as { changes: unknown; note: string; rpc: string }[],
  engineSaves: [] as { changes: unknown; note: string }[],
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => undefined,
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/use-page-access", () => ({ useMyPageAccess: () => ({ canOpen: () => true }) }));
vi.mock("@/components/billing-costs/cost-access", () => ({
  useCostAccess: () => ({ seeCosts: true, editCosts: true, manageOverhead: true }),
}));
vi.mock("@/lib/running-cost", () => ({
  getMarginThreshold: async () => 30,
  listEquipmentRates: async () => [],
}));
vi.mock("@/lib/tm-rates", async (orig) => {
  const real = await orig<typeof import("@/lib/tm-rates")>();
  const cost = (item_key: string, office_id: string | null, value: number | null) => ({
    book: "cost" as const,
    item_key,
    measure: "cost_rate",
    office_id,
    effective_from: "2000-01-01",
    value,
  });
  const rate = (item_key: string, value: number) => ({
    book: "tm_rates" as const,
    item_key,
    measure: "bill_rate",
    office_id: null,
    effective_from: "2000-01-01",
    value,
  });
  const item = (key: string, laborClass: "field" | "management" | undefined, over = {}) => ({
    key,
    code: key,
    name: key,
    category: "labor" as const,
    unitLabel: "per hour",
    active: true,
    archived: false,
    smallTools: laborClass === "field",
    laborClass,
    ...over,
  });
  return {
    ...real,
    loadTmRates: async () => ({
      available: true,
      items: [item("SCL", "field"), item("PCT", "management"), item("CCF", "management")],
      rows: [cost("SCL", null, 49.5), cost("PCT", null, 60)],
      otherRows: [rate("SCL", 88), rate("PCT", 80), rate("CCF", 98)],
      offices: [{ id: "nj", name: "Lakewood", code: "NJ" }],
      lastChange: null,
    }),
    saveTmRates: async (changes: unknown, note: string, _c: unknown, rpc: string) => {
      state.saves.push({ changes, note, rpc });
      return (changes as unknown[]).length;
    },
  };
});
const ENGINE = {
  available: true,
  components: [
    { key: "wage", name: "Wage", note: null, system: true, sort_order: 10, archived_at: null },
    {
      key: "general_liability",
      name: "General liability",
      note: null,
      system: true,
      sort_order: 20,
      archived_at: null,
    },
    {
      key: "workers_comp",
      name: "Workers' comp",
      note: null,
      system: true,
      sort_order: 30,
      archived_at: null,
    },
  ],
  rows: [
    {
      book: "overhead" as const,
      item_key: "wage",
      measure: "cost_hr",
      office_id: null,
      effective_from: "2020-01-01",
      value: 45,
    },
    {
      book: "overhead" as const,
      item_key: "general_liability",
      measure: "cost_hr",
      office_id: null,
      effective_from: "2026-03-01",
      value: 3,
    },
    {
      book: "overhead" as const,
      item_key: "workers_comp",
      measure: "cost_hr",
      office_id: null,
      effective_from: "2026-03-01",
      value: 1.5,
    },
  ],
  labour: [
    {
      id: "t",
      role: null,
      crew_class: "temp",
      user_id: null,
      location_id: null,
      hourly_rate: 45,
      effective_from: "2020-01-01",
      effective_to: null,
      note: null,
    },
    {
      id: "o",
      role: "owner",
      crew_class: null,
      user_id: null,
      location_id: null,
      hourly_rate: 120,
      effective_from: "2026-01-01",
      effective_to: null,
      note: null,
    },
  ],
};
vi.mock("@/lib/overhead", async (orig) => ({
  ...(await orig<typeof import("@/lib/overhead")>()),
  loadOverhead: async () => ENGINE,
  saveOverhead: async (changes: unknown, note: string) => {
    state.engineSaves.push({ changes, note });
    return (changes as unknown[]).length;
  },
}));
vi.mock("@/components/ui/select", () => {
  const Pick = createContext<(v: string) => void>(() => {});
  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: ReactNode;
      onValueChange: (v: string) => void;
    }) => createElement(Pick.Provider, { value: onValueChange }, children),
    SelectTrigger: ({ children, ...p }: { children: ReactNode }) =>
      createElement("div", p, children),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) =>
      createElement("div", { role: "listbox" }, children),
    SelectItem: function Item({ children, value }: { children: ReactNode; value: string }) {
      const pick = useContext(Pick);
      return createElement(
        "div",
        { role: "option", "data-value": value, onClick: () => pick(value) },
        children,
      );
    },
  };
});
vi.mock("@/components/ui/multi-select", () => ({ MultiSelect: () => null }));

import { CostTab } from "./cost-tab";

let host: HTMLDivElement;
let root: Root;

async function render(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, node)));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
const $ = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const text = () => host.textContent ?? "";
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().endsWith(label),
  ) as HTMLButtonElement;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}
const tab = () => createElement(CostTab, { category: "labor", onCategory: () => {} });

beforeEach(() => {
  state.saves = [];
  state.engineSaves = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the Cost grid", () => {
  it("locks a field title to the engine, with its breakdown; management is typed", async () => {
    await render(tab());
    const scl = $('[data-tm-rate-row="SCL"]')!;
    expect(scl.querySelector("[data-computed-cost]")?.textContent).toContain("$49.50");
    expect(scl.querySelector("input")).toBeNull();
    expect(scl.textContent).toContain("computed — view breakdown");
    const pct = $<HTMLInputElement>('[aria-label="Cost for PCT at company default"]')!;
    expect(pct.value).toBe("60.00");
  });

  it("shows the rate read only and the margin, amber below the minimum", async () => {
    await render(tab());
    // SCL: (88 − 49.50) / 88 = 43.8%; PCT: (80 − 60) / 80 = 25% — under the 30% floor
    expect($('[data-tm-rate-row="SCL"]')?.textContent).toContain("43.8%");
    const pctMargin = [...$('[data-tm-rate-row="PCT"]')!.querySelectorAll("span")].find((s) =>
      s.textContent?.trim().endsWith("25%"),
    )!;
    expect(pctMargin.className).toContain("text-warning");
    expect(pctMargin.getAttribute("title")).toBe("Below the 30% minimum margin");
  });

  it("names the missing costs, and a typed cost saves through cost_save", async () => {
    await render(tab());
    expect($("[data-cost-missing-banner]")?.textContent).toMatch(
      /1 cost missing at Company default/,
    );
    await type($<HTMLInputElement>('[aria-label="Cost for CCF at company default"]')!, "70");
    await click(
      $('[aria-label="Labor class of PCT"]')!.parentElement!.querySelector(
        '[role="option"][data-value="field"]',
      )!,
    );
    await click(button("Save changes"));
    expect(state.saves).toEqual([
      {
        changes: [
          { op: "cost", item_key: "CCF", office_id: null, value: 70, effective_from: "" },
          { op: "labor_class", code: "PCT", class: "field" },
        ],
        note: "",
        rpc: "cost_save",
      },
    ]);
  });
});

describe("the overhead engine", () => {
  async function openEngine() {
    await render(tab());
    await click(button("Overhead engine"));
  }

  it("sums the components live and explains the year", async () => {
    await openEngine();
    expect($("[data-engine-total]")?.textContent).toContain("$49.50");
    expect($("[data-engine-why]")?.textContent).toMatch(/^Why \$45→\$49\.50: /);
    // The owner's old rate is kept, read only.
    expect(text()).toContain("Other labor rates on file (1)");
  });

  it("publishes only with a note, and sends the components, temp wage and a new one", async () => {
    await openEngine();
    await type(
      $<HTMLInputElement>('[aria-label="General liability per hour at Company default"]')!,
      "4",
    );
    expect($("[data-engine-total]")?.textContent).toContain("$50.50");
    await type($<HTMLInputElement>('[aria-label="Temp crew wage at Company default"]')!, "38");
    await type($<HTMLInputElement>('[placeholder="e.g. Vehicle allowance"]')!, "Vehicle allowance");
    await type($<HTMLInputElement>('[placeholder="0.00"]')!, "2");
    await click(button("Add component"));
    const save = button("Save changes");
    expect(save.disabled).toBe(true);
    await type($<HTMLInputElement>('[aria-label="Note for the change log"]')!, "2026 renewal");
    expect(button("Save changes").disabled).toBe(false);
    await click(button("Save changes"));
    expect(state.engineSaves).toEqual([
      {
        changes: [
          {
            op: "value",
            component: "general_liability",
            office_id: null,
            value: 4,
            effective_from: "",
          },
          { op: "add", name: "Vehicle allowance", note: "", value: 2, effective_from: "" },
          { op: "temp_wage", office_id: null, value: 38, effective_from: "" },
        ],
        note: "2026 renewal",
      },
    ]);
  });
});
