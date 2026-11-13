import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark: "make this a web app with install feature for both apple and android"
 *
 * Source guards for the parts that no unit can exercise: the manifest fields
 * Chrome's installability check reads, the head tags iOS reads instead of the
 * manifest, the menu entry, and the update toast. Each assertion cuts out the
 * fragment it is about rather than matching the whole file.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("the web app manifest", () => {
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
    id: string;
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };

  it("names the app and opens it full-screen at the dashboard", () => {
    expect(manifest.name).toBe("Recovery Hub");
    expect(manifest.short_name).toBe("Recovery Hub");
    expect(manifest.display).toBe("standalone");
    expect(manifest.id).toBe("/");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    // start_url must sit inside scope or the installed app opens in a tab.
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
  });

  it("carries the icons Chrome and Android require, with a maskable one", () => {
    const png = manifest.icons.filter((i) => i.type === "image/png");
    const any = (size: string) =>
      png.some((i) => i.sizes === size && (i.purpose ?? "any").split(" ").includes("any"));
    expect(any("192x192")).toBe(true);
    expect(any("512x512")).toBe(true);
    // Lighthouse flags a single icon declared "any maskable": the safe zone
    // padding a maskable icon needs looks wrong as a plain icon.
    const maskable = png.filter((i) => i.purpose === "maskable");
    expect(maskable.map((i) => i.sizes)).toContain("512x512");
    expect(png.some((i) => i.purpose?.includes("any") && i.purpose.includes("maskable"))).toBe(
      false,
    );
  });

  it("declares the sizes the files actually are", () => {
    // Chrome rejects an icon whose declared size disagrees with the PNG.
    const pngSize = (path: string) => {
      const buf = readFileSync(path);
      return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    };
    for (const icon of manifest.icons) {
      expect(pngSize(`public${icon.src}`), icon.src).toBe(icon.sizes);
    }
    expect(pngSize("public/apple-touch-icon.png")).toBe("180x180");
  });

  it("paints the splash in the sign-in ground and the status bar in brand navy", () => {
    expect(manifest.background_color).toBe("#fbfbfa");
    expect(manifest.theme_color).toBe("#10243d");
  });
});

describe("the root route's head", () => {
  const ROOT = read("src/routes/__root.tsx");
  const meta = (name: string) => {
    const m = ROOT.match(new RegExp(`\\{ name: "${name}", content: "([^"]*)" \\}`));
    return m?.[1];
  };

  it("carries the tags iOS reads instead of the manifest", () => {
    expect(meta("apple-mobile-web-app-capable")).toBe("yes");
    expect(meta("apple-mobile-web-app-status-bar-style")).toBe("default");
    expect(meta("apple-mobile-web-app-title")).toBe("Recovery Hub");
    expect(ROOT).toMatch(
      /\{ rel: "apple-touch-icon", sizes: "180x180", href: "\/apple-touch-icon\.png" \}/,
    );
  });

  it("matches theme-color to the manifest", () => {
    expect(meta("theme-color")).toBe("#10243d");
  });

  it("starts listening for beforeinstallprompt alongside the worker", () => {
    expect(ROOT).toMatch(/registerAppServiceWorker\(\);\s*listenForInstallPrompt\(\);/);
  });
});

describe("the install entry in the user menu", () => {
  const SHELL = read("src/components/app-shell.tsx");

  it("sits above Security & two-factor, where the account actions are", () => {
    const at = SHELL.indexOf("<InstallMenuItem />");
    expect(at, "menu entry not found").toBeGreaterThan(-1);
    const security = SHELL.indexOf("Security &amp; two-factor", at);
    expect(security).toBeGreaterThan(at);
    // Same menu, not a different dropdown: no separator or unrelated item between them.
    expect(SHELL.slice(at, security)).not.toContain("<DropdownMenuSeparator");
  });

  it("mounts the banner in the scrollport and the iPhone sheet once in the shell", () => {
    expect(SHELL).toMatch(/<SyncBanner \/>[\s\S]{0,200}<InstallBanner \/>/);
    expect(SHELL.match(/<IosInstallSheetHost \/>/g)).toHaveLength(1);
  });
});

describe("the update toast", () => {
  const SW = read("src/lib/register-sw.ts");
  const CONFIG = read("vite.config.ts");

  it("offers Reload and stays until acted on", () => {
    const at = SW.indexOf('toast("Update available"');
    expect(at, "toast not found").toBeGreaterThan(-1);
    const call = SW.slice(at, SW.indexOf("});", at));
    expect(call).toContain("duration: Infinity");
    expect(call).toMatch(/action: \{ label: "Reload"/);
  });

  it("only fires for an update, never the first install", () => {
    expect(SW).toMatch(/installing\.state === "installed" && navigator\.serviceWorker\.controller/);
  });

  it("builds a worker that can be evaluated: no SPA fallback in a server-rendered app", () => {
    // The default `navigateFallback: "index.html"` made the built worker throw
    // `non-precached-url` on evaluation, so nothing ever registered.
    expect(CONFIG).toMatch(/navigateFallback: null/);
    expect(CONFIG).not.toMatch(/navigateFallbackDenylist/);
  });

  it("is the only thing that lets a new worker take over", () => {
    expect(CONFIG).toMatch(/registerType: "prompt"/);
    expect(CONFIG).toMatch(/skipWaiting: false/);
    expect(CONFIG).toMatch(/clientsClaim: true/);
    expect(SW).toContain('waiting.postMessage({ type: "SKIP_WAITING" })');
  });
});

/**
 * Melly, 17 Sep: "if you can make a web app, that would be much better... you
 * get a downloadable app and you download it and it shows up as an icon...
 * when you open it, it doesn't have the top banner, the bottom banner."
 *
 * The manifest, the icons and the iOS meta tags were already right, and his
 * session showed browser chrome for the ordinary reason: he had not installed
 * it. What was missing was a path to installing on the one platform with a
 * real install — Android, where Chrome fires `beforeinstallprompt` on its own
 * engagement schedule and the entry rendered nothing until it did.
 */
describe("there is always an install path where the platform has one", () => {
  const SOURCE = readFileSync("src/components/install-prompt.tsx", "utf8").replace(/\r\n/g, "\n");

  it("shows the menu entry on Chrome-family whether or not the prompt has fired", () => {
    const item = SOURCE.match(/export function InstallMenuItem\(\)[\s\S]*?\n}\n/)![0];
    // The old gate was `if (!canPrompt) return null`, which hid it entirely.
    expect(item).not.toMatch(/if \(!canPrompt\) return null/);
    expect(item).toContain('if (platform !== "prompt") return null');
    expect(item).toContain("canPrompt ? void promptInstall() : openManualInstallSheet()");
  });

  it("still shows nothing where the browser genuinely cannot install", () => {
    // An entry opening instructions for a button that does not exist is worse
    // than no entry.
    const item = SOURCE.match(/export function InstallMenuItem\(\)[\s\S]*?\n}\n/)![0];
    expect(item).toContain('platform !== "prompt"');
  });

  it("falls back to steps in the phone banner too", () => {
    const banner = SOURCE.match(/export function InstallBanner\(\)[\s\S]*?\n}\n/)![0];
    expect(banner).toContain("openManualInstallSheet()");
  });

  it("tells an Android user where their browser hides it", () => {
    const sheet = SOURCE.match(/function ManualInstallSheet\([\s\S]*?\n}\n/)![0];
    expect(sheet).toContain("Install app");
    expect(sheet).toContain("Add to Home screen");
    // Deliberately vague: Chrome, Edge and Samsung Internet each word it
    // differently and all three are in the field.
    expect(sheet).toContain("depends on");
  });

  it("warns about the separate sign-in on iPhone only, where it is true", () => {
    // iOS gives a home-screen app its own storage; Android's installed app
    // shares Chrome's and opens signed in. The warning used to sit on the
    // Android steps.
    const manual = SOURCE.match(/function ManualInstallSheet\([\s\S]*?\n}\n/)![0];
    const markup = manual.slice(manual.indexOf("return ("));
    expect(markup).not.toMatch(/sign[ -]in/i);
    const ios = SOURCE.match(/export function IosInstallSheet\([\s\S]*?\n}\n/)![0];
    expect(ios).toMatch(/keeps its own sign-in/);
  });
});

/**
 * Mark: "iphone and android, should be a way to install it"
 */
describe("install on both phones, from the first screen they see", () => {
  const SOURCE = read("src/components/install-prompt.tsx");
  const AUTH = read("src/routes/auth.tsx");

  it("offers the install on the sign-in page, with the sheets mounted there", () => {
    // The shell (and its sheet host) is not on /auth, so the page mounts its own.
    const card = AUTH.indexOf("</Card>");
    expect(card).toBeGreaterThan(-1);
    const after = AUTH.slice(card, AUTH.indexOf("tel:+1", card));
    expect(after).toContain("<InstallHint />");
    expect(after).toContain("<IosInstallSheetHost />");
  });

  it("draws the sign-in hint only where there is an install, and only on phones", () => {
    const hint = SOURCE.match(/export function InstallHint\(\)[\s\S]*?\n}\n/)![0];
    expect(hint).toContain('if (platform !== "ios" && platform !== "prompt") return null');
    expect(hint).toMatch(/className="[^"]*\bmd:hidden\b/);
    expect(hint).toContain("canPrompt ? void promptInstall() : openManualInstallSheet()");
    expect(hint).toContain("openIosInstallSheet()");
  });

  it("sends a non-Safari iPhone browser to Safari, and an Android in-app browser to Chrome", () => {
    const ios = SOURCE.match(/export function IosInstallSheet\([\s\S]*?\n}\n/)![0];
    expect(ios).toContain('currentInstallGuide() !== "ios-open-in-safari"');
    expect(ios).toMatch(/Open this page in <span className="font-semibold">Safari<\/span> first/);
    const manual = SOURCE.match(/function ManualInstallSheet\([\s\S]*?\n}\n/)![0];
    expect(manual).toContain('currentInstallGuide() === "android-open-in-chrome"');
    expect(manual).toMatch(/Open in Chrome/);
  });

  it("finds Share where iOS 26 moved it", () => {
    const ios = SOURCE.match(/export function IosInstallSheet\([\s\S]*?\n}\n/)![0];
    expect(ios).toContain("<ShareGlyph />");
    expect(ios).toMatch(/tap <span className="font-semibold">•••<\/span> first/);
  });

  it("sizes the phone banner's buttons for a thumb", () => {
    const banner = SOURCE.match(/export function InstallBanner\(\)[\s\S]*?\n}\n/)![0];
    expect(banner).not.toMatch(/\b(?:h|size)-7\b/);
    expect(banner).toMatch(/className="h-10 /);
    expect(banner).toMatch(/className="grid size-10 /);
  });

  it("lets the installed Android app turn sideways, as iPhone already does", () => {
    // iOS ignores manifest orientation; Android honoured "portrait-primary"
    // and locked the wide drying grid and tables to portrait.
    const manifest = JSON.parse(read("public/manifest.webmanifest")) as { orientation?: string };
    expect(manifest.orientation ?? "any").toBe("any");
  });

  it("declares each install meta tag once", () => {
    const ROOT = read("src/routes/__root.tsx");
    for (const name of ["mobile-web-app-capable", "apple-mobile-web-app-capable"]) {
      const tags = ROOT.match(new RegExp(`\\{ name: "${name}", content: "yes" \\}`, "g"));
      expect(tags, name).toHaveLength(1);
    }
  });
});

describe("the head declares itself installable to both platforms", () => {
  const ROOT_HEAD = readFileSync("src/routes/__root.tsx", "utf8").replace(/\r\n/g, "\n");

  it("carries the standards name as well as Apple's", () => {
    // Chrome warns about the Apple-only spelling; iOS honours no other, so
    // both have to be there.
    expect(ROOT_HEAD).toContain('{ name: "mobile-web-app-capable", content: "yes" }');
    expect(ROOT_HEAD).toContain('{ name: "apple-mobile-web-app-capable", content: "yes" }');
  });

  it("still links the manifest and the iOS icon", () => {
    expect(ROOT_HEAD).toContain('rel: "manifest", href: "/manifest.webmanifest"');
    expect(ROOT_HEAD).toContain('rel: "apple-touch-icon"');
  });
});

describe("the manifest asks for a full-screen window", () => {
  const MANIFEST = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8")) as {
    display: string;
    name: string;
    icons: { sizes: string; purpose: string }[];
  };

  it("is standalone, which is what removes the browser bars", () => {
    expect(MANIFEST.display).toBe("standalone");
  });

  it("carries the icon sizes Android needs, maskable included", () => {
    const sizes = MANIFEST.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toContain("192x192:any");
    expect(sizes).toContain("512x512:any");
    expect(sizes).toContain("512x512:maskable");
  });
});
