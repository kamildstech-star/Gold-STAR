import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_ORIGIN,
  configuredAppOrigin,
  joinOrigin,
  normalizeOrigin,
  serverAppOrigin,
} from "./app-origin";
import { walkFiles } from "./source-files";

describe("the app's public address", () => {
  it("defaults to the Lovable host when nothing is configured (Lovable today)", () => {
    expect(DEFAULT_APP_ORIGIN).toBe("https://flood-hero-hub.lovable.app");
    expect(serverAppOrigin({})).toBe(DEFAULT_APP_ORIGIN);
    expect(configuredAppOrigin({})).toBeNull();
  });

  it("keeps the order the server copies used: VITE_PUBLIC_SITE_URL, then PUBLIC_SITE_URL", () => {
    expect(
      serverAppOrigin({
        VITE_PUBLIC_SITE_URL: "https://a.example",
        PUBLIC_SITE_URL: "https://b.example",
      }),
    ).toBe("https://a.example");
    expect(serverAppOrigin({ PUBLIC_SITE_URL: "https://b.example/" })).toBe("https://b.example");
  });

  it("reduces whatever was typed to an origin, and ignores what is not a URL", () => {
    expect(normalizeOrigin(" https://goldstar.falconstaging.com/ ")).toBe(
      "https://goldstar.falconstaging.com",
    );
    expect(normalizeOrigin("https://x.example/some/path")).toBe("https://x.example");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of [
      "",
      "   ",
      "goldstar.falconstaging.com",
      "ftp://x.example",
      undefined,
      null,
    ]) {
      expect(normalizeOrigin(bad), String(bad)).toBeNull();
    }
    expect(serverAppOrigin({ PUBLIC_SITE_URL: "not a url" })).toBe(DEFAULT_APP_ORIGIN);
  });

  it("joins with exactly one slash", () => {
    expect(joinOrigin("https://x.example/", "/api/public/hooks/outlook")).toBe(
      "https://x.example/api/public/hooks/outlook",
    );
    expect(joinOrigin("https://x.example", "intake/abc")).toBe("https://x.example/intake/abc");
  });
});

describe("no other file builds a link from a host of its own", () => {
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

  it("the server builders go through app-origin.ts", () => {
    for (const p of [
      "src/lib/automation-jobs.server.ts",
      "src/lib/graph.server.ts",
      "src/lib/integrations.functions.ts",
      "src/lib/raven.server.ts",
    ]) {
      const src = read(p);
      expect(src, p).not.toMatch(/process\.env\[["'](?:VITE_)?PUBLIC_SITE_URL["']\]/);
      expect(src, p).not.toMatch(/https:\/\/flood-hero-hub\.lovable\.app/);
      expect(src, p).toMatch(/from "(?:\.\/|@\/lib\/)app-origin"/);
    }
  });

  it("links someone else opens use browserAppOrigin(), not the address bar", () => {
    const builders = [
      "src/lib/document-send.ts",
      "src/lib/intake-inbox.ts",
      "src/lib/job-share-links.ts",
      "src/lib/portal.ts",
      "src/lib/tradeshow-intake.ts",
      "src/components/job-email-dialog.tsx",
      "src/components/google-review-link-tab.tsx",
      "src/routes/_authenticated/admin.integrations.tsx",
    ];
    for (const p of builders) {
      const src = read(p);
      expect(src, p).not.toMatch(/window\.location\.origin/);
      expect(src, p).toMatch(/browserAppOrigin\(\)/);
    }
  });

  it("PUBLIC_SITE_URL is read in app-origin.ts and nowhere else in the app", () => {
    // TODO(remove after cutover): secret-transfer.ts NAMES PUBLIC_SITE_URL on
    // its exclusion list (every env name in src must be on one list or the
    // other) and never reads it; it goes when the transfer does.
    const namesOnly = new Set(["src/lib/secret-transfer.ts"]);
    const readers = walkFiles("src")
      .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))
      .filter((p) => !namesOnly.has(p))
      .filter((p) => /PUBLIC_SITE_URL/.test(read(p).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")));
    expect(readers).toEqual(["src/lib/app-origin.ts"]);
  });
});
