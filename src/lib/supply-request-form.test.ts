import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * How the new-request form presents itself.
 *
 * David, 17 Sep: "I happen to not really like the way it comes up on the right
 * side of the screen... it should be a pop-up in the middle... no side parts...
 * and again with maybe dropdowns also, just to keep it cleaner — I don't have
 * to see everything at once if I'm not looking for everything. If I'm just
 * looking for one item, I don't have to see everything."
 *
 * Presentation only: what a request contains and how it is approved are
 * untouched, which is why there is nothing here about either.
 */
const FORM = readFileSync("src/components/supply-order-form.tsx", "utf8").replace(/\r\n/g, "\n");
const PAGE = readFileSync("src/routes/_authenticated/supplies.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("it opens in the middle", () => {
  it("is a dialog, not the right-hand sheet", () => {
    const page = code(PAGE);
    const fn = page.slice(page.indexOf("function NewRequestSheet"), page.indexOf("/* Inventory"));
    expect(fn).toContain("<Dialog open={open}");
    expect(fn).not.toContain("<Sheet ");
    expect(fn).not.toContain("SheetContent");
  });

  it("uses the width, because he said two columns would be fine", () => {
    const page = code(PAGE);
    const fn = page.slice(page.indexOf("function NewRequestSheet"), page.indexOf("/* Inventory"));
    expect(fn).toContain("max-w-3xl");
    // And stays inside a phone: a fixed max-w with no viewport clamp overflows.
    expect(fn).toContain("w-[calc(100vw-1.5rem)]");
  });

  it("still remounts the form on each open, so a stale draft never returns", () => {
    expect(code(PAGE)).toContain("{open && (");
  });
});

describe("categories are closed until asked for", () => {
  it("starts with nothing open", () => {
    expect(FORM).toContain("useState<Set<string>>(() => new Set())");
  });

  it("opens a section on tap, and says so to a screen reader", () => {
    expect(FORM).toContain("aria-expanded={openSection}");
    expect(FORM).toContain("onClick={() => toggleSection(section.name)}");
  });

  it("opens every section while a search is running", () => {
    // A result hidden inside a collapsed card is not a result.
    expect(FORM).toContain("!!query || openNames.has(section.name)");
  });

  it("lets a category holding a quantity collapse, without hiding it from Send", () => {
    /*
     * David, 24 Sep: "once I drop something down and I fill in a number, I
     * can't collapse it anymore." The lock is gone; what guarded against a
     * number lurking out of sight now is the header badge, the read-back
     * above Send, and typing keeping its own card open.
     */
    const isOpen = FORM.match(/const isOpen = [\s\S]*?;/)![0];
    expect(isOpen).not.toContain("countIn(section) > 0");
    expect(FORM).toContain("data-on-request");
    expect(FORM).toContain("data-request-summary");
    expect(FORM).toContain("onValueChange={(n) => setQuantity(item.id, n ?? 0, section.name)}");
    expect(FORM).toContain(
      "if (sectionName && n > 0) setOpenNames((prev) => new Set(prev).add(sectionName));",
    );
  });

  it("says how many of a category are on the request, without opening it", () => {
    expect(FORM).toContain("on this request");
  });
});

describe("search cuts across every category", () => {
  it("matches on the name, the size and the category", () => {
    // David's catalogue repeats names across sizes, so the size has to be
    // searchable or five Merv 8 filters are indistinguishable in results.
    expect(FORM).toContain(
      '`${i.name} ${catalogueSize(i) ?? ""} ${i.category ?? ""}`.toLowerCase().includes(query)',
    );
  });

  it("groups the results into the same categories", () => {
    expect(FORM).toContain("groupCatalogue(matching)");
  });
});

describe("the request itself is unchanged", () => {
  it("still emits the same draft lines into createRequest", () => {
    const page = code(PAGE);
    const fn = page.slice(page.indexOf("function NewRequestSheet"), page.indexOf("/* Inventory"));
    expect(fn).toContain("createRequest({");
    expect(fn).toContain("lines: draft.lines");
  });

  it("still lets anything not in the catalog be typed", () => {
    // The standing rule that a dropdown never dead-ends survives the collapse.
    expect(FORM).toContain("Anything else");
  });
});
