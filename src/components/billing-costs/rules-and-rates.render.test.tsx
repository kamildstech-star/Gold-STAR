// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing & Costs › General rules and T&M Rates, driven for real (prompt 2):
 * the office switcher, inherited / overridden / missing cells, reset, the
 * compare view, the Save payloads, holiday input, the overtime choice and
 * added charges. The loaders and saves are stubbed — the arithmetic is in
 * tm-rates.test.ts / tm-bill-overtime.test.ts and the database in the pglite
 * fixtures. Radix select and the multi-select are plain elements here.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  rateSaves: [] as { changes: unknown; note: string }[],
  ruleSaves: [] as { rules: unknown; charges: unknown; note: string }[],
  legacy: false,
  roles: ["admin"] as string[],
  access: { seeCosts: true, editCosts: true, manageOverhead: true },
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => undefined,
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ realRoles: state.roles, roles: state.roles }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/billing-costs/cost-access", () => ({
  useCostAccess: () => state.access,
}));
vi.mock("@/lib/running-cost", () => ({ getMarginThreshold: async () => 30 }));
vi.mock("@/lib/catalog", async (orig) => ({
  ...(await orig<typeof import("@/lib/catalog")>()),
  loadCatalog: async () => ({
    fromDatabase: true,
    items: [
      {
        code: "GL",
        name: "General Labor",
        category: "labor",
        unit: "hr",
        unit_review: null,
        active: true,
        archived_at: null,
        sort_order: 10,
        updated_at: "",
      },
    ],
    tmCodes: new Map(),
  }),
}));
vi.mock("@/lib/tm-rates", async (orig) => {
  const real = await orig<typeof import("@/lib/tm-rates")>();
  const r = (
    item_key: string,
    office_id: string | null,
    value: number | null,
    effective_from = "2000-01-01",
  ) => ({
    book: "tm_rates" as const,
    item_key,
    measure: "bill_rate",
    office_id,
    effective_from,
    value,
  });
  const item = (key: string, name: string, over = {}) => ({
    key,
    code: key,
    name,
    category: "labor" as const,
    unitLabel: "per hour",
    active: true,
    archived: false,
    smallTools: true,
    ...over,
  });
  return {
    ...real,
    loadTmRates: async () => ({
      available: true,
      items: [
        item("GL", "General Labor"),
        item("SCL", "Structural Cleaning"),
        item("CCF", "Crew Chief"),
      ],
      rows: [
        r("GL", null, 70),
        r("GL", "nj", 65, "2026-06-01"),
        r("SCL", null, 88),
        r("CCF", "nj", 98),
      ],
      offices: [
        { id: "nj", name: "Lakewood", code: "NJ" },
        { id: "nc", name: "Garner", code: "NC" },
      ],
      otherRows: [
        {
          book: "cost" as const,
          item_key: "GL",
          measure: "cost_rate",
          office_id: null,
          effective_from: "2000-01-01",
          value: 45,
        },
      ],
      lastChange: null,
    }),
    saveTmRates: async (changes: unknown, note: string) => {
      state.rateSaves.push({ changes, note });
      return (changes as unknown[]).length;
    },
  };
});
vi.mock("@/lib/tm-bill-rules-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/tm-bill-rules-store")>()),
  loadGeneralRules: async () => ({
    fromStore: true,
    row: {
      standard_start: "08:00",
      standard_end: "17:00",
      overtime_mode: state.legacy ? "legacy_both" : "none",
      daily_ot_after_hours: state.legacy ? 8 : null,
      weekly_ot_after_hours: 40,
      weekend_days: [0, 6],
      holidays: ["2026-12-25"],
      ot_multiplier: 1.5,
      after_hours_multiplier: 1.5,
      weekend_multiplier: 1.5,
      holiday_multiplier: 2,
      field_form_code: null,
      legacy_tax_percent: 8.875,
      legacy_taxable_categories: ["materials"],
      updated_at: "",
    },
    charges: [
      {
        key: "small_tools",
        name: "Small Tools",
        kind: "pct_labor",
        value: 3,
        lands_on: "assoc_labor_fees",
        system: true,
        active: true,
        archived_at: null,
        sort_order: 10,
      },
      {
        key: "per_diem",
        name: "Per Diem",
        kind: "flat_person_day",
        value: null,
        lands_on: "assoc_labor_fees",
        system: true,
        active: true,
        archived_at: null,
        sort_order: 20,
      },
    ],
  }),
  saveGeneralRules: async (_c: unknown, rules: unknown, charges: unknown, note: string) => {
    state.ruleSaves.push({ rules, charges, note });
    return 1;
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

import { RulesPanel } from "./rules-panel";
import { TmRatesTab } from "./tm-rates-tab";

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
  [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
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
const pickOffice = (id: string) =>
  click(
    $(`[aria-label="Office"]`)!.parentElement!.querySelector(
      `[role="option"][data-value="${id}"]`,
    )!,
  );

beforeEach(() => {
  state.rateSaves = [];
  state.ruleSaves = [];
  state.legacy = false;
  state.roles = ["admin"];
  state.access = { seeCosts: true, editCosts: true, manageOverhead: true };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("T&M Rates", () => {
  const tab = () => createElement(TmRatesTab, { category: "labor", onCategory: () => {} });

  it("says which offices have gaps (in the by-office dialog), and the margin against the cost", async () => {
    await render(tab());
    // Inline: only the compact summary; the per-office lines live in the dialog.
    expect($("[data-tm-health]")?.textContent).toMatch(/Company default: \d+ of \d+ priced/);
    expect($("[data-tm-health]")?.textContent).toMatch(/1 with gaps/);
    expect(document.querySelector("[data-tm-office-banner]")).toBeNull();
    await click($("[data-tm-by-office]")!);
    const lines = document.querySelector("[data-tm-office-banner]")?.textContent;
    expect(lines).toMatch(/NJ\s*complete \(2 overrides\)/);
    expect(lines).toMatch(/NC\s*1 rate missing/);
    // GL $70 against a $45 cost: 35.7% — above the 30% floor
    expect($('[data-tm-rate-row="GL"]')?.textContent).toContain("35.7%");
  });

  it("an office shows its override dotted with a reset, and inherited rates as 'from default'", async () => {
    await render(tab());
    await pickOffice("nj");
    const gl = $<HTMLInputElement>('[aria-label="Rate for GL at this office"]')!;
    expect(gl.value).toBe("65.00");
    expect(gl.className).toContain("border-dashed");
    expect($('[aria-label="Reset GL to the company default"]')).not.toBeNull();
    expect($('[data-tm-rate-row="SCL"]')?.textContent).toContain("from default");
  });

  it("typing at an office saves that office's override with the note", async () => {
    await render(tab());
    await pickOffice("nc");
    await type($<HTMLInputElement>('[aria-label="Rate for GL at this office"]')!, "68");
    await type($<HTMLInputElement>('[aria-label="Note for the change log"]')!, "NC agreement");
    await click(button("Save changes"));
    expect(state.rateSaves).toEqual([
      {
        changes: [{ op: "rate", item_key: "GL", office_id: "nc", value: 68, effective_from: "" }],
        note: "NC agreement",
      },
    ]);
  });

  it("reset sends the office back to the default", async () => {
    await render(tab());
    await pickOffice("nj");
    await click($('[aria-label="Reset GL to the company default"]')!);
    await click(button("Save changes"));
    expect(state.rateSaves[0]?.changes).toEqual([
      { op: "rate", item_key: "GL", office_id: "nj", value: null, effective_from: "" },
    ]);
  });

  it("a blank company default is refused with the reason", async () => {
    await render(tab());
    await type($<HTMLInputElement>('[aria-label="Rate for GL at company default"]')!, "");
    expect(text()).toContain("The company default needs a rate");
    expect(button("Save changes").disabled).toBe(true);
  });

  it("Small Tools is switched per labor title", async () => {
    await render(tab());
    await click($('[aria-label="Small Tools on GL"]')!);
    await click(button("Save changes"));
    expect(state.rateSaves[0]?.changes).toEqual([{ op: "small_tools", code: "GL", on: false }]);
  });

  it("compare offices shows gaps in red and overrides highlighted", async () => {
    await render(tab());
    await click(button("Compare offices"));
    const table = $("[data-tm-compare]")!;
    const ccf = [...table.querySelectorAll("tr")].find((r) =>
      r.textContent?.includes("Crew Chief"),
    )!;
    const cells = [...ccf.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells).toEqual(["—", "$98.00", "—"]);
    expect(ccf.querySelectorAll("td")[1]!.className).toContain("outline-dashed");
  });
});

describe("T&M Rates — by-office dialog and pages", () => {
  it("a square closes the dialog and shows that office's gaps in that category", async () => {
    const picked: string[] = [];
    await render(
      createElement(TmRatesTab, { category: "labor", onCategory: (c) => picked.push(c) }),
    );
    await click($("[data-tm-by-office]")!);
    await click(document.querySelector('[aria-label="NC Labor: 1 missing"]')!);
    expect(document.querySelector("[data-tm-office-banner]")).toBeNull();
    expect(picked).toEqual(["labor"]);
    // Filtered to NC's one missing labor rate.
    expect($("[data-pager]")?.textContent).toMatch(/1–1 of 1 Labor items/);
    expect($('[aria-label="Rate for GL at this office"]')).toBeNull();
  });

  it("counts the rows it shows, out of every row the filters match", async () => {
    await render(createElement(TmRatesTab, { category: "labor", onCategory: () => {} }));
    expect($("[data-pager]")?.textContent).toMatch(/1–\d+ of \d+ Labor items/);
  });
});

describe("T&M Rules (was General rules)", () => {
  const tab = () => createElement(RulesPanel, { part: "tm" });

  it("T&M Rules holds the bill's charges and time rules; Cost Rules holds only the margin guard", async () => {
    await render(tab());
    expect($("[data-general-charges]")).not.toBeNull();
    expect($("[data-general-time]")).not.toBeNull();
    expect($("[data-general-margin]")).toBeNull();
    await render(createElement(RulesPanel, { part: "cost" }));
    expect($("[data-general-margin]")).not.toBeNull();
    expect($("[data-general-charges]")).toBeNull();
    expect($("[data-general-time]")).toBeNull();
  });

  it("has no tax anywhere", async () => {
    await render(tab());
    expect(text().toLowerCase()).not.toMatch(/\btax\b(?! stays)/);
    expect($('[aria-label*="tax" i]')).toBeNull();
  });

  it("refuses a bad holiday date, takes a good one as MM/DD/YYYY", async () => {
    await render(tab());
    expect(text()).toContain("12/25/2026");
    await type($<HTMLInputElement>('[aria-label="Add a holiday date"]')!, "02/30/2027");
    await click(button("Add holiday"));
    expect(text()).toContain("Enter a real date as MM/DD/YYYY");
    await type($<HTMLInputElement>('[aria-label="Add a holiday date"]')!, "1/1/2027");
    await click(button("Add holiday"));
    expect(text()).toContain("01/01/2027");
    expect(text()).toContain("1 unsaved change");
  });

  it("saves the overtime choice and an added charge in one go", async () => {
    await render(tab());
    await click($('[id="ot-weekly"]')!);
    await click(button("Add charge"));
    await click(button("Save changes"));
    expect(state.ruleSaves).toEqual([]);
    expect(text()).toContain("Give the charge a name.");
    await type($<HTMLInputElement>('[aria-label="New charge name"]')!, "Fuel");
    await click($('[data-charge-new] [role="option"][data-value="flat_bill"]')!);
    await type($<HTMLInputElement>('[aria-label="New charge value"]')!, "35");
    await click($('[data-charge-new] [role="option"][data-value="other_fees"]')!);
    await type($<HTMLInputElement>('[aria-label="Value of Small Tools"]')!, "3.5");
    await click(button("Save changes"));
    expect(state.ruleSaves).toEqual([
      {
        rules: { overtime_mode: "weekly" },
        charges: [
          { op: "create", name: "Fuel", kind: "flat_bill", value: 35, lands_on: "other_fees" },
          { op: "update", key: "small_tools", value: 3.5 },
        ],
        note: "",
      },
    ]);
  });

  it("a Settings carried with both overtime rules says so, and still lets other changes save", async () => {
    state.legacy = true;
    await render(tab());
    expect(text()).toContain("applied both a daily threshold and after-hours");
    await type($<HTMLInputElement>('[aria-label="Value of Small Tools"]')!, "3.5");
    expect(button("Save changes").disabled).toBe(false);
  });
});

describe("for a role that may not change rates or rules", () => {
  it("T&M Rates read as text, with no Cost or Margin column for someone who may not see costs", async () => {
    state.roles = ["sales"];
    state.access = { seeCosts: false, editCosts: false, manageOverhead: false };
    await render(createElement(TmRatesTab, { category: "labor", onCategory: () => {} }));
    const gl = $('[data-tm-rate-row="GL"]')!;
    expect(gl.querySelector("input")).toBeNull();
    expect(gl.querySelector('[role="switch"]')).toBeNull();
    expect($('[data-rate-text="GL"]')?.textContent).toBe("$70.00");
    expect(text()).not.toContain("Margin");
    expect(text()).not.toContain("Read only");
    expect(text()).not.toContain("Add item");
    expect(host.querySelector("[data-tm-rate-row] [disabled]")).toBeNull();
  });

  it("the T&M rules read as text: no boxes, no lock line, no Save", async () => {
    state.roles = ["office"];
    await render(createElement(RulesPanel, { part: "tm" }));
    const time = $("[data-general-time]")!;
    expect(time.querySelector("input, [role='checkbox'], [role='radio']")).toBeNull();
    expect(time.textContent).toContain("8:00 AM to 5:00 PM");
    expect(time.textContent).toContain("Sun, Sat");
    expect(time.textContent).toContain("No overtime");
    expect($("[data-general-charges]")?.querySelector("input")).toBeNull();
    expect(text()).not.toContain("Read only");
    expect(button("Save changes")).toBeUndefined();
    expect(host.querySelector("[disabled]")).toBeNull();
  });
});
