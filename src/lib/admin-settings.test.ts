import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SETTINGS_AREAS,
  SETTINGS_PAGES,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_LAYOUT,
  settingsSectionOf,
  SETTINGS_PAGE_BY_PATH,
  groupSettingsPages,
  searchSettingsPages,
  searchableSettingsPages,
  settingsBreadcrumb,
  settingsPageForPath,
  settingsPathMatches,
  visibleSettingsPages,
} from "./admin-settings";
import { pageForPath, resolveAllPages } from "./page-access";
import type { AppRole } from "./roles";

/**
 * Every `admin.*.tsx` file under the routes directory, as the path TanStack
 * gives it. `admin.tsx` (the layout) and `admin.index.tsx` (the hub) are the
 * frame, not pages, and are skipped.
 */
function adminRoutePaths(): string[] {
  const dir = fileURLToPath(new URL("../routes/_authenticated/", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.startsWith("admin.") && f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map(
      (f) =>
        "/" +
        f
          .replace(/\.tsx$/, "")
          .split(".")
          .join("/"),
    )
    .map((p) => p.replace(/\/index$/, ""))
    .filter((p) => p !== "/admin");
}

describe("settings registry covers the routes directory", () => {
  it("has an entry for every admin.*.tsx route, so a new page cannot ship without a home", () => {
    const missing = adminRoutePaths().filter((p) => !SETTINGS_PAGE_BY_PATH.has(p));
    expect(
      missing,
      `register these in SETTINGS_PAGES (src/lib/admin-settings.ts): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has no entry without a route file behind it", () => {
    const routes = new Set(adminRoutePaths());
    const stale = SETTINGS_PAGES.map((p) => p.path).filter((p) => !routes.has(p));
    expect(stale, `no route file for: ${stale.join(", ")}`).toEqual([]);
  });

  it("registers each path once with a real area, description and keywords", () => {
    const seen = new Set<string>();
    const areaIds = new Set(SETTINGS_AREAS.map((a) => a.id));
    for (const p of SETTINGS_PAGES) {
      expect(seen.has(p.path), `${p.path} registered twice`).toBe(false);
      seen.add(p.path);
      expect(areaIds.has(p.area), `${p.path} has unknown area ${p.area}`).toBe(true);
      expect(p.description.trim().length, `${p.path} needs a description`).toBeGreaterThan(10);
      expect(p.keywords.length, `${p.path} needs keywords`).toBeGreaterThan(0);
      if (p.parent) {
        expect(SETTINGS_PAGE_BY_PATH.has(p.parent), `${p.path} parent ${p.parent} missing`).toBe(
          true,
        );
      }
      if (p.foldedInto) {
        expect(SETTINGS_PAGE_BY_PATH.has(p.foldedInto), `${p.path} folds into nothing`).toBe(true);
      }
    }
  });

  it("only registers paths the page-access catalog also knows, so the gate and the hub agree", () => {
    for (const p of SETTINGS_PAGES) {
      expect(
        pageForPath(p.path.replace("$userId", "abc")),
        `${p.path} unknown to page-access`,
      ).not.toBeNull();
    }
  });
});

describe("path matching and breadcrumb", () => {
  it("matches exact paths, children and $param segments", () => {
    expect(settingsPathMatches("/admin/users", "/admin/users")).toBe(true);
    expect(settingsPathMatches("/admin/users", "/admin/users/")).toBe(true);
    expect(settingsPathMatches("/admin/users/$userId", "/admin/users/abc-123")).toBe(true);
    expect(settingsPathMatches("/admin/users/$userId", "/admin/users")).toBe(false);
    expect(settingsPathMatches("/admin/tags", "/admin/tagsx")).toBe(false);
  });

  it("prefers the longest owner", () => {
    expect(settingsPageForPath("/admin/users/abc")?.label).toBe("Edit user");
    expect(settingsPageForPath("/admin/users")?.label).toBe("Users");
    expect(settingsPageForPath("/admin/integrations/outlook")?.label).toBe("Microsoft 365 sync");
    expect(settingsPageForPath("/admin/integrations?x=1")?.label).toBe("Integrations");
    expect(settingsPageForPath("/admin")).toBeNull();
    expect(settingsPageForPath("/jobs")).toBeNull();
  });

  it("walks Settings › Section › Parent › Page", () => {
    const crumb = settingsBreadcrumb("/admin/integrations/outlook");
    expect(crumb?.section.label).toBe("System");
    expect(crumb?.trail.map((p) => p.label)).toEqual(["Integrations", "Microsoft 365 sync"]);

    const user = settingsBreadcrumb("/admin/users/abc");
    expect(user?.section.label).toBe("System");
    expect(user?.trail.map((p) => p.label)).toEqual(["Users", "Edit user"]);

    expect(settingsBreadcrumb("/admin/tags")?.trail.map((p) => p.label)).toEqual(["Tags"]);
    expect(settingsBreadcrumb("/admin")).toBeNull();
  });
});

describe("visibility follows the page-access resolver, not a second rule", () => {
  const canOpenFor = (roles: AppRole[]) => {
    const map = resolveAllPages({ roles, stored: new Map() });
    return (path: string) => {
      const page = pageForPath(path);
      return page ? (map.byPage.get(page.id)?.allowed ?? false) : false;
    };
  };

  it("gives an administrator every listed page, with Field permissions folded into Access", () => {
    const pages = visibleSettingsPages(canOpenFor(["admin"]));
    const paths = pages.map((p) => p.path);
    expect(paths).toContain("/admin/users");
    expect(paths).toContain("/admin/permissions");
    expect(paths).toContain("/admin/option-lists");
    expect(paths).not.toContain("/admin/field-permissions");
    // Sub-pages are reached from their parent, never listed.
    expect(paths).not.toContain("/admin/users/$userId");
    expect(paths).not.toContain("/admin/integrations/outlook");
    // Every top-level route is offered.
    const topLevel = SETTINGS_PAGES.filter((p) => !p.parent && !p.foldedInto).length;
    expect(pages.length).toBe(topLevel);
  });

  it("narrows sales leadership to Field permissions — plus the scorecard for the Sales Head", () => {
    // The Sales Head owns the scorecard weights (Mark, 16 Sep 2026: "this
    // needs to have an admin menu to change and add"), so they get that page
    // too; a sales manager still sees only Field permissions.
    const expected: Record<string, string[]> = {
      sales_head: ["/admin/scorecard", "/admin/field-permissions"],
      sales_manager: ["/admin/field-permissions"],
    };
    for (const role of ["sales_head", "sales_manager"] as AppRole[]) {
      const pages = visibleSettingsPages(canOpenFor([role]));
      expect(pages.map((p) => p.path).sort(), role).toEqual(expected[role].sort());
      expect(
        searchableSettingsPages(canOpenFor([role]))
          .map((p) => p.path)
          .sort(),
      ).toEqual(expected[role].sort());
    }
  });

  it("offers nothing to a role with no settings access", () => {
    for (const role of ["sales_rep", "crew", "field_chaser", "office"] as AppRole[]) {
      expect(visibleSettingsPages(canOpenFor([role])), role).toEqual([]);
    }
  });

  it("groups by section in display order and drops empty sections", () => {
    const groups = groupSettingsPages(visibleSettingsPages(canOpenFor(["sales_head"])));
    expect(groups.map((g) => g.section.id)).toEqual(["sales", "system"]);
    const manager = groupSettingsPages(visibleSettingsPages(canOpenFor(["sales_manager"])));
    expect(manager.map((g) => g.section.id)).toEqual(["system"]);
    const all = groupSettingsPages(visibleSettingsPages(canOpenFor(["owner"])));
    expect(all.map((g) => g.section.id)).toEqual(["operations", "sales", "system"]);
    for (const g of all) expect(g.pages.length).toBeGreaterThan(0);
  });

  it("lists each section's pages in the layout's order", () => {
    const all = groupSettingsPages(visibleSettingsPages(canOpenFor(["owner"])));
    for (const g of all) {
      const layout = SETTINGS_SECTION_LAYOUT[g.section.id].filter((p) =>
        g.pages.some((x) => x.path === p),
      );
      expect(g.pages.map((p) => p.path)).toEqual(layout);
    }
  });

  it("lets search reach the Microsoft 365 sub-page for an administrator", () => {
    const paths = searchableSettingsPages(canOpenFor(["admin"])).map((p) => p.path);
    expect(paths).toContain("/admin/integrations/outlook");
    expect(paths).not.toContain("/admin/users/$userId");
  });
});

describe("search finds a page by name or by what it contains", () => {
  const all = SETTINGS_PAGES.filter((p) => !p.path.includes("$"));
  const top = (q: string) => searchSettingsPages(q, all)[0]?.page.path;

  it("lands on Dropdown options for a list value and Security for the bot check", () => {
    expect(top("reconstruction")).toBe("/admin/option-lists");
    expect(top("Turnstile")).toBe("/admin/security");
  });

  it("matches a page by its title first", () => {
    expect(top("tags")).toBe("/admin/tags");
    expect(top("pipelines")).toBe("/admin/pipelines");
    // Retired into Billing & Costs (prompt 3); the old title still finds it.
    expect(top("Cost rates")).toBe("/admin/equipment-rates");
  });

  it("ranks a title match above a keyword match", () => {
    // "email" is a keyword on Users and Offboarding but the title of Email templates.
    expect(top("email")).toBe("/admin/email-templates");
    // "labels" is what the Tags page actually manages.
    expect(top("labels")).toBe("/admin/tags");
  });

  it("requires every word to match, so a second word narrows", () => {
    const hits = searchSettingsPages("template contract", all);
    expect(hits.map((h) => h.page.path)).toEqual(["/admin/templates"]);
    expect(searchSettingsPages("zebra", all)).toEqual([]);
  });

  it("is case- and spelling-tolerant", () => {
    // Labor rates is the Labor tab of Cost rates since 23 Oct; its old
    // address (a child of Cost rates) still opens that section.
    expect(top("LABOR")).toBe("/admin/labour-rates");
    expect(top("labour")).toBe("/admin/labour-rates");
    expect(top("color")).toBe("/admin/tags");
    expect(top("2FA")).toBe("/admin/security");
    expect(top("outlook")).toBe("/admin/integrations/outlook");
  });

  it("matches a word prefix while typing", () => {
    expect(top("recon")).toBe("/admin/option-lists");
    expect(top("escal")).toBe("/admin/escalations");
  });

  it("finds by area name", () => {
    const hits = searchSettingsPages("developer", all);
    expect(hits.map((h) => h.page.path).sort()).toEqual(["/admin/demo", "/admin/test-users"]);
  });

  it("returns nothing for a blank query and honors the limit", () => {
    expect(searchSettingsPages("   ", all)).toEqual([]);
    expect(searchSettingsPages("a", all, 3).length).toBeLessThanOrEqual(3);
  });

  it("only searches the pages it is given", () => {
    const one = SETTINGS_PAGES.filter((p) => p.path === "/admin/field-permissions");
    expect(searchSettingsPages("users", one)).toEqual([]);
    expect(searchSettingsPages("field", one).map((h) => h.page.path)).toEqual([
      "/admin/field-permissions",
    ]);
  });
});

/**
 * David, 22 Sep: "when I'm dealing with operations I don't need gifting and
 * all that... operational stuff and then sales stuff." Grouped by the
 * project's own logic until his list arrives; these pin that the grouping is
 * one mapping that cannot drop a page, and that nothing got harder to find.
 */
describe("Operations / Sales / System", () => {
  const topLevel = SETTINGS_PAGES.filter((p) => !p.parent).map((p) => p.path);
  const laidOut = Object.values(SETTINGS_SECTION_LAYOUT).flat();

  it("has exactly three sections, Operations first", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual(["Operations", "Sales", "System"]);
  });

  it("places every top-level page exactly once, and nothing that is not a page", () => {
    expect([...laidOut].sort()).toEqual([...topLevel].sort());
    expect(new Set(laidOut).size).toBe(laidOut.length);
  });

  it("puts a sub-page wherever its parent is", () => {
    for (const p of SETTINGS_PAGES.filter((x) => x.parent)) {
      expect(settingsSectionOf(p).id, p.path).toBe(
        settingsSectionOf(SETTINGS_PAGE_BY_PATH.get(p.parent!)!).id,
      );
    }
  });

  it("follows the decision taken on 28 Sep", () => {
    const section = (path: string) => settingsSectionOf(SETTINGS_PAGE_BY_PATH.get(path)!).id;
    for (const p of [
      "/admin/supply-catalog",
      "/admin/equipment-rates",
      "/admin/estimate-catalog",
      "/admin/price-lists",
      "/admin/option-lists",
    ]) {
      expect(section(p), p).toBe("operations");
    }
    for (const p of [
      "/admin/pipelines",
      "/admin/scorecard",
      "/admin/gift-catalog",
      "/admin/territory",
      "/admin/commissions",
      "/admin/tags",
    ]) {
      expect(section(p), p).toBe("sales");
    }
    for (const p of [
      "/admin/users",
      "/admin/locations",
      "/admin/email-templates",
      "/admin/automations",
      "/admin/integrations",
    ]) {
      expect(section(p), p).toBe("system");
    }
  });

  it("keeps every word that found a page yesterday finding it today", () => {
    const all = SETTINGS_PAGES.filter((p) => !p.path.includes("$"));
    // By old area name, still…
    for (const area of SETTINGS_AREAS) {
      const inArea = all.filter((p) => p.area === area.id).map((p) => p.path);
      const found = searchSettingsPages(area.label, all, 50).map((h) => h.page.path);
      for (const p of inArea) expect(found, `${area.label} → ${p}`).toContain(p);
    }
    // …and by the new section name.
    const ops = searchSettingsPages("operations", all, 50).map((h) => h.page.path);
    expect(ops).toEqual(expect.arrayContaining([...SETTINGS_SECTION_LAYOUT.operations]));
  });
});
