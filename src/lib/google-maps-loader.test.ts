import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeScript = {
  src: string;
  async: boolean;
  onerror?: () => void;
  remove: ReturnType<typeof vi.fn>;
};
let scripts: FakeScript[];
let browser: Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY", "test-browser-key");
  scripts = [];
  browser = { location: { hostname: "preview.lovable.app" } };
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", {
    createElement: () => ({ src: "", async: false, remove: vi.fn() }),
    head: { appendChild: (script: FakeScript) => scripts.push(script) },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function finishScript(script: FakeScript) {
  const callback = new URL(script.src).searchParams.get("callback")!;
  (browser[callback] as () => void)();
}

describe("Google Maps loading", () => {
  it("shares a pending load across map surfaces", async () => {
    const { loadGoogleMaps } = await import("./google-maps-loader");
    const first = loadGoogleMaps();
    expect(loadGoogleMaps()).toBe(first);
    expect(scripts).toHaveLength(1);
    finishScript(scripts[0]);
    await expect(first).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends a stalled download and permits a fresh retry", async () => {
    const { loadGoogleMaps } = await import("./google-maps-loader");
    const first = loadGoogleMaps();
    const rejection = expect(first).rejects.toMatchObject({ reason: "script" });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(scripts[0].remove).toHaveBeenCalled();
    const retry = loadGoogleMaps();
    expect(scripts).toHaveLength(2);
    expect(scripts[1].src).not.toBe(scripts[0].src);
    finishScript(scripts[1]);
    await expect(retry).resolves.toBeUndefined();
  });
  it("rejects a pending request on Google's auth failure callback", async () => {
    const { loadGoogleMaps } = await import("./google-maps-loader");
    const pending = loadGoogleMaps();
    const rejection = expect(pending).rejects.toMatchObject({ reason: "auth" });
    (browser.gm_authFailure as () => void)();
    await rejection;
    browser.google = { maps: { Map: function Map() {} } };
    await expect(loadGoogleMaps()).rejects.toMatchObject({ reason: "auth" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("allows retry after a network error", async () => {
    const { loadGoogleMaps } = await import("./google-maps-loader");
    const pending = loadGoogleMaps();
    const rejection = expect(pending).rejects.toMatchObject({ reason: "script" });
    scripts[0].onerror!();
    await rejection;
    const retry = loadGoogleMaps();
    finishScript(scripts[1]);
    await expect(retry).resolves.toBeUndefined();
  });
  it("reports absent build configuration without downloading a script", async () => {
    vi.stubEnv("VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY", "");
    const { loadGoogleMaps } = await import("./google-maps-loader");
    await expect(loadGoogleMaps()).rejects.toMatchObject({ reason: "no-key" });
    expect(scripts).toHaveLength(0);
  });
});

/**
 * Mark: "why isnt this working??" — after a day of WhatsApp with the Cloud
 * admin, who had already added the referrer and already enabled Maps
 * JavaScript API, because those were the only two causes this message named.
 *
 * `gm_authFailure` fires for at least four reasons and Google does not tell
 * the page which. These assertions exist so nobody trims the message back to
 * the two that are usually already right.
 */
describe("what a rejected key tells you", () => {
  it("names every cause, not just the two people check first", async () => {
    const { describeMapsFailure } = await import("./google-maps-loader");
    const { detail } = describeMapsFailure("auth");
    expect(detail).toMatch(/referrer/i);
    expect(detail).toMatch(/billing/i);
    // The one that cannot be fixed in the Cloud console at all.
    expect(detail).toMatch(/rebuilt|build made before/i);
  });

  it("names the APIs the browser key actually needs, and only those", async () => {
    // The SDK itself and Directions (which cockpit-map runs through the SDK)
    // are the browser key's business. The static image in chase-prefetch and
    // the street view in chase.jobs used to be built in the browser with this
    // key too; they are fetched server-side now, so telling the Cloud admin to
    // enable Maps Static or Street View Static on the BROWSER key sends them
    // to fix a thing that does not need fixing.
    const { describeMapsFailure } = await import("./google-maps-loader");
    const { detail } = describeMapsFailure("auth");
    for (const api of ["Maps JavaScript", "Directions"]) expect(detail).toContain(api);
    for (const api of ["Maps Static", "Street View"]) expect(detail).not.toContain(api);
  });

  it("says which key the build shipped with, so it can be told from the one being edited", async () => {
    vi.stubEnv("VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY", "AIzaSyTESTKEY123456");
    const { keyHint } = await import("./google-maps-loader");
    expect(keyHint()).toContain("123456");
    expect(keyHint()).not.toContain("AIzaSyTESTKEY");
  });

  it("says so plainly when the build has no key at all", async () => {
    vi.stubEnv("VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY", "");
    const { keyHint } = await import("./google-maps-loader");
    expect(keyHint()).toBe("This build has no key.");
  });
});
