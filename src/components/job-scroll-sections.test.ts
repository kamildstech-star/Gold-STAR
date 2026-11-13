import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * FE1, 28 Oct: the scope of work and the visits list grew the job page
 * without end. Each now scrolls inside a fixed-height box with its header
 * kept in view.
 */
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

describe("job page lists scroll in place", () => {
  it("scope of work: fixed height, room names pinned", () => {
    const src = read("src/components/scope-of-work-card.tsx");
    expect(src).toMatch(/className="max-h-\[28rem\][^"]*overflow-y-auto[^"]*"\s*data-scope-scroll/);
    expect(src).toContain('<h4 className="sticky top-0');
  });

  it("schedule: crew and visits each scroll under their own header", () => {
    const src = read("src/components/job-schedule-tab.tsx");
    expect(src).toContain('const LIST_SCROLL = "max-h-[26rem] overflow-y-auto');
    expect(src).toContain('data-schedule-scroll="crew"');
    expect(src).toContain('data-schedule-scroll="visits"');
  });
});
