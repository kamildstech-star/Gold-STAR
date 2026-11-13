// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contacts tab › "Pick people from": besides the client, the firms on the
 * job's Insurance card (carrier, public adjusting firm…) list their people, so
 * an adjuster or PA is added to the job without being typed. Picking adds
 * them at once (4 Nov). The picker itself is stubbed (its own test drives it).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  firms: [] as unknown[],
  account: "client-1" as string | null,
  inserted: [] as Record<string, unknown>[],
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/db-errors", () => ({ toastDbError: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        state.inserted.push(row);
        return { error: null };
      },
    }),
  },
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ roles: ["office"], realRoles: ["office"], userId: "u1" }),
}));
vi.mock("@/lib/option-lists", () => ({
  useOptionList: () => ({
    options: [
      { key: "customer", label: "Customer" },
      { key: "desk_adjuster", label: "Desk Adjuster" },
      { key: "public_adjuster", label: "Public Adjuster" },
    ],
  }),
  optionLabel: (_o: unknown, k: string) => k,
}));
vi.mock("@/lib/managed-options", async (orig) => ({
  ...(await orig<typeof import("@/lib/managed-options")>()),
  useManagedOptions: () => ({ options: [], labelOf: (k: string) => k }),
}));
vi.mock("@/lib/company-people", async (orig) => ({
  ...(await orig<typeof import("@/lib/company-people")>()),
  canAddPeopleTo: async () => false,
  fetchPickablePeople: async () => [],
}));
vi.mock("@/lib/job-relationships", async (orig) => ({
  ...(await orig<typeof import("@/lib/job-relationships")>()),
  fetchJobContacts: async () => [],
  fetchLinkedCrmContacts: async () => new Map(),
  fetchJobContactOrigin: async () => ({
    customer_name: "Falcon Mgmt",
    account_id: state.account,
    account_name: state.account ? "Falcon Mgmt" : null,
    primary_contact: null,
  }),
  fetchJobFirms: async () => state.firms,
}));
vi.mock("@/components/company-person-picker", () => ({
  companyPeopleKey: (id: string | null) => ["company-people", id],
  CompanyPersonPicker: ({
    accountId,
    accountName,
    onPick,
  }: {
    accountId: string;
    accountName: string | null;
    onPick: (p: unknown) => void;
  }) =>
    createElement(
      "button",
      {
        "data-picker": accountId,
        onClick: () =>
          onPick({
            id: `person-at-${accountId}`,
            account_id: accountId,
            account_name: accountName,
            full_name: "Pat Adjuster",
            email: "pat@firm.test",
            phone: "555-0100",
            position_key: null,
          }),
      },
      `Pick from ${accountName}`,
    ),
}));
vi.mock("@/components/create-customer-dialog", () => ({ CreateCustomerDialog: () => null }));
vi.mock("@/components/site-escalation-card", () => ({ SiteEscalationCard: () => null }));
vi.mock("@/components/ui/select", () => {
  const Pick = createContext<(v: string) => void>(() => {});
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: ReactNode;
      value: string;
      onValueChange: (v: string) => void;
    }) =>
      createElement(
        Pick.Provider,
        { value: onValueChange },
        createElement("div", { "data-select-value": value }, children),
      ),
    SelectTrigger: ({ children, ...p }: { children: ReactNode }) =>
      createElement("div", p, children),
    SelectValue: () => null,
    SelectSeparator: () => null,
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

import { JobContactsTab } from "./job-contacts-tab";

let host: HTMLDivElement;
let root: Root;
async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(JobContactsTab, { jobId: "j1" }),
      ),
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}
const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}
const carrier = {
  slot: "carrier",
  label: "Insurance carrier",
  noun: "carrier",
  role: "desk_adjuster",
  accountId: "carrier-1",
  accountName: "Allstate",
};
const paFirm = {
  slot: "public_adjuster",
  label: "Public adjusting firm",
  noun: "public adjusting firm",
  role: "public_adjuster",
  accountId: "pa-1",
  accountName: "Adjusters Inc",
};

beforeEach(() => {
  state.firms = [carrier, paFirm];
  state.account = "client-1";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Contacts tab › pick people from the client or an insurance firm", () => {
  it("offers the client, the carrier and the PA firm, starting on the client", async () => {
    await render();
    const options = [...document.querySelectorAll("[role=option]")]
      .map((o) => o.textContent)
      .filter((t) => t?.includes("·"));
    expect(options).toEqual([
      "Client · Falcon Mgmt",
      "Insurance carrier · Allstate",
      "Public adjusting firm · Adjusters Inc",
    ]);
    expect($("[data-picker]")?.getAttribute("data-picker")).toBe("client-1");
  });

  it("picking from the PA firm adds the person at once, in the PA role", async () => {
    await render();
    await click($('[role=option][data-value="pa-1"]')!);
    expect($("[data-picker]")?.getAttribute("data-picker")).toBe("pa-1");
    state.inserted.length = 0;
    await click($('[data-picker="pa-1"]')!);
    await act(async () => {});
    expect(state.inserted).toEqual([
      expect.objectContaining({
        full_name: "Pat Adjuster",
        contact_id: "person-at-pa-1",
        email: "pat@firm.test",
        phone: "555-0100",
        role: "public_adjuster",
      }),
    ]);
  });

  it("with no client account, the insurance firms are still offered", async () => {
    state.account = null;
    state.firms = [carrier];
    await render();
    expect($("[data-picker]")?.getAttribute("data-picker")).toBe("carrier-1");
  });

  it("with no account and no firms, it says to type the person", async () => {
    state.account = null;
    state.firms = [];
    await render();
    expect($("[data-picker]")).toBeNull();
    expect(document.body.textContent).toContain("no company or insurance firms yet");
  });
});
