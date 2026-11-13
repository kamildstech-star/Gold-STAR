import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * Mark, twice about the same line: "you can't see the company name" (it read
 * "B…") and then, on a 1200px window, "on small screens this needs work".
 *
 * The rule that came out of it: the company name is the most important thing
 * on the page and must never be the thing that truncates — everything else
 * yields first. These are the structural facts that make that true; they are
 * asserted on the class strings because that is where the rule lives, and a
 * refactor that quietly reintroduces `flex-1`, a `min-w-` floor or
 * `flex-nowrap` on this row is exactly the regression worth catching.
 *
 * The layout itself was measured in a browser at 768 / 1024 / 1200 / 1440 /
 * 1920 / 2200 / 2560 against a static render of this component.
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement("a", { className, href: "#" }, children),
  // The back arrow is the shared `BackLink`, which asks the router where the
  // user came from. Nothing here exercises that; it just has to exist.
  useRouter: () => ({
    history: { location: { state: {} }, canGoBack: () => false, back: vi.fn() },
  }),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: "/accounts/a1", search: {}, searchStr: "" } }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    isLoading: false,
    data: {
      occurred_at: new Date(Date.now() - 31 * 86400_000).toISOString(),
      rep_id: "rep-1",
      rep_name: "Test Sales Rep NY (Brooklyn)",
    },
  }),
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ allLocations: [{ id: "a" }, { id: "b" }, { id: "c" }], userId: "me" }),
}));
vi.mock("@/lib/account-locations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-locations")>()),
  useAccountLocations: (id: string | null) => ({ data: id ? ["a", "b"] : undefined }),
}));
vi.mock("@/components/compliance-badge", () => ({ ComplianceBadge: () => null }));
vi.mock("@/components/label-picker", () => ({
  LabelPicker: () => createElement("button", null, "Labels"),
}));

import { ProspectRecordHeader } from "./prospect-record-header";

const html = () =>
  renderToStaticMarkup(
    createElement(ProspectRecordHeader, {
      accountId: "acc-1",
      name: "Brooklyn Facilities 2",
      status: "prospect",
      accountType: "commercial",
      isMultiLocation: true,
      place: "Brooklyn, NY",
      ownerName: "Dana Whitfield",
      contactName: "Priya Raghunathan",
      contactCount: 3,
      onOpenCompany: () => {},
      onOpenContact: () => {},
      onEdit: () => {},
      editDisabled: false,
      editReason: null,
    }),
  );

/** The class list of the element carrying `data-testid="<id>"`. */
function classesOf(markup: string, id: string) {
  const m = new RegExp(`<[^>]*data-testid="${id}"[^>]*>`).exec(markup);
  if (!m) throw new Error(`no element with data-testid="${id}"`);
  return (/class="([^"]*)"/.exec(m[0])?.[1] ?? "").split(/\s+/);
}

describe("prospect record header", () => {
  it("keeps the company name out of the row's shrink pool", () => {
    const name = classesOf(html(), "prospect-header-name");
    expect(name).toContain("shrink-0");
    expect(name).toContain("max-w-full");
    // Anything that lets the row take width off the name is the bug itself.
    expect(name).not.toContain("flex-1");
    expect(name.some((c) => c.startsWith("min-w-"))).toBe(false);
  });

  it("gives the chips a row of their own until the header really is wide", () => {
    const chips = classesOf(html(), "prospect-header-chips");
    expect(chips).toContain("basis-full");
    expect(chips).toContain("order-last");
    // Measured: the one-line layout needs ~1900px of header width.
    expect(chips).toContain("@min-[1900px]:basis-auto");
    expect(chips).toContain("@min-[1900px]:order-none");
  });

  it("wraps rather than competing, and measures the header, not the monitor", () => {
    const markup = html();
    // The sidebar is 200-340px and collapsible, so a viewport breakpoint
    // cannot tell how much room this header actually has.
    expect(markup).toContain("@container");
    expect(markup).not.toContain("xl:flex-nowrap");
    expect(markup).not.toContain("flex-nowrap");
  });

  it("shows the contact in full or not at all — never as 'P…'", () => {
    const markup = html();
    expect(markup).toContain("Priya Raghunathan");
    const contact = classesOf(markup, "prospect-header-contact");
    // A 7rem floor: below it the whole person chunk wraps to the next row.
    expect(contact).toContain("min-w-[7rem]");
  });

  it("shortens the last-visit sentence when the header is narrow", () => {
    const markup = html();
    expect(markup).toContain("Visited 31 days ago");
    expect(markup).toContain("Test Sales Rep NY (Brooklyn) was here 31 days ago");
    expect(markup).toContain("@min-[60rem]:hidden");
  });

  it("is the full record's header too, so the name keeps the same rule there", () => {
    // 4 Nov: one header for both layouts — switching Prospect ⇄ Full record
    // changes only what is below it.
    const src = readFileSync("src/routes/_authenticated/accounts.$id.tsx", "utf8");
    expect(src).toContain("<ProspectRecordHeader");
    expect(src).not.toContain('data-testid="account-header-name"');
  });
});
