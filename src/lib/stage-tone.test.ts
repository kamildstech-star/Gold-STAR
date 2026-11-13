import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FALLBACK_TONES,
  STAGE_KEY_TONE,
  TONES,
  stageGradient,
  stageTone,
  stageToneName,
} from "./stage-tone";
import { PROSPECTING_STAGES } from "./sales-pipeline";

/**
 * Mark: "the colors here in the pipeline aren't exciting." The fix is one tone
 * per stage, decided in one place, by key. These pin the map, the custom-stage
 * fallback and that every tone the map can hand out has tokens behind it in
 * both themes.
 */

const CSS = readFileSync("src/styles.css", "utf8").replace(/\r\n/g, "\n");

describe("the six prospecting stages", () => {
  it("each has its own hue, mapped by key", () => {
    expect(PROSPECTING_STAGES.map((k) => stageToneName(k))).toEqual([
      "sky",
      "violet",
      "amber",
      "emerald",
      "slate",
      "rose",
    ]);
    expect(new Set(PROSPECTING_STAGES.map((k) => stageToneName(k))).size).toBe(6);
  });

  it("matches the stored key, not the label — the Ghosted key is still 'goasted'", () => {
    expect(stageToneName("goasted")).toBe("rose");
    expect(stageToneName("Ghosted")).not.toBe("rose");
  });
});

describe("a custom stage", () => {
  it("gets the same tone every time, from its key", () => {
    expect(stageToneName("site_walk")).toBe(stageToneName("site_walk"));
    expect(stageTone("site_walk")).toBe(stageTone(" site_walk "));
  });

  it("never borrows a stage hue, so it cannot read as Ghosted or a win", () => {
    const stageHues = new Set(Object.values(STAGE_KEY_TONE));
    for (const t of FALLBACK_TONES) expect(stageHues.has(t)).toBe(false);
    for (const key of ["site_walk", "proposal", "negotiation", "x", "on_hold", "nurture"]) {
      expect(FALLBACK_TONES).toContain(stageToneName(key));
    }
  });

  it("spreads across the fallback set rather than landing on one color", () => {
    const keys = ["proposal", "negotiation", "site_walk", "on_hold", "nurture", "bid", "review"];
    expect(new Set(keys.map(stageToneName)).size).toBeGreaterThan(1);
  });

  it("is neutral when it has no key at all", () => {
    expect(stageToneName(null)).toBe("slate");
    expect(stageToneName("")).toBe("slate");
  });
});

describe("the classes and the tokens behind them", () => {
  it("are literal token classes — no hex, no palette color", () => {
    for (const tone of Object.values(TONES)) {
      for (const v of [tone.fill, tone.dot, tone.text, tone.soft, tone.border, tone.ring]) {
        expect(v).toContain(`tone-${tone.name}`);
        expect(v).not.toMatch(/#|primary|warning/);
      }
      expect(tone.color).toBe(`var(--tone-${tone.name})`);
    }
  });

  it("every tone has a fill, its text and on-page text in light AND dark", () => {
    const light = CSS.match(/:root,\n\.dark\[data-palette="goldstar"\] \{[\s\S]*?\n\}/)?.[0];
    const dark = CSS.match(/\.dark:not\(\[data-palette="goldstar"\]\) \{[\s\S]*?\n\}/)?.[0];
    expect(light, "light tone block").toBeTruthy();
    expect(dark, "dark tone block").toBeTruthy();
    for (const name of Object.keys(TONES)) {
      for (const block of [light!, dark!]) {
        for (const suffix of ["", "-fg", "-text"]) {
          expect(block).toMatch(new RegExp(`--tone-${name}${suffix}: #[0-9a-f]{6};`));
        }
      }
      expect(CSS).toContain(`--color-tone-${name}-soft: color-mix(`);
    }
  });
});

describe("the rail gradient", () => {
  it("runs through each traveled stage's tone, in order", () => {
    expect(stageGradient(["ready", "active_outreach", "conversation_established"])).toBe(
      "linear-gradient(to right, var(--tone-sky), var(--tone-violet), var(--tone-amber))",
    );
    expect(stageGradient(["ready"])).toBe("var(--tone-sky)");
    expect(stageGradient([])).toBeNull();
  });
});
