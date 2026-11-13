import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, 6 Oct: "for reports add a select all and deselect all button".
 * A report area can carry twenty-odd columns; ticking them one by one to get
 * a full export, or unticking them all to build a narrow one, was the chore.
 */
const SRC = readFileSync("src/components/custom-report-builder.tsx", "utf8").replace(/\r\n/g, "\n");
const legend = SRC.match(/<legend className="[^"]*">\s*Columns[\s\S]*?<\/legend>/)![0];

describe("report columns: select all / deselect all", () => {
  it("puts both buttons inside the legend, so it stays the fieldset's label", () => {
    expect(legend).toContain("Select all");
    expect(legend).toContain("Deselect all");
    // The legend is the fieldset's first child, not wrapped in a div.
    expect(SRC).toMatch(/<fieldset className="space-y-1">\s*\{\/\*[\s\S]*?\*\/\}\s*\{\/\*[\s\S]*?\*\/\}\s*<legend/);
  });

  it("selects every column in the area's order, and clears them all", () => {
    expect(legend).toContain("set({ columns: area.fields.map((f) => f.key) })");
    expect(legend).toContain("set({ columns: [] })");
  });

  it("disables each button when it would do nothing", () => {
    expect(legend).toContain("disabled={draft.columns.length === area.fields.length}");
    expect(legend).toContain("disabled={draft.columns.length === 0}");
  });

  it("are plain buttons, so they never submit anything", () => {
    expect((legend.match(/type="button"/g) ?? []).length).toBe(2);
  });
});
