import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("src/components/fire-feed/public-pages.panel.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

/*
 * The fire feed's settings screen shows every `src/components/fire-feed/*.panel.tsx`
 * by file name, so this panel has to be a default export with that name.
 * And the rules for these pages are Mark's terms for using them at all, so
 * they must be on the screen, not just in the code.
 */
describe("Public incident pages panel", () => {
  it("is a default export, found by the settings screen's *.panel.tsx glob", () => {
    expect(SOURCE.match(/export default function PublicPagesPanel\(/)).not.toBeNull();
  });

  it("states the rules: government pages only, no logins or CAPTCHAs, robots.txt, two minutes", () => {
    const rules = SOURCE.match(/The rules this source follows[\s\S]*?<\/ul>/)![0];
    expect(rules).toContain("Public government pages only");
    expect(rules).toContain("No logins, no CAPTCHAs");
    expect(rules).toContain("robots.txt is read first and obeyed");
    expect(rules).toContain("Never more often than every 2 minutes");
  });

  it("asks for confirmation on a site that is not .gov or .us", () => {
    const ack = SOURCE.match(/\{needsAck && \([\s\S]*?<\/label>/)![0];
    expect(ack).toContain("I confirm it is a public government page");
  });
});
