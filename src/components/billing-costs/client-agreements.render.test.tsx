// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing & Costs › Client Agreements, driven for real (prompt 4): the
 * regular-only caption, Standard rates per office with its save, the
 * agreement cards ("N items overridden · all others follow Standard") and an
 * agreement's exceptions save with its required note. Loaders and saves are
 * stubbed; the chain is in the pglite fixture.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  std: [] as { changes: unknown; note: string }[],
  agr: [] as { changes: unknown; note: string }[],
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => undefined,
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ realRoles: ["owner"], roles: ["owner"] }),
}));
vi.mock("@/components/account-picker", () => ({ AccountPicker: () => null }));
vi.mock("@/components/billing-costs/history", () => ({ HistoryButton: () => null }));
vi.mock("@/lib/agreements", async (orig) => {
  const real = await orig<typeof import("@/lib/agreements")>();
  const std = (item_key: string, office_id: string | null, value: number) => ({
    book: "client_agreements" as const,
    item_key,
    measure: "unit_price",
    office_id,
    effective_from: "2000-01-01",
    value,
  });
  return {
    ...real,
    loadAgreements: async () => ({
      available: true,
      items: [
        {
          id: "lab",
          code: "GSC-LABOR-REG",
          name: "Labor - regular",
          uom: "HR",
          active: true,
          sort_order: 10,
        },
        {
          id: "am",
          code: "GSC-EQ-AIR-MOVER",
          name: "Air mover",
          uom: "DAY",
          active: true,
          sort_order: 20,
        },
      ],
      standard: [
        std("GSC-LABOR-REG", null, 65),
        std("GSC-LABOR-REG", "nj", 70),
        std("GSC-EQ-AIR-MOVER", null, 45),
      ],
      offices: [{ id: "nj", name: "Lakewood", code: "NJ" }],
      agreements: [
        {
          id: "falcon",
          name: "Falcon",
          kind: "agreement",
          effectiveFrom: "2026-02-01",
          archived: false,
          fullCopy: false,
          lines: new Map([["GSC-LABOR-REG", 60]]),
          clients: [
            {
              assignmentId: "a1",
              accountId: "acc",
              accountName: "Falcon Insurance",
              effectiveFrom: "2026-02-01",
              effectiveTo: null,
              primary: true,
            },
          ],
          scopes: [],
        },
      ],
    }),
    loadJobMix: async () => new Map([["acc", { jobs: 4, tm_jobs: 1 }]]),
    saveStandard: async (changes: unknown, note: string) => {
      state.std.push({ changes, note });
      return (changes as unknown[]).length;
    },
    saveAgreements: async (changes: unknown, note: string) => {
      state.agr.push({ changes, note });
      return null;
    },
  };
});
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

import { ClientAgreementsTab } from "./client-agreements-tab";

let host: HTMLDivElement;
let root: Root;
async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client: qc }, createElement(ClientAgreementsTab)),
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.trim().startsWith(label),
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

beforeEach(() => {
  state.std = [];
  state.agr = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Client Agreements", () => {
  it("says it is for regular jobs, and opens on Standard rates", async () => {
    await render();
    expect($("[data-agreements-caption]")?.textContent).toContain(
      "Applies to regular jobs only — T&M jobs bill at T&M rates.",
    );
    expect($<HTMLInputElement>('[aria-label="Company Standard for GSC-LABOR-REG"]')!.value).toBe(
      "65.00",
    );
  });

  it("an office override saves for that office", async () => {
    await render();
    await click($('[aria-label="Office"]')!.parentElement!.querySelector('[data-value="nj"]')!);
    expect($<HTMLInputElement>('[aria-label="Lakewood price for GSC-LABOR-REG"]')!.value).toBe(
      "70.00",
    );
    await type($<HTMLInputElement>('[aria-label="Lakewood price for GSC-EQ-AIR-MOVER"]')!, "48");
    await click(button("Save changes"));
    expect(state.std).toEqual([
      { changes: [{ code: "GSC-EQ-AIR-MOVER", office_id: "nj", value: 48 }], note: "" },
    ]);
  });

  it("an agreement card counts its exceptions; saving keeps the note, or says what changed", async () => {
    await render();
    await click(button("Client agreements"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const card = $('[data-agreement-card="falcon"]')!;
    expect(card.textContent).toContain("1 item overridden · all others follow Standard");
    expect(card.textContent).toContain("Falcon Insurance");
    expect(card.textContent).toContain("4 jobs");
    await click(card);
    await click([...document.querySelectorAll("input[type=checkbox]")][0]!);
    await type($<HTMLInputElement>('[aria-label="Falcon price for GSC-EQ-AIR-MOVER"]')!, "40");
    expect($("[data-override-summary]")?.textContent).toContain("2 items overridden");
    // 4 Nov: the note is optional — Save is open without one.
    expect(button("Save 1 change").disabled).toBe(false);
    await type($<HTMLInputElement>('[aria-label="Note for the change log"]')!, "2026 renewal");
    await click(button("Save 1 change"));
    expect(state.agr).toEqual([
      {
        changes: [{ op: "line", agreement_id: "falcon", code: "GSC-EQ-AIR-MOVER", value: 40 }],
        note: "2026 renewal",
      },
    ]);
  });
});
