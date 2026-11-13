// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Confirmed address — open in Maps". Mark, 14 Oct: it showed Chrome's
 * "www.google.com is blocked … ERR_BLOCKED_BY_RESPONSE" for
 * https://www.google.com/maps/search/?api=1&query=40.09,-74.25.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toasts = vi.hoisted(() => ({ ok: [] as string[] }));
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toasts.ok.push(m), error: () => {} },
}));

import { MapsLink } from "./maps-link";
import { EXTERNAL_LINK_REL, googleMapsSearchUrl, isFramed } from "@/lib/maps-links";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  toasts.ok = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function render(el: ReturnType<typeof createElement>) {
  await act(async () => root.render(el));
}

describe("googleMapsSearchUrl", () => {
  it("builds Google's canonical search URL for a point", () => {
    expect(googleMapsSearchUrl({ lat: 40.09, lon: -74.25 })).toBe(
      "https://www.google.com/maps/search/?api=1&query=40.09,-74.25",
    );
  });
  it("encodes an address", () => {
    expect(googleMapsSearchUrl(" 12 Main St, Lakewood NJ ")).toBe(
      "https://www.google.com/maps/search/?api=1&query=12%20Main%20St%2C%20Lakewood%20NJ",
    );
  });
  it("has no URL for nothing", () => {
    expect(googleMapsSearchUrl("  ")).toBeNull();
    expect(googleMapsSearchUrl(null)).toBeNull();
    expect(googleMapsSearchUrl({ lat: Number.NaN, lon: 1 })).toBeNull();
  });
  it("knows a framed page from a top-level one", () => {
    const top = {} as Window;
    expect(isFramed({ self: top, top } as never)).toBe(false);
    expect(isFramed({ self: {} as Window, top } as never)).toBe(true);
    expect(isFramed(undefined)).toBe(false);
  });
});

describe("MapsLink", () => {
  it("is a plain new-tab link with no opener and no referrer, to the canonical URL", async () => {
    await render(
      createElement(MapsLink, {
        query: { lat: 40.09, lon: -74.25 },
        children: "Confirmed address",
      }),
    );
    const a = container.querySelector<HTMLAnchorElement>("a[data-maps-link]")!;
    expect(a.getAttribute("href")).toBe(
      "https://www.google.com/maps/search/?api=1&query=40.09,-74.25",
    );
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(EXTERNAL_LINK_REL).toBe("noopener noreferrer");
    // Top level, nothing to copy.
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing without a place", async () => {
    await render(createElement(MapsLink, { query: "", children: "Directions" }));
    expect(container.innerHTML).toBe("");
  });

  it("offers to copy the link when the app is inside a frame", async () => {
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await render(
      createElement(MapsLink, {
        query: { lat: 40.09, lon: -74.25 },
        children: "Confirmed address",
      }),
    );
    const copy = container.querySelector<HTMLButtonElement>("button")!;
    expect(copy.textContent).toContain("Copy link");
    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      "https://www.google.com/maps/search/?api=1&query=40.09,-74.25",
    );
    expect(toasts.ok).toEqual(["Maps link copied. Paste it into a new tab."]);
  });
});

describe("every Google Maps link in the app", () => {
  const SRC = join(process.cwd(), "src");
  const list = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return list(p);
      return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
    });
  /** Read once: the source sweep is the slow part. Only files that mention maps. */
  let cache: { path: string; text: string }[] | null = null;
  const sources = () =>
    (cache ??= list(SRC)
      .map((path) => ({ path, text: readFileSync(path, "utf8") }))
      .filter((f) => /google\.com\/maps|mapsDeepLink/.test(f.text)));

  it("builds a maps search URL only through the shared helper", () => {
    const offenders = sources()
      .filter((f) => !f.path.endsWith(join("lib", "maps-links.ts")))
      .filter((f) => f.text.includes("google.com/maps/search"))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  }, 60_000);

  it("puts the intake inbox's confirmed address through MapsLink", () => {
    const inbox = readFileSync(join(SRC, "routes", "_authenticated", "intake-inbox.tsx"), "utf8");
    expect(inbox).toMatch(
      /<MapsLink[\s\S]*?query=\{point\}[\s\S]*?Confirmed address — open in Maps/,
    );
  });

  it("never opens a map without noopener", () => {
    const bad = sources()
      .filter((f) => /window\.open\(\s*mapsDeepLink[^;]{0,200}?"_blank"\s*\)/.test(f.text))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  }, 60_000);
});
