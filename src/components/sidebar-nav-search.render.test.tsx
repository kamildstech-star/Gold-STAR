// @vitest-environment jsdom
/**
 * The sidebar's "Search menu…" box, mounted for real in jsdom and driven with
 * keyboard events: filtering across groups, the empty state, arrow/Enter/Esc,
 * the "/" shortcut, the folded icon rail, and that it only ever offers what
 * the menu itself would — the role- and page-access-gated list, plus settings
 * pages only as far as the settings hub would list them.
 */
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BarChart3, KanbanSquare, Route, Shield, Sprout, Tent, Trophy, Zap } from "lucide-react";

const nav = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react");
  return {
    useNavigate: () => nav.navigate,
    Link: ({
      to,
      search: _search,
      children,
      ...rest
    }: {
      to: string;
      search?: unknown;
      children: ReactNode;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "a",
        {
          href: to,
          ...rest,
          onClick: (e: MouseEvent) => {
            e.preventDefault();
            (rest.onClick as ((e: MouseEvent) => void) | undefined)?.(e);
          },
        },
        children,
      ),
  };
});

import { SidebarNavSearch, type SidebarSearchItem } from "./sidebar-nav-search";
import { searchableSettingsPages, type SettingsPage } from "@/lib/admin-settings";
import { pageForPath, resolveAllPages } from "@/lib/page-access";
import type { AppRole } from "@/lib/roles";
import type { SearchableNavGroup } from "@/lib/sidebar-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Group = SearchableNavGroup<SidebarSearchItem>;

const MENU: Group[] = [
  { key: "overview", label: "Overview", items: [{ to: "/", label: "Dashboard", icon: BarChart3 }] },
  {
    key: "sales",
    label: "Sales",
    items: [
      { to: "/pipeline", label: "Pipeline", icon: KanbanSquare },
      { to: "/farming", label: "Active Clients", icon: Sprout },
      { to: "/routes", label: "Routes", icon: Route },
      { to: "/tradeshows", label: "Tradeshows", icon: Tent },
      { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
    ],
  },
  {
    key: "admin",
    label: "Admin",
    items: [
      { to: "/admin", label: "Admin", icon: Shield },
      { to: "/admin/automations", label: "Automations", icon: Zap },
    ],
  },
];

/** The same page-access resolver the sidebar's `canOpen` uses, for a role set. */
function canOpenFor(roles: AppRole[]) {
  const map = resolveAllPages({ roles, stored: new Map() });
  return (path: string) => {
    const page = pageForPath(path);
    return page ? (map.byPage.get(page.id)?.allowed ?? false) : false;
  };
}

/** What `itemsForRole` + the hide list hand the search: only openable items. */
function menuFor(canOpen: (p: string) => boolean): Group[] {
  return MENU.map((g) => ({ ...g, items: g.items.filter((i) => canOpen(i.to)) })).filter(
    (g) => g.items.length > 0,
  );
}

let host: HTMLDivElement;
let root: Root;

type Props = {
  groups?: Group[];
  settingsPages?: SettingsPage[];
  collapsed?: boolean;
  onExpand?: () => void;
  onNavigate?: () => void;
};

function render(props: Props = {}) {
  const el = createElement(SidebarNavSearch, {
    groups: props.groups ?? MENU,
    settingsPages: props.settingsPages,
    collapsed: props.collapsed,
    onExpand: props.onExpand,
    onNavigate: props.onNavigate,
    isActive: (to: string) => to === "/pipeline",
    children: createElement("nav", { "data-testid": "full-menu" }, "FULL MENU"),
  });
  act(() => root.render(el));
}

const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Search menu"]')!;
const options = () => Array.from(host.querySelectorAll<HTMLAnchorElement>('[role="option"]'));
const optionLabels = () => options().map((o) => o.textContent);
const groupLabels = () =>
  Array.from(host.querySelectorAll('[role="group"]')).map((g) => g.getAttribute("aria-label"));
const selected = () => host.querySelector('[role="option"][aria-selected="true"]')?.textContent;

function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(target: EventTarget, k: string, init: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

beforeEach(() => {
  nav.navigate.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("filtering", () => {
  it("shows the ordinary menu until something is typed", () => {
    render();
    expect(input().placeholder).toBe("Search menu…");
    expect(host.querySelector('[data-testid="full-menu"]')).not.toBeNull();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("narrows across every group by label, case-insensitively, hiding empty groups", () => {
    render();
    type("CLIENT");
    expect(host.querySelector('[data-testid="full-menu"]')).toBeNull();
    expect(optionLabels()).toEqual(["Active Clients"]);
    expect(groupLabels()).toEqual(["Sales"]);
    expect(host.querySelector('[role="option"]')!.getAttribute("href")).toBe("/farming");
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  it("draws the matched letters", () => {
    render();
    type("show");
    const marks = Array.from(host.querySelectorAll("[role=option] mark")).map((m) => m.textContent);
    expect(marks).toEqual(["show"]);
    expect(optionLabels()).toEqual(["Tradeshows"]);
  });

  it("matches the group's name, opening the whole group", () => {
    render();
    type("sales");
    expect(groupLabels()).toEqual(["Sales"]);
    expect(optionLabels()).toEqual([
      "Pipeline",
      "Active Clients",
      "Routes",
      "Tradeshows",
      "Leaderboard",
    ]);
  });

  it("finds an admin link by the keywords the settings registry gives it", () => {
    render();
    type("rotting");
    expect(optionLabels()).toEqual(["Automations"]);
  });

  it("needs every word to match: 'sales route' is just Routes", () => {
    render();
    type("sales route");
    expect(optionLabels()).toEqual(["Routes"]);
  });

  it("says No matches when nothing fits", () => {
    render();
    type("zzzz");
    expect(options()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')!.textContent).toBe("No matches");
  });

  it("puts openable settings pages under a Settings heading, once each", () => {
    const canOpen = canOpenFor(["admin"]);
    render({ groups: menuFor(canOpen), settingsPages: searchableSettingsPages(canOpen) });
    type("users");
    expect(groupLabels()).toContain("Settings");
    expect(options().map((o) => o.getAttribute("href"))).toContain("/admin/users");
    // Automations is in the menu already; searching it must not list it twice.
    type("automations");
    expect(options().filter((o) => o.getAttribute("href") === "/admin/automations")).toHaveLength(
      1,
    );
  });
});

describe("permissions", () => {
  it("offers only what the role can open — a sales rep never sees admin pages", () => {
    const canOpen = canOpenFor(["sales_rep"]);
    expect(canOpen("/admin")).toBe(false);
    expect(canOpen("/pipeline")).toBe(true);
    render({ groups: menuFor(canOpen), settingsPages: [] });
    type("admin");
    expect(options()).toHaveLength(0);
    expect(host.querySelector('[role="status"]')!.textContent).toBe("No matches");
    type("rotting");
    expect(options()).toHaveLength(0);
    type("pipe");
    expect(optionLabels()).toEqual(["Pipeline"]);
  });

  it("keeps settings results to the pages the hub would list for that person", () => {
    // The Sales Head reaches the scorecard and field permissions, not Users.
    const canOpen = canOpenFor(["sales_head"]);
    const pages = searchableSettingsPages(canOpen);
    render({ groups: menuFor(canOpen), settingsPages: pages });
    type("users");
    expect(options().map((o) => o.getAttribute("href"))).not.toContain("/admin/users");
  });

  it("never invents an item it was not handed", () => {
    render({ groups: [MENU[0]!] });
    type("pipeline");
    expect(options()).toHaveLength(0);
  });

  it("is wired to the sidebar's own filtered list, not the raw nav config", () => {
    const shell = readFileSync("src/components/app-shell.tsx", "utf8");
    const call = shell.match(/<SidebarNavSearch[\s\S]*?>/)![0];
    expect(call).toMatch(/groups=\{visibleGroups\}/);
    expect(call).not.toMatch(/NAV_GROUPS/);
    expect(shell).toMatch(/searchableSettingsPages\(pageAccess\.canOpen\)/);
  });
});

describe("keyboard", () => {
  it("arrows move through results across groups, wrapping at the ends", () => {
    render();
    type("a");
    const all = optionLabels();
    expect(all.length).toBeGreaterThan(2);
    expect(selected()).toBe(all[0]);
    key(input(), "ArrowDown");
    expect(selected()).toBe(all[1]);
    expect(input().getAttribute("aria-activedescendant")).toBe(
      host.querySelector('[aria-selected="true"]')!.id,
    );
    key(input(), "ArrowUp");
    key(input(), "ArrowUp");
    expect(selected()).toBe(all[all.length - 1]);
  });

  it("Enter opens the highlighted result, clears the box and brings the menu back", () => {
    const onNavigate = vi.fn();
    render({ onNavigate });
    type("r");
    const all = options().map((o) => o.getAttribute("href"));
    key(input(), "ArrowDown");
    key(input(), "Enter");
    expect(nav.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: all[1] }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("");
    expect(host.querySelector('[data-testid="full-menu"]')).not.toBeNull();
  });

  it("clicking a result also clears the box", () => {
    const onNavigate = vi.fn();
    render({ onNavigate });
    type("lead");
    act(() => options()[0]!.click());
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(input().value).toBe("");
  });

  it("Esc clears the query", () => {
    render();
    type("pipe");
    const ev = key(input(), "Escape");
    expect(ev.defaultPrevented).toBe(true);
    expect(input().value).toBe("");
    expect(host.querySelector('[data-testid="full-menu"]')).not.toBeNull();
  });

  it("Enter with no matches does nothing", () => {
    render();
    type("zzzz");
    key(input(), "Enter");
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('"/" focuses the box, but not while typing elsewhere, and not with Ctrl/Cmd', () => {
    render();
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    const typed = key(other, "/");
    expect(typed.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(other);
    other.remove();

    const withCtrl = key(document.body, "/", { ctrlKey: true });
    expect(withCtrl.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input());

    const plain = key(document.body, "/");
    expect(plain.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("leaves Cmd/Ctrl+K alone for the header's company search", () => {
    render();
    const ev = key(document.body, "k", { metaKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input());
  });
});

describe("folded icon rail", () => {
  it("shows the full menu with a search button; the button and '/' open the sidebar", () => {
    const onExpand = vi.fn();
    render({ collapsed: true, onExpand });
    expect(host.querySelector('[data-testid="full-menu"]')).not.toBeNull();
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Search menu"]')!;
    expect(button).not.toBeNull();
    act(() => button.click());
    expect(onExpand).toHaveBeenCalledTimes(1);
    key(document.body, "/");
    expect(onExpand).toHaveBeenCalledTimes(2);
    // Once the rail opens out, the cursor lands in the box.
    render({ collapsed: false, onExpand });
    expect(document.activeElement).toBe(input());
  });

  it("keeps a typed query from drawing labels into the folded rail", () => {
    render();
    type("pipe");
    render({ collapsed: true });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelector('[data-testid="full-menu"]')).not.toBeNull();
  });
});
