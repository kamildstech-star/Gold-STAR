// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Spec BC-CON-1, "pick from the company, don't retype": the real picker and
 * its New form, driven the way an office user would. The popover and cmdk are
 * swapped for plain elements — what is under test is what a pick, a save and
 * a duplicate do, not how Radix positions a popup in jsdom. The data calls
 * are mocked at the company-people boundary, whose rules are pinned in
 * lib/company-people.test.ts.
 *
 * No DOM testing library, per the brief: `react-dom/client` and `act`.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "user-1", roles: ["office"], writesDisabled: false }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/managed-options", async (orig) => ({
  ...(await orig<typeof import("@/lib/managed-options")>()),
  useManagedOptions: (_k: string, fallback: { key: string; label: string }[]) => ({
    options: fallback,
    keys: fallback.map((o) => o.key),
    label: (k: string | null | undefined) => fallback.find((o) => o.key === k)?.label ?? k ?? "",
  }),
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
      return useContext(Open).open ? createElement("div", { role: "dialog" }, children) : null;
    },
  };
});
vi.mock("@/components/ui/command", () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Command: Pass,
    CommandList: Pass,
    CommandGroup: Pass,
    CommandEmpty: Pass,
    CommandInput: ({
      value,
      onValueChange,
    }: {
      value: string;
      onValueChange: (v: string) => void;
    }) =>
      createElement("input", {
        "data-search": "",
        value,
        onChange: (e: { target: { value: string } }) => onValueChange(e.target.value),
      }),
    CommandItem: ({
      children,
      onSelect,
      ...rest
    }: {
      children: ReactNode;
      onSelect: () => void;
      [k: string]: unknown;
    }) =>
      createElement(
        "div",
        { role: "option", onClick: onSelect, "data-picker-person": rest["data-picker-person"] },
        children,
      ),
  };
});

const people = vi.hoisted(() => ({
  fetchPickablePeople: vi.fn(),
  canAddPeopleTo: vi.fn(),
  findExistingPerson: vi.fn(),
  createCompanyPerson: vi.fn(),
}));
vi.mock("@/lib/company-people", async (orig) => ({
  ...(await orig<typeof import("@/lib/company-people")>()),
  ...people,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/db-errors", () => ({ toastDbError: vi.fn() }));

import { CompanyPersonPicker } from "./company-person-picker";
import type { CompanyPerson } from "@/lib/company-people";

const AJH_ID = "e3736f0c-0252-4219-a16e-d3ed0f3984d0";
const person = (id: string, full_name: string, over: Partial<CompanyPerson> = {}) =>
  ({
    id,
    full_name,
    title: null,
    position_key: null,
    email: null,
    phone: null,
    account_id: AJH_ID,
    account_name: "AJH Management",
    source: "contact",
    ...over,
  }) as CompanyPerson;
const LIZ = person("liz", "Liz Pedrogo", {
  email: "liz@ajhmgmt.com",
  phone: "845-555-0101",
  position_key: "regional",
});
const CHAIM = person("chaim", "Chaim Wienberg", { phone: "845-555-0199" });
const YANKY = person("yanky", "Yanky Gelbwachs", { source: "property" });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  people.fetchPickablePeople.mockResolvedValue([CHAIM, LIZ, YANKY]);
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

/* React Query hands results over on a zero-delay timeout, not a microtask. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

function mount(props: Partial<Parameters<typeof CompanyPersonPicker>[0]> = {}) {
  const onPick = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(CompanyPersonPicker, {
          accountId: AJH_ID,
          accountName: "AJH Management",
          onPick,
          askPosition: true,
          ...props,
        }),
      ),
    );
  });
  return { onPick };
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
function typeInto(input: HTMLInputElement, text: string) {
  act(() => {
    setNativeValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open() {
  act(() => button("Pick from AJH Management")!.click());
  await flush();
}

describe("picking a person at the job's company", () => {
  it("lists the company's people with email and phone under each name", async () => {
    mount();
    await open();
    const rows = [...container.querySelectorAll("[data-picker-person]")];
    expect(rows.map((r) => r.getAttribute("data-picker-person"))).toEqual([
      "chaim",
      "liz",
      "yanky",
    ]);
    expect(rows[1]!.textContent).toContain("liz@ajhmgmt.com · 845-555-0101");
    expect(rows[1]!.textContent).toContain("Regional manager");
    expect(rows[2]!.textContent).toContain("Building staff");
  });

  it("narrows as you type and fills from the record on pick", async () => {
    const { onPick } = mount();
    await open();
    typeInto(container.querySelector<HTMLInputElement>("[data-search]")!, "pedro");
    const rows = container.querySelectorAll("[data-picker-person]");
    expect(rows).toHaveLength(1);
    await act(async () => (rows[0] as HTMLElement).click());
    expect(onPick).toHaveBeenCalledWith(LIZ, { created: false });
  });

  it("asks for the company first when there is none, and still allows typing", async () => {
    mount({ accountId: null, accountName: null, companyNoun: "carrier" });
    act(() => button("Pick a person")!.click());
    await flush();
    expect(container.querySelector("[data-picker-needs-company]")?.textContent).toContain(
      "Choose the carrier first",
    );
    expect(people.fetchPickablePeople).not.toHaveBeenCalled();
  });
});

describe("+ New saves the person back to the company", () => {
  it("creates them under the company with position, then fills", async () => {
    const created = person("new-1", "Dana Ruiz", { email: "dana@ajhmgmt.com" });
    people.createCompanyPerson.mockResolvedValue(created);
    const { onPick } = mount({ newTitle: "Property manager" });
    await open();
    typeInto(container.querySelector<HTMLInputElement>("[data-search]")!, "Dana Ruiz");
    act(() => button("New: add “Dana Ruiz”")!.click());

    const form = container.querySelector("[data-picker-new-form]")!;
    expect(form.querySelector<HTMLInputElement>('[aria-label="Full name"]')!.value).toBe(
      "Dana Ruiz",
    );
    typeInto(form.querySelector<HTMLInputElement>('[aria-label="Email"]')!, "dana@ajhmgmt.com");
    await act(async () => button("Save and use")!.click());
    await flush();

    expect(people.findExistingPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: AJH_ID,
        full_name: "Dana Ruiz",
        email: "dana@ajhmgmt.com",
      }),
    );
    expect(people.createCompanyPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: AJH_ID,
        full_name: "Dana Ruiz",
        email: "dana@ajhmgmt.com",
        title: "Property manager",
      }),
    );
    expect(onPick).toHaveBeenCalledWith(created, { created: true });
  });

  it("links to the existing record instead of creating a duplicate", async () => {
    people.findExistingPerson.mockResolvedValue({ match: LIZ, by: "email" });
    const { onPick } = mount();
    await open();
    act(() => button("New person at AJH Management")!.click());
    const form = container.querySelector("[data-picker-new-form]")!;
    typeInto(form.querySelector<HTMLInputElement>('[aria-label="Full name"]')!, "Elizabeth P");
    typeInto(form.querySelector<HTMLInputElement>('[aria-label="Email"]')!, "LIZ@ajhmgmt.com");
    await act(async () => button("Save and use")!.click());
    await flush();

    const dupe = container.querySelector("[data-picker-duplicate]")!;
    expect(dupe.textContent).toContain("Someone with that email is already on file");
    expect(dupe.textContent).toContain("Liz Pedrogo");
    expect(people.createCompanyPerson).not.toHaveBeenCalled();

    await act(async () => button("Use existing")!.click());
    expect(onPick).toHaveBeenCalledWith(LIZ, { created: false });
    expect(people.createCompanyPerson).not.toHaveBeenCalled();
  });

  it("refuses to save without a name, with the message under the field", async () => {
    mount();
    await open();
    act(() => button("New person at AJH Management")!.click());
    await act(async () => button("Save and use")!.click());
    expect(container.textContent).toContain("Enter the person’s name.");
    expect(people.findExistingPerson).not.toHaveBeenCalled();
  });

  it("is picker-only for someone who may not add people to the company", async () => {
    people.canAddPeopleTo.mockResolvedValue(false);
    mount();
    await open();
    expect(container.querySelector("[data-picker-new]")).toBeNull();
    expect(container.querySelectorAll("[data-picker-person]")).toHaveLength(3);
  });
});
