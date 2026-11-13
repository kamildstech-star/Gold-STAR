import { describe, expect, it } from "vitest";

import { isIosLike } from "./platform";

/**
 * The estimate PDF preview is a blank grey box on iOS and iPadOS, because
 * WebKit will not render a `blob:` URL in an iframe. Everywhere else the
 * iframe is correct and must be left alone — so this detection decides which
 * of two working previews a person gets, and getting it wrong degrades a
 * desktop for no reason.
 *
 * The interesting case is the iPad, which has claimed to be a Mac since
 * iPadOS 13 and is told apart only by its touch points.
 */

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_LEGACY =
  "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1";
/** iPadOS 13+ in its default "desktop" mode — indistinguishable by UA alone. */
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const MAC_SAFARI = IPAD_AS_MAC;
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
/** A Windows laptop with a touchscreen: touch points, but not an iPad. */
const WINDOWS_TOUCH = WINDOWS_CHROME;

describe("isIosLike", () => {
  it("recognizes an iPhone", () => {
    expect(isIosLike({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true);
  });

  it("recognizes an iPad that still says iPad", () => {
    expect(isIosLike({ userAgent: IPAD_LEGACY, maxTouchPoints: 5 })).toBe(true);
  });

  /* The case the whole helper exists for. */
  it("recognizes an iPad pretending to be a Mac", () => {
    expect(isIosLike({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 })).toBe(true);
  });

  it("does not mistake a real Mac for an iPad", () => {
    // Same user-agent string as the iPad above; only the touch points differ.
    expect(isIosLike({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toBe(false);
    expect(isIosLike({ userAgent: MAC_CHROME, maxTouchPoints: 0 })).toBe(false);
  });

  it("does not fire on a touchscreen laptop that is not an iPad", () => {
    expect(isIosLike({ userAgent: WINDOWS_TOUCH, maxTouchPoints: 10 })).toBe(false);
    expect(isIosLike({ userAgent: ANDROID_CHROME, maxTouchPoints: 5 })).toBe(false);
  });

  it("ignores a stray single touch point on a Mac", () => {
    // `> 1`, not `> 0` — the same threshold detectPlatform() uses.
    expect(isIosLike({ userAgent: MAC_SAFARI, maxTouchPoints: 1 })).toBe(false);
  });

  it("answers false where there is no navigator at all", () => {
    // SSR and the thumbnail-capture context: the server must render the same
    // markup a desktop gets, not an iOS fallback nobody asked for.
    expect(isIosLike(null)).toBe(false);
  });

  it("survives a probe with missing fields", () => {
    expect(isIosLike({ userAgent: "", maxTouchPoints: 0 })).toBe(false);
    expect(isIosLike({ userAgent: IPHONE } as never)).toBe(true);
    expect(isIosLike({ userAgent: MAC_SAFARI } as never)).toBe(false);
  });
});
