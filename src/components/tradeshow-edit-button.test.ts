import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark: "This edit button doesn't work at all. It just takes you back to the
 * page for trade shows."
 *
 * It did exactly that -- the edit form only existed on the list page, so the
 * detail page's Edit navigated to the list with a tooltip saying "Edit from
 * the list". The form is now a shared component both pages open.
 */
const norm = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("Edit on a tradeshow's own page", () => {
  it("opens the form there instead of leaving for the list", () => {
    const page = norm("src/routes/_authenticated/tradeshows.$id.tsx");
    const at = page.indexOf("/> Edit");
    expect(at).toBeGreaterThan(-1);
    const button = page.slice(page.lastIndexOf("<Button", at), at);
    expect(button).toContain("setEditing(true)");
    expect(button).not.toContain('navigate({ to: "/tradeshows" })');
    expect(page).not.toContain("Edit from the list");
    expect(page).toMatch(/<ShowDialog\s+show=\{d\.show\}/);
  });

  it("is the same form the list page uses, not a copy", () => {
    const detail = norm("src/routes/_authenticated/tradeshows.$id.tsx");
    const list = norm("src/routes/_authenticated/tradeshows.index.tsx");
    for (const f of [detail, list]) {
      expect(f).toContain('from "@/components/tradeshow-show-dialog"');
      expect(f).not.toMatch(/^function ShowDialog\(/m);
    }
    expect(norm("src/components/tradeshow-show-dialog.tsx")).toMatch(
      /^export function ShowDialog\(/m,
    );
  });
});
