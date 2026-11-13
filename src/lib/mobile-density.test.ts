import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CONDENSE_AFTER, nextCondensed } from "./use-condense-on-scroll";

/**
 * David, 24 Sep: "a majority of the people are going to be going on the
 * phone... a lot of the phone gets covered by the top section or by the side
 * section. If we could have more of the content that's relevant showing,
 * that would be a big help."
 */

describe("the phone bars condense on scroll", () => {
  it("stay put near the top", () => {
    expect(nextCondensed(true, 200, CONDENSE_AFTER)).toBe(false);
    expect(nextCondensed(false, 0, 40)).toBe(false);
  });

  it("fold away scrolling down and come back scrolling up", () => {
    expect(nextCondensed(false, 100, 160)).toBe(true);
    expect(nextCondensed(true, 400, 380)).toBe(false);
  });

  it("ignore a shaky thumb", () => {
    expect(nextCondensed(true, 300, 303)).toBe(true);
    expect(nextCondensed(false, 300, 297)).toBe(false);
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SHELL = read("src/components/app-shell.tsx");
const CSS = read("src/styles.css");

describe("shared by the shell, phone only", () => {
  it("the shell watches its own scrollport and folds the top bar by its row", () => {
    expect(SHELL).toContain("const condensed = useCondenseOnScroll(mainRef);");
    expect(SHELL).toMatch(/<main\s+ref=\{mainRef\}/);
    expect(SHELL).toContain("max-md:data-[condensed=true]:grid-rows-[0fr]");
  });

  it("the bottom bar slides away on the same signal, and only exists on phones", () => {
    expect(SHELL).toMatch(/<MobileBottomNav condensed=\{condensed\}/);
    expect(SHELL).toMatch(/data-\[condensed=true\]:translate-y-full md:hidden/);
  });

  it("only phones condense — the hook checks the width on every scroll", () => {
    const hook = read("src/lib/use-condense-on-scroll.ts");
    expect(hook).toContain('const PHONE = "(max-width: 767.98px)";');
    expect(hook).toContain("phone.matches ? nextCondensed(prev, lastY, y, scroll) : false");
  });

  it("cards and the page gutter tighten on phones only, from the shared tokens", () => {
    expect(CSS).toMatch(/@media \(max-width: 767\.98px\) \{\s*:root \{\s*--card-padding: 12px;/);
    // Desktop keeps its values.
    expect(CSS).toContain("--card-padding: 20px;");
    expect(CSS).toMatch(
      /@utility page-shell \{[\s\S]*?padding-block: 0\.5rem;[\s\S]*?@media \(min-width: 768px\) \{\s*padding-block: 1rem;/,
    );
  });
});
