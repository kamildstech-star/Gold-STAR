import { describe, expect, it } from "vitest";

import {
  DISMISS_FOR_MS,
  detectInstallPlatform,
  installGuide,
  isIosDevice,
  isIosSafari,
  shouldOfferInstall,
  type PlatformInputs,
} from "./pwa-install";

/**
 * Mark: "make this a web app with install feature for both apple and android"
 *
 * Which affordance a device gets, and how long a "not now" holds.
 */

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36";
const ANDROID_SAMSUNG =
  "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36";
const DESKTOP_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.2420.65";
const DESKTOP_FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0";
const MAC_SAFARI = IPAD_DESKTOP_UA;
const IPHONE_FIREFOX =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15";
const IPHONE_GOOGLE_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/310.0.621847700 Mobile/15E148 Safari/604.1";
const IPHONE_FACEBOOK =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/455.0.0.36.106;FBBV/580000000;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.4]";
const ANDROID_FIREFOX = "Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0";
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240305.019; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/123.0.6312.99 Mobile Safari/537.36";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const browser = (userAgent: string, over: Partial<PlatformInputs> = {}): PlatformInputs => ({
  userAgent,
  navigatorStandalone: undefined,
  displayModeStandalone: false,
  maxTouchPoints: 0,
  ...over,
});

describe("detectInstallPlatform", () => {
  it("offers the manual sheet on iPhone, in Safari or not", () => {
    expect(detectInstallPlatform(browser(IPHONE_SAFARI, { maxTouchPoints: 5 }))).toBe("ios");
    expect(detectInstallPlatform(browser(IPHONE_CHROME, { maxTouchPoints: 5 }))).toBe("ios");
  });

  it("sees through iPadOS's Mac user agent by its touch points", () => {
    expect(detectInstallPlatform(browser(IPAD_DESKTOP_UA, { maxTouchPoints: 5 }))).toBe("ios");
    // A real Mac has no touch points and desktop Safari has no install API.
    expect(detectInstallPlatform(browser(MAC_SAFARI, { maxTouchPoints: 0 }))).toBe("none");
  });

  it("uses the browser prompt on Android and desktop Chromium", () => {
    expect(detectInstallPlatform(browser(ANDROID_CHROME, { maxTouchPoints: 5 }))).toBe("prompt");
    expect(detectInstallPlatform(browser(ANDROID_SAMSUNG, { maxTouchPoints: 5 }))).toBe("prompt");
    expect(detectInstallPlatform(browser(DESKTOP_EDGE))).toBe("prompt");
  });

  it("draws nothing on a browser with no way to install", () => {
    expect(detectInstallPlatform(browser(DESKTOP_FIREFOX))).toBe("none");
  });

  it("offers Firefox on Android the menu steps instead of nothing", () => {
    // It has "Install" in its menu and never fires beforeinstallprompt; it
    // used to fall through to "none" and get no install path at all.
    expect(detectInstallPlatform(browser(ANDROID_FIREFOX, { maxTouchPoints: 5 }))).toBe("prompt");
  });

  it("offers nothing once running from the home screen, by either flag", () => {
    expect(
      detectInstallPlatform(
        browser(IPHONE_SAFARI, { maxTouchPoints: 5, navigatorStandalone: true }),
      ),
    ).toBe("installed");
    expect(
      detectInstallPlatform(
        browser(ANDROID_CHROME, { maxTouchPoints: 5, displayModeStandalone: true }),
      ),
    ).toBe("installed");
  });
});

describe("isIosDevice / isIosSafari", () => {
  it("tells Safari from the other iOS browsers, which brand their user agent", () => {
    expect(isIosDevice(IPHONE_CHROME, 5)).toBe(true);
    expect(isIosSafari(IPHONE_SAFARI, 5)).toBe(true);
    expect(isIosSafari(IPHONE_CHROME, 5)).toBe(false);
  });
});

describe("shouldOfferInstall — the dismissal rule", () => {
  const now = Date.parse("2026-09-17T12:00:00Z");

  it("offers when nothing has been recorded", () => {
    expect(shouldOfferInstall({ now, dismissedAt: null, installedAt: null })).toBe(true);
  });

  it("holds off for fourteen days after a dismissal, then asks again", () => {
    expect(DISMISS_FOR_MS).toBe(14 * 24 * 60 * 60 * 1000);
    const dismissedAt = String(now - DISMISS_FOR_MS + 60_000);
    expect(shouldOfferInstall({ now, dismissedAt, installedAt: null })).toBe(false);
    const longAgo = String(now - DISMISS_FOR_MS);
    expect(shouldOfferInstall({ now, dismissedAt: longAgo, installedAt: null })).toBe(true);
  });

  it("never offers again once appinstalled has fired here", () => {
    expect(shouldOfferInstall({ now, dismissedAt: null, installedAt: String(now - 1) })).toBe(
      false,
    );
  });

  it("treats a stamp that does not parse as no stamp, not as a permanent mute", () => {
    expect(shouldOfferInstall({ now, dismissedAt: "yesterday", installedAt: null })).toBe(true);
  });
});

/**
 * Mark: "iphone and android, should be a way to install it"
 *
 * The full matrix a crew member's phone can land in. Each case is a real
 * user agent string; the touch-point count is what a phone reports.
 */
describe("installGuide — how this phone installs, from where it is", () => {
  const phone = (ua: string, over: Partial<PlatformInputs> = {}) =>
    installGuide(browser(ua, { maxTouchPoints: 5, ...over }));

  it("walks an iPhone in Safari through Share → Add to Home Screen", () => {
    expect(phone(IPHONE_SAFARI)).toBe("ios-safari");
    expect(phone(IPAD_DESKTOP_UA)).toBe("ios-safari");
  });

  it("sends an iPhone in Chrome or Firefox to Safari first", () => {
    expect(phone(IPHONE_CHROME)).toBe("ios-open-in-safari");
    expect(phone(IPHONE_FIREFOX)).toBe("ios-open-in-safari");
  });

  it("sends an iPhone in an app's built-in browser to Safari first", () => {
    // A link tapped in the Google app or Facebook: no Add to Home Screen there.
    expect(phone(IPHONE_GOOGLE_APP)).toBe("ios-open-in-safari");
    expect(phone(IPHONE_FACEBOOK)).toBe("ios-open-in-safari");
    expect(isIosSafari(IPHONE_GOOGLE_APP, 5)).toBe(false);
  });

  it("gives every real Android browser the install path", () => {
    expect(phone(ANDROID_CHROME)).toBe("android");
    expect(phone(ANDROID_SAMSUNG)).toBe("android");
    expect(phone(ANDROID_FIREFOX)).toBe("android");
  });

  it("sends an Android in-app WebView to Chrome first", () => {
    // Says Chrome in the user agent, cannot install.
    expect(phone(ANDROID_WEBVIEW)).toBe("android-open-in-chrome");
    expect(detectInstallPlatform(browser(ANDROID_WEBVIEW, { maxTouchPoints: 5 }))).toBe("prompt");
  });

  it("says nothing on a phone already running the installed app", () => {
    expect(phone(IPHONE_SAFARI, { navigatorStandalone: true })).toBe("installed");
    expect(phone(IPHONE_CHROME, { navigatorStandalone: true })).toBe("installed");
    expect(phone(ANDROID_CHROME, { displayModeStandalone: true })).toBe("installed");
    expect(phone(ANDROID_SAMSUNG, { displayModeStandalone: true })).toBe("installed");
  });

  it("tells computers apart: Chromium can install, Firefox and Mac Safari cannot", () => {
    expect(installGuide(browser(DESKTOP_CHROME))).toBe("desktop");
    expect(installGuide(browser(DESKTOP_EDGE))).toBe("desktop");
    expect(installGuide(browser(DESKTOP_FIREFOX))).toBe("none");
    expect(installGuide(browser(MAC_SAFARI))).toBe("none");
  });
});
