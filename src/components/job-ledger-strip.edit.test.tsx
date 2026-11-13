// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Job ledger strip's cells, driven like a sheet. Mark, 2026-10-07: "can
 * we make each box editable".
 *
 * Real React, real TanStack Query, the real strip and cells. The ledger's
 * reads are answered from a seeded cache (nothing fetches), and the one
 * module that writes — job-ledger-overrides — is replaced by an in-memory
 * table, so what is asserted is exactly what would be sent to the database.
 * No DOM testing library, per the brief: `react-dom/client` and `act`, as in
 * number-input.caret.test.tsx.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; the strip only uses it for its edge fade.
class NoResize {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = NoResize;

const store = vi.hoisted(() => ({
  available: true,
  rows: new Map<string, number>(),
  saves: [] as { cell: string; value: number }[],
  clears: [] as string[],
  fail: false,
}));

vi.mock("@/lib/job-ledger-overrides", () => ({
  LEDGER_OVERRIDES_KEY: (jobId: string) => ["job-ledger-overrides", jobId],
  fetchLedgerOverrides: async () => ({
    available: store.available,
    values: Object.fromEntries([...store.rows].map(([k, v]) => [k, { value: v }])),
  }),
  saveLedgerOverride: async (_job: string, cell: string, value: number) => {
    if (store.fail) throw Object.assign(new Error("denied"), { code: "42501" });
    store.saves.push({ cell, value });
    store.rows.set(cell, value);
  },
  clearLedgerOverride: async (_job: string, cell: string) => {
    store.clears.push(cell);
    store.rows.delete(cell);
  },
}));

const ctx = vi.hoisted(() => ({ roles: ["owner"] as string[], writesDisabled: false }));
vi.mock("@/components/app-context", () => ({ useAppContext: () => ctx }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/db-errors", () => ({ toastDbError: vi.fn() }));

import { JobLedgerStrip } from "./job-ledger-panel";

const JOB = "job-1";
const COST = {
  labour_cost: 9000,
  field_ticket_labour_cost: 1000,
  equipment_cost: 2500,
  field_ticket_equipment_cost: 500,
  materials_cost: 700,
  stock_used_cost: 300,
  subcontractor_cost: 0,
  referral_cost: 0,
  total_cost: 14000,
  revenue: 30000,
  revenue_basis: "invoice",
};

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

async function mount(opts: { showMoney?: boolean } = {}) {
  qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
  });
  qc.setQueryData(["job-running-cost", JOB], COST);
  qc.setQueryData(["job-ledger-effort", JOB], { days: 3, crew: 4, personHours: 96 });
  qc.setQueryData(["job-commission", JOB], {
    commission_source: null,
    commission_rate_pct: null,
    paidTracked: false,
  });
  qc.setQueryData(["commission-rates"], []);
  qc.setQueryData(["job-ledger-invoices", JOB], { billed: 25000, paid: 10000 });
  qc.setQueryData(["job-ledger-overrides", JOB], {
    available: store.available,
    values: Object.fromEntries([...store.rows].map(([k, v]) => [k, { value: v }])),
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(JobLedgerStrip, { jobId: JOB, showMoney: opts.showMoney ?? true }),
      ),
    );
  });
}

const cell = (key: string) =>
  container.querySelector<HTMLButtonElement>(`[data-ledger-cell="${key}"]`);
const input = (key: string) =>
  container.querySelector<HTMLInputElement>(`[data-ledger-input="${key}"]`);
const td = (label: string) => {
  const ths = [...container.querySelectorAll("th")];
  const i = ths.findIndex((th) => th.textContent === label);
  return container.querySelectorAll("tbody td")[i] as HTMLTableCellElement;
};

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
async function type(el: HTMLInputElement, text: string) {
  await act(async () => {
    setNativeValue.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}
async function key(el: HTMLElement, k: string, shiftKey = false) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));
  });
}
async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}
/** Let the mutation and the refetch it triggers settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  store.available = true;
  store.rows = new Map();
  store.saves = [];
  store.clears = [];
  store.fail = false;
  ctx.roles = ["owner"];
  ctx.writesDisabled = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("typing into the ledger strip", () => {
  it("opens a cell in place, saves on Enter, and moves both totals at once", async () => {
    await mount();
    await click(cell("garbage")!);
    const box = input("garbage")!;
    expect(box).not.toBeNull();
    expect(document.activeElement).toBe(box);
    await type(box, "350");
    await key(box, "Enter");
    await settle();

    expect(store.saves).toEqual([{ cell: "garbage", value: 350 }]);
    expect(input("garbage")).toBeNull();
    expect(td("Garbage").textContent).toContain("$350");
    expect(td("Garbage").getAttribute("data-manual")).toBe("true");
    // 14,000 + 350; profit 30,000 − 14,000 − 350 (no commission set).
    expect(td("Total Expenses").textContent).toContain("$14,350");
    expect(td("Total Profit").textContent).toContain("$15,650");
    // The keyboard goes back to the cell it left.
    expect(document.activeElement).toBe(cell("garbage"));
  });

  it("overrides a calculated cell, marks it manual with the calculated figure, and reverts", async () => {
    await mount();
    await click(cell("equipment")!);
    await type(input("equipment")!, "2000");
    await key(input("equipment")!, "Enter");
    await settle();

    expect(store.saves).toEqual([{ cell: "equipment", value: 2000 }]);
    const eq = td("Equipment");
    expect(eq.title).toContain("Manual figure");
    expect(eq.title).toContain("Calculated: $3,000");
    expect(eq.textContent).toContain("(manual)");
    expect(td("Total Expenses").textContent).toContain("$13,000");

    const back = container.querySelector<HTMLButtonElement>('[data-ledger-revert="equipment"]')!;
    expect(back.getAttribute("aria-label")).toBe("Back to calculated ($3,000)");
    await click(back);
    await settle();
    expect(store.clears).toEqual(["equipment"]);
    expect(td("Equipment").textContent).toContain("$3,000");
    expect(td("Equipment").hasAttribute("data-manual")).toBe(false);
    expect(td("Total Expenses").textContent).toContain("$14,000");
  });

  it("puts the cell back on Esc and saves nothing", async () => {
    await mount();
    await click(cell("labor")!);
    await type(input("labor")!, "1");
    await key(input("labor")!, "Escape");
    await settle();
    expect(store.saves).toEqual([]);
    expect(input("labor")).toBeNull();
    expect(td("Labor").textContent).toContain("$10,000");
  });

  it("saves and moves to the next cell you can type in on Tab, and back on Shift+Tab", async () => {
    await mount();
    await click(cell("labor")!);
    await type(input("labor")!, "9500");
    await key(input("labor")!, "Tab");
    // Total Expenses is skipped: the next typeable cell is Billed.
    expect(input("labor")).toBeNull();
    expect(input("billed")).not.toBeNull();
    expect(document.activeElement).toBe(input("billed"));
    await key(input("billed")!, "Tab", true);
    expect(input("labor")).not.toBeNull();
    await key(input("labor")!, "Escape");
    await settle();
    expect(store.saves).toEqual([{ cell: "labor", value: 9500 }]);
  });

  it("does not pin a calculated figure that was retyped as it was", async () => {
    await mount();
    await click(cell("supplies")!);
    await key(input("supplies")!, "Enter");
    await settle();
    expect(store.saves).toEqual([]);
  });

  it("says when a save is refused and puts the figure back", async () => {
    store.fail = true;
    await mount();
    await click(cell("truck_fee")!);
    await type(input("truck_fee")!, "75");
    await key(input("truck_fee")!, "Enter");
    await settle();
    expect(td("Truck Fee").textContent).toContain("Not saved");
    expect(td("Truck Fee").hasAttribute("data-manual")).toBe(false);
    expect(td("Total Expenses").textContent).toContain("$14,000");
  });

  it("keeps Referral and Commission read-only, pointing at the Commissions card", async () => {
    await mount();
    expect(cell("referral")).toBeNull();
    expect(cell("commission")).toBeNull();
    expect(td("Commission").title).toContain("Set on the Commissions card");
    expect(td("Billed").title).toContain("no invoice or payment is created, changed or deleted");
  });

  it("never types a total: clicking one opens what adds up to it", async () => {
    await mount();
    expect(cell("total_expenses")).toBeNull();
    expect(cell("profit")).toBeNull();
    const total = container.querySelector<HTMLButtonElement>('[data-ledger-total="profit"]')!;
    expect(total.getAttribute("aria-label")).toBe("Total Profit: what adds up to it");
    await click(total);
    expect(document.body.textContent).toContain("Revenue");
    expect(document.body.textContent).toContain("isn't typed itself");
  });
});

describe("clicking anywhere in a cell's box", () => {
  /** The column header for a label: the top half of the cell's box. */
  const th = (label: string) =>
    [...container.querySelectorAll("th")].find((h) => h.textContent === label)!;

  it("opens a typeable cell from its label", async () => {
    await mount();
    await click(th("Garbage"));
    expect(input("garbage")).not.toBeNull();
    expect(document.activeElement).toBe(input("garbage"));
  });

  it("opens a typeable cell from the empty part of its box, not just the figure", async () => {
    await mount();
    await click(td("Truck Fee"));
    expect(input("truck_fee")).not.toBeNull();
    await type(input("truck_fee")!, "80");
    await key(input("truck_fee")!, "Enter");
    await settle();
    expect(store.saves).toEqual([{ cell: "truck_fee", value: 80 }]);
  });

  it("marks only typeable cells as click targets", async () => {
    await mount();
    expect(th("Labor").className).toContain("cursor-pointer");
    expect(td("Labor").className).toContain("cursor-pointer");
    for (const label of ["Total Expenses", "Total Profit", "Referral", "Commission"]) {
      expect(th(label).className).not.toContain("cursor-pointer");
      expect(td(label).className).not.toContain("cursor-pointer");
    }
  });

  it("does not open a read-only cell from its box", async () => {
    await mount();
    for (const label of ["Referral", "Commission", "Total Expenses", "Total Profit"]) {
      await click(th(label));
      await click(td(label));
    }
    expect(container.querySelector("[data-ledger-input]")).toBeNull();
    expect(store.saves).toEqual([]);
  });

  it("keeps a total's breakdown on click, from the figure as before", async () => {
    await mount();
    await click(
      container.querySelector<HTMLButtonElement>('[data-ledger-total="total_expenses"]')!,
    );
    expect(document.body.textContent).toContain("isn't typed itself");
    expect(container.querySelector("[data-ledger-input]")).toBeNull();
  });

  it("does not reopen the cell when Back to calculated is pressed", async () => {
    store.rows.set("equipment", 2000);
    await mount();
    await click(container.querySelector<HTMLButtonElement>('[data-ledger-revert="equipment"]')!);
    await settle();
    expect(store.clears).toEqual(["equipment"]);
    expect(input("equipment")).toBeNull();
  });

  it("opens nothing from a cell's box for someone who cannot type", async () => {
    ctx.roles = ["office"];
    await mount();
    await click(th("Garbage"));
    await click(td("Garbage"));
    expect(container.querySelector("[data-ledger-input]")).toBeNull();
    expect(th("Garbage").className).not.toContain("cursor-pointer");
  });

  it("leaves the figure button as the keyboard's way in, named for its column", async () => {
    await mount();
    const btn = cell("garbage")!;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("aria-label")).toBe("Edit Garbage");
    expect(btn.getAttribute("type")).toBe("button");
  });
});

describe("who can type", () => {
  it("shows no editing to someone without the money-write right", async () => {
    ctx.roles = ["office"];
    await mount();
    expect(container.querySelector("[data-ledger-cell]")).toBeNull();
    expect(container.querySelector("[data-ledger-revert]")).toBeNull();
    expect(td("Garbage").textContent).toBe("—");
  });

  it("shows no editing while viewing as someone else", async () => {
    ctx.writesDisabled = true;
    await mount();
    expect(container.querySelector("[data-ledger-cell]")).toBeNull();
  });

  it("shows no editing to a viewer without cost access, who sees only the effort", async () => {
    await mount({ showMoney: false });
    expect(container.querySelectorAll("th")).toHaveLength(3);
    expect(container.querySelector("[data-ledger-cell]")).toBeNull();
  });

  it("is read-only, and says so, until the migration is applied", async () => {
    store.available = false;
    await mount();
    expect(container.querySelector("[data-ledger-cell]")).toBeNull();
    expect(td("Garbage").title).toContain("not available yet");
    // Someone who could never type is not told it is coming.
    ctx.roles = ["office"];
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(td("Garbage").title ?? "").not.toContain("not available yet");
  });
});
