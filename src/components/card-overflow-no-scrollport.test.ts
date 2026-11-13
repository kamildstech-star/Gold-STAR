import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { walkFiles } from "@/lib/source-files";

/**
 * Mark: "this is overlapping in the settings", then "fix the other ten cards
 * too."
 *
 * `overflow-x-auto` on a CardContent makes the browser compute `overflow-y:
 * auto` on the same box, so the card body becomes a scrollport. The table
 * header is `sticky top-[var(--table-sticky-top,0px)]`, and <main> sets that
 * token to 2.5rem for the page's own scrollport — so inside a card the header
 * resolved against the card body and the browser pushed it 40px down its own
 * table, hiding the first row underneath it. Measured on the settings page:
 * header top 814 → 686, the first row uncovered.
 *
 * The Table primitive already scrolls sideways where it needs to
 * (`max-md:overflow-x-auto` on its own wrapper), so the card never needed it.
 */
describe("a card body is never a scrollport", () => {
  it("no CardContent sets overflow-x", () => {
    const offenders: string[] = [];
    for (const file of walkFiles("src").filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
      for (const m of src.matchAll(/<CardContent[^>]*className="([^"]*)"/g)) {
        if (/\boverflow-x-/.test(m[1]!)) offenders.push(`${file}: ${m[1]}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  /*
   * These three hold a plain <table>, not the Table primitive, so taking
   * overflow-x off their card body above left nothing to scroll a wide table:
   * on a phone it pushed the whole page sideways. The scroller goes on a div
   * around the table instead, never on the CardContent. On desktop that div
   * is height-bounded so the head (sticky for every table, styles.css) has a
   * scrollport to pin against, and the base rule resets the sticky offset to
   * 0 inside it.
   */
  it.each([
    "src/routes/_authenticated/admin.demo.tsx",
    "src/routes/_authenticated/admin.regions.tsx",
    "src/routes/_authenticated/admin.test-users.tsx",
  ])("%s scrolls its plain table inside the card, not the card", (file) => {
    const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const tables = [...src.matchAll(/<table\b[^>]*>/g)];
    expect(tables.length).toBe(1);
    const before = src.slice(0, tables[0]!.index);
    expect(before).toMatch(
      /<div className="overflow-x-auto md:max-h-\[75svh\] md:overflow-auto">\s*$/,
    );
  });

  it("the Table primitive still handles its own sideways scroll", () => {
    const table = readFileSync("src/components/ui/table.tsx", "utf8").replace(/\r\n/g, "\n");
    expect(table).toContain("max-md:overflow-x-auto");
    expect(table).toMatch(/sticky top-\[var\(--table-sticky-top/);
  });
});
