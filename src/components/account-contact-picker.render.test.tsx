// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BC-CON-1.1: the New Job form picks the carrier adjuster and the insurance
 * agent the same way the job page does — and its "+ Add" now checks for the
 * person before creating them, and is offered only to people allowed to add
 * to the firm. Drives the real AccountContactPicker; the popover is a plain
 * element and the data calls are mocked at the company-people boundary.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/integrations/supabase/client", () => {
  const rows = [
    { id: "liz", full_name: "Liz Agent", title: null, email: "liz@agency.com", phone: null },
  ];
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "order", "or"]) chain[k] = () => chain;
  chain.limit = async () => ({ data: rows, error: null });
  return { supabase: { from: () => chain } };
});
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "user-1", roles: ["office"], writesDisabled: false }),
}));
vi.mock("@/lib/account-types", () => ({
  useAccountTypes: () => ({ idForKey: () => "type-broker" }),
}));
vi.mock("@/components/ui/popover", () => {
  const Open = createContext<{ open: boolean; set: (o: boolean) => void }>({
    open: false,
    set: () => {},
  });
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (o: boolean) => void;
      children: ReactNode;
    }) => createElement(Open.Provider, { value: { open, set: onOpenChange } }, children),
    PopoverTrigger: function Trigger({ children }: { children: ReactNode }) {
      const ctx = useContext(Open);
      return createElement("span", { onClick: () => ctx.set(true) }, children);
    },
    PopoverContent: function Content({ children }: { children: ReactNode }) {
      return useContext(Open).open ? createElement("div", null, children) : null;
    },
  };
});

const people = vi.hoisted(() => ({
  canAddPeopleTo: vi.fn(),
  findExistingPerson: vi.fn(),
  createCompanyPerson: vi.fn(),
}));
vi.mock("@/lib/company-people", async (orig) => ({
  ...(await orig<typeof import("@/lib/company-people")>()),
  ...people,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/db-errors", () => ({ toastDbError: vi.fn() }));

import { AccountContactPicker } from "./account-contact-picker";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  people.canAddPeopleTo.mockResolvedValue(true);
  people.findExistingPerson.mockResolvedValue(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
function typeInto(input: HTMLInputElement, text: string) {
  act(() => {
    setNativeValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountAndOpen() {
  const onChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(AccountContactPicker, {
          label: "Agent",
          accountId: "agency-1",
          accountName: "Hudson Agency",
          value: null,
          onChange,
          defaultTitle: "Insurance agent",
          searchTypeKey: "insurance_broker",
        }),
      ),
    );
  });
  act(() => button("Find a person at Hudson Agency")!.click());
  await flush();
  return { onChange };
}

async function addNew(name: string, email: string) {
  act(() => button("Add someone at Hudson Agency")!.click());
  const inputs = container.querySelectorAll<HTMLInputElement>("input");
  const by = (ph: string) => [...inputs].find((i) => i.placeholder === ph)!;
  typeInto(by("Full name"), name);
  typeInto(by("Email"), email);
  await act(async () => button("Add and use")!.click());
  await flush();
}

describe("the New Job form's person picker", () => {
  it("saves a new agent under the agency with their title, then uses them", async () => {
    const created = {
      id: "new",
      full_name: "Sam Agent",
      title: "Insurance agent",
      email: "s@a.com",
      phone: null,
    };
    people.createCompanyPerson.mockResolvedValue(created);
    const { onChange } = await mountAndOpen();
    await addNew("Sam Agent", "s@a.com");
    expect(people.createCompanyPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "agency-1",
        full_name: "Sam Agent",
        title: "Insurance agent",
      }),
    );
    expect(onChange).toHaveBeenCalledWith(created);
  });

  it("links to an existing record instead of adding a duplicate", async () => {
    const liz = {
      id: "liz",
      full_name: "Liz Agent",
      title: null,
      email: "liz@agency.com",
      phone: null,
      position_key: null,
      account_id: "agency-1",
      account_name: "Hudson Agency",
      source: "contact" as const,
    };
    people.findExistingPerson.mockResolvedValue({ match: liz, by: "email" });
    const { onChange } = await mountAndOpen();
    await addNew("Elizabeth", "LIZ@agency.com");
    expect(container.querySelector("[data-picker-duplicate]")?.textContent).toContain("Liz Agent");
    expect(people.createCompanyPerson).not.toHaveBeenCalled();
    act(() => button("Use existing")!.click());
    expect(onChange).toHaveBeenCalledWith(liz);
    expect(people.createCompanyPerson).not.toHaveBeenCalled();
  });

  it("is picker-only for someone who may not add to the firm", async () => {
    people.canAddPeopleTo.mockResolvedValue(false);
    await mountAndOpen();
    expect(button("Add someone at Hudson Agency")).toBeUndefined();
    expect(button("Liz Agent")).toBeTruthy();
  });
});

describe("the New Job form's insurance section", () => {
  const src = readFileSync("src/routes/_authenticated/jobs.new.tsx", "utf8");

  it("has its own carrier adjuster picker, falling back to the desk adjuster", () => {
    expect(src).toMatch(/label="Carrier adjuster"/);
    expect(src).toMatch(
      /adjuster_name: insuranceJob\s*\?\s*\(\(adjusterContact \?\? deskContact\)/,
    );
  });

  it("picks the agency (an insurance_broker) and the agent there", () => {
    expect(src).toMatch(/typeKey="insurance_broker"/);
    expect(src).toMatch(/label="Agent"[\s\S]{0,200}accountId=\{agencyAccount\?\.id/);
    for (const col of [
      "insurance_agency_account_id",
      "insurance_agency:",
      "insurance_agent_name",
      "insurance_agent_email",
      "insurance_agent_phone",
    ]) {
      expect(src, col).toContain(col);
    }
  });

  it("links the records in their own update, skipped before the migration", () => {
    expect(src).toMatch(/links\.adjuster_contact_id = adjusterContact\.id/);
    expect(src).toMatch(/links\.insurance_agent_contact_id = agentContact\.id/);
    expect(src).toMatch(/!isMissingSchema\(linkErr\)/);
  });
});
