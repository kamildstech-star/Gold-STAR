import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TURNSTILE_MIN_FLEXIBLE_WIDTH, turnstileSize } from "./turnstile-widget";

describe("turnstileSize", () => {
  it("draws the compact widget where 300px does not fit", () => {
    // Sign-in card content box on a 320px phone, and on a 360px one.
    expect(turnstileSize(256)).toBe("compact");
    expect(turnstileSize(296)).toBe("compact");
    expect(turnstileSize(TURNSTILE_MIN_FLEXIBLE_WIDTH - 1)).toBe("compact");
  });

  it("fills the form from 300px up, Cloudflare's floor for flexible", () => {
    expect(turnstileSize(TURNSTILE_MIN_FLEXIBLE_WIDTH)).toBe("flexible");
    expect(turnstileSize(398)).toBe("flexible");
  });

  it("never asks for the fixed 300px default", () => {
    for (const w of [0, 150, 299, 300, 1200]) expect(turnstileSize(w)).not.toBe("normal");
  });
});

describe("the widget's wiring", () => {
  const SRC = readFileSync("src/components/turnstile-widget.tsx", "utf8").replace(/\r\n/g, "\n");

  it("sizes from the container it is about to render into", () => {
    const load = SRC.match(
      /loadScript\(\)\s*\.then\(\(\) => \{[\s\S]*?window\.turnstile\.render\(containerRef\.current, \{[\s\S]*?\}\);/,
    )![0];
    expect(load).toMatch(/const size = turnstileSize\(containerRef\.current\.clientWidth\);/);
    expect(load).toMatch(/containerRef\.current\.dataset\.size = size;/);
    expect(load).toMatch(/theme: "auto",\s*size,/);
  });

  it("gives the container the form's full width, and a flexible widget all of it", () => {
    const box = SRC.match(/ref=\{containerRef\}\s*id=\{containerId\}\s*className="([^"]*)"/)![1];
    expect(box.split(" ")).toEqual(
      expect.arrayContaining(["w-full", "justify-center", "data-[size=flexible]:[&>div]:w-full"]),
    );
  });

  it("still loads only from challenges.cloudflare.com, which the CSP allows", () => {
    const src = SRC.match(/const SCRIPT_SRC =\s*"([^"]*)"/)![1];
    expect(new URL(src).origin).toBe("https://challenges.cloudflare.com");
    const CSP = readFileSync("src/lib/security-response.ts", "utf8");
    const frame = CSP.match(/"frame-src": \[([^\]]*)\]/)![1];
    expect(frame).toContain('"https://challenges.cloudflare.com"');
  });
});
