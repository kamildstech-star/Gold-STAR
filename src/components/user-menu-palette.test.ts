import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark: "this should be a collapsable menu, and should default to collapsed."
 *
 * Five palette rows made the user menu mostly about paint and pushed Security
 * and Sign out below the fold on a laptop. The section now folds, opens
 * collapsed every time, and names the current palette in its header so nobody
 * has to unfold it to see what is set.
 */
const SHELL = readFileSync("src/components/app-shell.tsx", "utf8").replace(/\r\n/g, "\n");

describe("the palette section of the user menu", () => {
  it("opens collapsed every time, not remembered", () => {
    // A menu that reopens half-unfolded is a surprise; local state, seeded
    // closed, and nothing reads or writes storage for it.
    expect(SHELL).toMatch(/const \[paletteOpen, setPaletteOpen\] = useState\(false\)/);
    expect(SHELL).not.toMatch(/localStorage[^\n]*palette/i);
  });

  it("is a real disclosure, wired to the panel it controls", () => {
    // Cut the element out by position rather than regex: the file has many
    // <button>s and an onClick arrow's `=>` defeats a `[^>]*` attribute scan.
    const at = SHELL.indexOf("setPaletteOpen((v) => !v)");
    expect(at, "toggle not found").toBeGreaterThan(-1);
    const open = SHELL.lastIndexOf("<button", at);
    const close = SHELL.indexOf("</button>", at);
    const button = SHELL.slice(open, close);
    expect(button).toContain("aria-expanded={paletteOpen}");
    expect(button).toContain('aria-controls="user-menu-palette"');
    expect(SHELL).toMatch(/id="user-menu-palette" hidden=\{!paletteOpen\}/);
  });

  it("names the current palette in the header so it need not be opened", () => {
    expect(SHELL).toMatch(/PALETTES\.find\(\(p\) => p\.value === palette\)\?\.label/);
  });

  it("spells the label the American way, like the rest of the app", () => {
    expect(SHELL).not.toContain("Colour theme");
    const picker = readFileSync("src/components/theme-picker.tsx", "utf8");
    expect(picker).not.toContain("Colour theme");
  });
});
