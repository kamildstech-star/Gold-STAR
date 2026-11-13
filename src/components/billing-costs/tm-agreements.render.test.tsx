// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * T&M Rates › Client agreements (BC-TM-AGR-1), driven for real: the T&M-only
 * caption, cards that follow T&M Rates, an agreement's exceptions saved to
 * the T&M store (never the regular one), and a T&M job's rate picker that
 * switches between its client's agreement and T&M Rates. Loaders and saves
 * are stubbed; the chain is in the pglite fixture.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  tm: [] as { changes: unknown; note: string }[],
  regular: [] as unknown[],
  jobSet: [] as { jobId: string; agreementId: string | null }[],
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => undefined,
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  },
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ realRoles: ["owner"], roles: ["owner"] }),
}));
vi.mock("@/components/account-picker", () => ({ AccountPicker: () => null }));
vi.mock("@/components/billing-costs/history", () => ({ HistoryButton: () => null }));
vi.mock("@/lib/agreements", async (orig) => {
  const real = await orig<typeof import("@/lib/agreements")>();
  return {
    ...real,
    loadJobMix: async () => new Map([["acc", { jobs: 5, tm_jobs: 4 }]]),
    saveAgreements: async (changes: unknown) => {
      state.regular.push(changes);
      return null;
    },
  };
});
vi.mock("@/lib/tm-agreements", async (orig) => {
  const real = await orig<typeof import("@/lib/tm-agreements")>();
  const rate = (item_key: string, value: number) => ({
    book: "tm_rates" as const,
    item_key,
    measure: "bill_rate",
    office_id: null,
    effective_from: "2000-01-01",
    value,
  });
  return {
    ...real,
    loadTmAgreements: async () => ({
      available: true,
      lens: { book: "tm_rates", measure: "bill_rate" },
      items: [
        {
          id: "PCT",
          code: "PCT",
          name: "Project Technician",
          uom: "hour",
          active: true,
          sort_order: 0,
        },
        {
          id: "EQ:air_scrubber",
          code: "EQ:air_scrubber",
          label: "Air scrubber",
          name: "Air scrubber — scanned units",
          uom: "unit-day",
          active: true,
          sort_order: 1,
        },
      ],
      standard: [rate("PCT", 91), rate("EQ:air_scrubber", 125)],
      offices: [],
      agreements: [
        {
          id: "falcon-tm",
          name: "Falcon T&M",
          kind: "agreement",
          effectiveFrom: "2026-10-01",
          archived: false,
          fullCopy: false,
          lines: new Map([["PCT", 80]]),
          clients: [
            {
              assignmentId: "c1",
              accountId: "acc",
              accountName: "Falcon Insurance",
              effectiveFrom: "2026-10-01",
              effectiveTo: null,
              primary: true,
            },
          ],
          scopes: [],
        },
      ],
    }),
    saveTmAgreements: async (changes: unknown, note: string) => {
      state.tm.push({ changes, note });
      return null;
    },
    loadJobTmAgreement: async () => ({
      available: true,
      agreementId: "falcon-tm",
      agreementName: "Falcon T&M",
      options: [{ id: "falcon-tm", name: "Falcon T&M", primary: true }],
    }),
    setJobTmAgreement: async (jobId: string, agreementId: string | null) => {
      state.jobSet.push({ jobId, agreementId });
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

import { TmClientAgreements } from "./client-agreements-tab";
import { JobRateSource } from "./job-rate-source";

let host: HTMLDivElement;
let root: Root;
async function render(el: ReturnType<typeof createElement>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, el)));
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
  state.tm = [];
  state.regular = [];
  state.jobSet = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("T&M client agreements", () => {
  it("is for T&M jobs, and a card follows T&M Rates", async () => {
    await render(createElement(TmClientAgreements));
    expect($("[data-tm-agreements]")?.textContent).toContain("Applies to T&M jobs only");
    const card = $('[data-agreement-card="falcon-tm"]')!;
    expect(card.textContent).toContain("1 item overridden · all others follow T&M Rates");
    expect(card.textContent).toContain("Falcon Insurance");
  });

  it("an agreement's exceptions save to the T&M store with a note", async () => {
    await render(createElement(TmClientAgreements));
    await click($('[data-agreement-card="falcon-tm"]')!);
    expect($("[data-agreement-dialog]")?.textContent).toContain("T&M $91.00");
    await click([...document.querySelectorAll("input[type=checkbox]")][0]!);
    expect($("[data-agreement-dialog]")?.textContent).toContain("Air scrubber");
    const eq = $<HTMLInputElement>('[aria-label="Falcon T&M price for EQ:air_scrubber"]')!;
    expect(eq.placeholder).toBe("follows T&M Rates");
    await type(eq, "110");
    await type($<HTMLInputElement>('[aria-label="Note for the change log"]')!, "2026 T&M sheet");
    await click(button("Save 1 change"));
    expect(state.tm).toEqual([
      {
        changes: [{ op: "line", agreement_id: "falcon-tm", code: "EQ:air_scrubber", value: 110 }],
        note: "2026 T&M sheet",
      },
    ]);
    expect(state.regular).toEqual([]);
  });

  it("a T&M job switches between its client's agreement and T&M Rates", async () => {
    await render(
      createElement(JobRateSource, { job: { id: "job-1", account_id: "acc", job_type: "t_m" } }),
    );
    expect($('[role="listbox"]')?.textContent).toContain("Falcon T&M (client agreement, primary)");
    await click($('[data-value="tm"]')!);
    expect(state.jobSet).toEqual([{ jobId: "job-1", agreementId: null }]);
  });

  it("a document shows the agreement as a tag", async () => {
    await render(
      createElement(JobRateSource, {
        job: { id: "job-1", account_id: "acc", job_type: "t_m" },
        compact: true,
      }),
    );
    expect($('[data-rate-source="tm"]')?.textContent).toContain(
      "T&M: Falcon T&M (client agreement)",
    );
    expect($('[role="listbox"]')).toBeNull();
  });
});
