/**
 * Renders the settings frame through a real (memory) router, so the breadcrumb,
 * the active row and the single-page narrowing are checked as markup rather
 * than as list contents. Server render only — no browser needed.
 */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsFrame } from "./settings-frame";
import { searchableSettingsPages, visibleSettingsPages } from "@/lib/admin-settings";
import { pageForPath, resolveAllPages } from "@/lib/page-access";
import type { AppRole } from "@/lib/roles";

function canOpenFor(roles: AppRole[]) {
  const map = resolveAllPages({ roles, stored: new Map() });
  return (path: string) => {
    const page = pageForPath(path);
    return page ? (map.byPage.get(page.id)?.allowed ?? false) : false;
  };
}

async function renderFrame(roles: AppRole[], path: string): Promise<string> {
  const canOpen = canOpenFor(roles);
  const rootRoute = createRootRoute({
    component: () =>
      createElement(SettingsFrame, {
        pages: visibleSettingsPages(canOpen),
        searchable: searchableSettingsPages(canOpen),
        path,
        canOpenRoot: canOpen("/admin"),
        children: createElement("div", { "data-testid": "body" }, "BODY"),
      }),
  });
  const anyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([anyRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("SettingsFrame", () => {
  it("gives an administrator the rail, the drawer button and a full breadcrumb", async () => {
    const html = await renderFrame(["admin"], "/admin/pipelines");
    expect(html).toContain('aria-label="Settings navigation"');
    expect(html).toContain('aria-label="Open settings menu"');
    expect(html).toContain('href="/admin/pipelines"');
    expect(html).toContain('aria-current="page"');
    const t = text(html);
    expect(t).toMatch(/Settings.*Sales.*Pipelines/);
    // The rail is headed by the three sections, not the old eight areas.
    expect(html).toContain('id="settings-section-operations"');
    expect(html).toContain('id="settings-section-system"');
    expect(html).not.toContain("settings-area-");
    expect(t).toContain("Stage names, order, colors");
    expect(t).toContain("BODY");
    // Field permissions is a tab on Access for administrators, not a rail row.
    expect(html).not.toContain('href="/admin/field-permissions"');
  });

  it("walks through the parent for a sub-page", async () => {
    const html = await renderFrame(["owner"], "/admin/integrations/outlook");
    expect(text(html)).toMatch(/Settings.*System.*Integrations.*Microsoft 365 sync/);
    expect(html).toContain('href="/admin/integrations"');
  });

  it("gives a sales manager just their page: no rail, no drawer, no search, no links out", async () => {
    const html = await renderFrame(["sales_manager"], "/admin/field-permissions");
    expect(html).not.toContain('aria-label="Settings navigation"');
    expect(html).not.toContain('aria-label="Open settings menu"');
    expect(html).not.toContain('aria-label="Search settings"');
    // The crumb still says where they are, but nothing in it is a link they cannot open.
    expect(text(html)).toMatch(/Settings.*System.*Field permissions/);
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain('href="/admin/users"');
    expect(html).not.toContain('href="/admin/permissions"');
  });

  it("gives the Sales Head their two pages and nothing else: a rail of two, no links out", async () => {
    // Field permissions plus the scorecard (Mark, 16 Sep 2026: "this needs to
    // have an admin menu to change and add"). Two pages means the rail is
    // back, listing exactly those two; the hub itself stays out of reach.
    const html = await renderFrame(["sales_head"], "/admin/field-permissions");
    expect(html).toContain('aria-label="Settings navigation"');
    expect(html).toContain('href="/admin/scorecard"');
    expect(html).toContain('href="/admin/field-permissions"');
    expect(html).not.toContain('href="/admin"');
    expect(html).not.toContain('href="/admin/users"');
    expect(html).not.toContain('href="/admin/permissions"');
  });

  it("shows the plain Settings title on the hub index", async () => {
    const html = await renderFrame(["admin"], "/admin");
    // The header is the bare title with no page description under it.
    expect(html).toMatch(/<h1[^>]*>Settings<\/h1>/);
    expect(html).not.toContain("line-clamp-2");
    // No rail row is highlighted; TanStack marks the active link itself, so
    // only the "Settings" root link may carry aria-current here.
    expect(html.match(/aria-current="page"/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});
