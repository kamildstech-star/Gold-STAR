// @vitest-environment jsdom
import { act, createContext, createElement, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Billing & Costs › Catalogs, driven for real: the draft, the sticky Save bar,
 * the duplicate-name guard, the archive check and read-only mode. The data
 * layer (src/lib/catalog.ts load/save) is stubbed — its rules are unit-tested
 * in catalog.test.ts and the database's in the pglite fixture. Radix select
 * and alert dialog are swapped for plain elements; what is under test is what
 * a pick does, not how a listbox opens in jsdom. No DOM testing library, per
 * the repo's brief: `react-dom/client` and `act`.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  roles: ["admin"] as string[],
  fromDatabase: true,
  saves: [] as { changes: unknown; note: string }[],
  usage: new Map<string, number>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => undefined,
  Link: ({ children }: { children: ReactNode }) => createElement("a", null, children),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ realRoles: state.roles, roles: state.roles }),
}));
vi.mock("@/lib/catalog", async (orig) => {
  const real = await orig<typeof import("@/lib/catalog")>();
  const item = (o: Partial<import("@/lib/catalog").CatalogItem>) => ({
    category: "labor",
    unit: "hr",
    unit_review: null,
    active: true,
    archived_at: null,
    sort_order: 10,
    updated_at: "2026-10-29T00:00:00Z",
    ...o,
  });
  return {
    ...real,
    loadCatalog: async () => ({
      fromDatabase: state.fromDatabase,
      items: state.fromDatabase
        ? [
            item({ code: "GL", name: "General Labor", sort_order: 10 }),
            item({ code: "SL", name: "Skilled Labor", sort_order: 20 }),
            item({ code: "PNT", name: "Painter", sort_order: 30, archived_at: "2026-10-01" }),
            item({
              code: "100",
              name: "Anti-microbial agent",
              category: "consumable",
              unit: "piece",
              unit_review: 'Carried over from the T&M sheet\'s "each".',
            }),
          ]
        : [],
      tmCodes: new Map([["300", "equipment"]]),
    }),
    saveCatalog: async (changes: unknown, note: string) => {
      state.saves.push({ changes, note });
      return (changes as unknown[]).length;
    },
    loadCatalogUsage: async (codes: string[]) =>
      new Map(codes.map((c) => [c, state.usage.get(c) ?? 0])),
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
    SelectTrigger: ({ children }: { children: ReactNode }) => createElement("div", null, children),
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
vi.mock("@/components/ui/alert-dialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? createElement("div", { role: "alertdialog" }, children) : null,
    AlertDialogContent: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogCancel: ({ children }: { children: ReactNode }) =>
      createElement("button", null, children),
    AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick: () => void }) =>
      createElement("button", { onClick, "data-confirm": "" }, children),
  };
});

import { CatalogsTab } from "./catalogs-tab";
import type { CatalogCategory } from "@/lib/catalog";

let host: HTMLDivElement;
let root: Root;
let category: CatalogCategory = "labor";

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const draw = () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(CatalogsTab, {
          category,
          onCategory: (c: typeof category) => {
            category = c;
            draw();
          },
        }),
      ),
    );
  await act(async () => draw());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
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
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
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
  state.roles = ["admin"];
  state.fromDatabase = true;
  state.saves = [];
  state.usage = new Map([["SL", 2]]);
  category = "labor";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Catalogs tab", () => {
  it("lists the category, keeps archived items collapsed with a count", async () => {
    await render();
    expect($('[data-catalog-row="GL"]')).not.toBeNull();
    expect($('[data-catalog-row="100"]')).toBeNull();
    expect($('[data-catalog-row="PNT"]')).toBeNull();
    expect(text()).toMatch(/Archived\s*1/);
  });

  it("saves nothing until Save, then sends one change with the note", async () => {
    await render();
    await type($<HTMLInputElement>('[aria-label="Name of GL"]')!, "General Laborer");
    expect(state.saves).toEqual([]);
    expect(text()).toContain("1 unsaved change");
    await type($<HTMLInputElement>('[aria-label="Note for the change log"]')!, "Renamed per David");
    await click(button("Save changes"));
    expect(state.saves).toEqual([
      {
        changes: [{ op: "update", code: "GL", name: "General Laborer" }],
        note: "Renamed per David",
      },
    ]);
    expect(text()).not.toContain("unsaved change");
  });

  it("blocks a duplicate name with a link to the other item", async () => {
    await render();
    await type($<HTMLInputElement>('[aria-label="Name of SL"]')!, "  general labor ");
    expect(text()).toContain('"general labor" already exists.');
    expect(button("Show GL")).toBeTruthy();
    expect(button("Save changes").disabled).toBe(true);
  });

  it("an edit typed back to the saved value leaves nothing pending", async () => {
    await render();
    const name = $<HTMLInputElement>('[aria-label="Name of GL"]')!;
    await type(name, "Something");
    await type(name, "General Labor");
    expect(text()).not.toContain("unsaved change");
  });

  it("shows how many jobs use an item before archiving it", async () => {
    await render();
    await click($('[aria-label="Archive SL"]')!);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect($('[role="alertdialog"]')?.textContent).toMatch(/used on\s*2 jobs/);
    await click($("[data-confirm]")!);
    await click(button("Save changes"));
    expect(state.saves[0]?.changes).toEqual([{ op: "update", code: "SL", archived: true }]);
  });

  it("adds an item only with a code, a name and a unit that fits", async () => {
    await render();
    await click(button("Add item"));
    await click(button("Save changes"));
    expect(state.saves).toEqual([]);
    expect(text()).toContain("Give the item a code.");
    await type($<HTMLInputElement>('[aria-label="New item code"]')!, "fl");
    await type($<HTMLInputElement>('[aria-label="New item name"]')!, "Floor Technician");
    await click($('[data-catalog-new] [role="option"][data-value="hr"]')!);
    await click(button("Save changes"));
    expect(state.saves[0]?.changes).toEqual([
      { op: "create", code: "FL", name: "Floor Technician", category: "labor", unit: "hr" },
    ]);
  });

  it("flags a carried-over unit and lets it be confirmed", async () => {
    category = "consumable";
    await render();
    expect(text()).toContain("Carried over from the T&M sheet");
    await click(button("Confirm per piece"));
    await click(button("Save changes"));
    expect(state.saves[0]?.changes).toEqual([{ op: "update", code: "100", unit: "piece" }]);
  });

  it("shows the catalog as plain text to anyone who is not an administrator", async () => {
    state.roles = ["office"];
    await render();
    expect(text()).not.toContain("Read only");
    expect(button("Add item")).toBeUndefined();
    expect($('[aria-label="Name of GL"]')).toBeNull();
    expect($('[data-catalog-name="GL"]')?.textContent).toBeTruthy();
    expect($('[role="switch"]')).toBeNull();
    expect(
      host.querySelector("[data-catalog-row] input, [data-catalog-row] [disabled]"),
    ).toBeNull();
  });

  it("says plainly when the database update has not landed", async () => {
    state.fromDatabase = false;
    await render();
    expect(text()).toContain("The catalog is not available yet.");
  });
});
