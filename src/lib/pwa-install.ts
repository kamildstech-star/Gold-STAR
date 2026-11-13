/**
 * Install-to-home-screen, both platforms.
 *
 * Mark: "make this a web app with install feature for both apple and android"
 *
 * Android, desktop Chrome and Edge fire `beforeinstallprompt` once the page
 * meets the installability bar; we keep that event and call `prompt()` on it
 * when the person taps Install. iOS has no such API — never has — so there the
 * "install feature" is a sheet that walks them through Share → Add to Home
 * Screen → Add. Both hang off the same rule: offer once, and if they wave it
 * away, stay quiet for a fortnight. A CRM that begs to be installed every
 * morning is one people stop opening.
 *
 * The pure parts (platform detection, the dismissal window) live here without
 * DOM access so they can be unit-tested; the hook at the bottom is the only
 * thing that touches `window`.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * What the install affordance should do on this device.
 *
 * - `installed`: already running from the home screen; offer nothing.
 * - `prompt`: a browser that can install — Chromium, which may fire
 *   `beforeinstallprompt`, or any Android browser with an install entry in its
 *   menu. Whether the event has actually fired is a separate question — see
 *   the store.
 * - `ios`: Safari-family on iPhone/iPad; show the manual sheet.
 * - `none`: everything else (Firefox, desktop Safari). No affordance.
 */
export type InstallPlatform = "installed" | "prompt" | "ios" | "none";

export type PlatformInputs = {
  userAgent: string;
  /** `navigator.standalone` — Safari's flag, true when launched from the home screen. */
  navigatorStandalone: boolean | undefined;
  /** `matchMedia("(display-mode: standalone)").matches` — the standard flag. */
  displayModeStandalone: boolean;
  /** iPadOS reports a Mac user agent; touch points are how it gives itself away. */
  maxTouchPoints: number;
};

export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/*
 * Browsers on iOS that are not Safari and say so. Chrome, Firefox, Edge,
 * Opera and DuckDuckGo brand the user agent; so do the in-app browsers a link
 * opens in when it is tapped inside another app — the Google app (GSA),
 * Facebook, Instagram, LinkedIn, Snapchat, WeChat, LINE. A crew member who
 * taps the link Mark texts them lands in Safari; one who taps it in an email
 * or a group chat app often lands in one of these, and none of them has Add
 * to Home Screen. Gmail's in-app viewer is SFSafariViewController, which
 * reports itself as plain Safari and cannot be told apart — the sheet covers
 * that case in words.
 */
const IOS_NOT_SAFARI =
  /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|LinkedInApp|Snapchat|MicroMessenger|\bLine\//i;

/**
 * Every iOS browser is WebKit, but Safari's share sheet is the one place Add
 * to Home Screen is always found, and its steps are what the sheet describes.
 */
export function isIosSafari(userAgent: string, maxTouchPoints: number): boolean {
  if (!isIosDevice(userAgent, maxTouchPoints)) return false;
  return !IOS_NOT_SAFARI.test(userAgent);
}

/**
 * Android's in-app browsers are Chrome's engine in a WebView, which marks
 * itself `; wv)` — the user agent still says Chrome, but a WebView has no
 * install, no menu with "Add to Home screen", and never fires
 * `beforeinstallprompt`. The Facebook and Instagram browsers add their own
 * names as well.
 */
function isAndroidWebView(userAgent: string): boolean {
  return /;\s*wv\)|FBAN|FBAV|Instagram/i.test(userAgent);
}

/**
 * The precise answer to "how does this person install the app, from here?".
 * `detectInstallPlatform` folds it into the four affordances the UI draws;
 * the sheets read it to decide which caveat to show.
 *
 * - `installed`: running from the home screen already. Say nothing.
 * - `ios-safari`: Share → Add to Home Screen → Add.
 * - `ios-open-in-safari`: on an iPhone, but in Chrome or an app's built-in
 *   browser. The steps are Safari's, so the first step is getting there.
 * - `android`: Chrome, Samsung Internet, Edge, Firefox. Chromium may hand us
 *   `beforeinstallprompt` for a one-tap Install; every one of them has
 *   "Install app" / "Add to Home screen" in its menu whether or not it does.
 * - `android-open-in-chrome`: an app's built-in browser. Nothing to install
 *   from until the page is open in a real browser.
 * - `desktop`: Chrome or Edge on a computer — the prompt or the menu.
 * - `none`: desktop Firefox and Safari on a Mac. No install to describe.
 */
export type InstallGuide =
  | "installed"
  | "ios-safari"
  | "ios-open-in-safari"
  | "android"
  | "android-open-in-chrome"
  | "desktop"
  | "none";

export function installGuide(i: PlatformInputs): InstallGuide {
  if (i.navigatorStandalone === true || i.displayModeStandalone) return "installed";
  if (isIosDevice(i.userAgent, i.maxTouchPoints)) {
    return isIosSafari(i.userAgent, i.maxTouchPoints) ? "ios-safari" : "ios-open-in-safari";
  }
  if (/Android/i.test(i.userAgent)) {
    return isAndroidWebView(i.userAgent) ? "android-open-in-chrome" : "android";
  }
  // Desktop Chromium: Chrome, Edge, Opera, Brave. Firefox and Safari on a
  // computer never fire beforeinstallprompt and have no install menu entry.
  if (/Chrome|Chromium|Edg\/|OPR\//i.test(i.userAgent)) return "desktop";
  return "none";
}

export function detectInstallPlatform(i: PlatformInputs): InstallPlatform {
  switch (installGuide(i)) {
    case "installed":
      return "installed";
    case "ios-safari":
    case "ios-open-in-safari":
      return "ios";
    case "android":
    case "android-open-in-chrome":
    case "desktop":
      // "prompt" names the affordance — an Install entry that fires the
      // browser's prompt when there is one and opens the menu steps when
      // there is not. Firefox on Android gets the steps; it has the menu
      // entry and no event, and before it was offered nothing at all.
      return "prompt";
    default:
      return "none";
  }
}

/* ------------------------------------------------------------------------ */
/* Dismissal rule                                                            */
/* ------------------------------------------------------------------------ */

/** Fourteen days: long enough not to nag, short enough that a new phone gets asked again. */
export const DISMISS_FOR_MS = 14 * 24 * 60 * 60 * 1000;

export const DISMISSED_AT_KEY = "rh.pwa.install.dismissedAt";
export const INSTALLED_KEY = "rh.pwa.installed";

/**
 * Whether to show the banner or the menu entry right now.
 *
 * `installedAt` set means `appinstalled` fired on this browser: never offer
 * again, even in a tab (the app is on their home screen; the tab is just where
 * they happened to open a link). A dismissal holds for `DISMISS_FOR_MS`; a
 * stamp that does not parse is treated as no stamp rather than as a permanent
 * mute.
 */
export function shouldOfferInstall(args: {
  now: number;
  dismissedAt: string | null;
  installedAt: string | null;
}): boolean {
  if (args.installedAt) return false;
  if (!args.dismissedAt) return true;
  const at = Number(args.dismissedAt);
  if (!Number.isFinite(at)) return true;
  return args.now - at >= DISMISS_FOR_MS;
}

function readStamp(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStamp(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the worst case is being asked again.
  }
}

/* ------------------------------------------------------------------------ */
/* The captured event and its subscribers                                    */
/* ------------------------------------------------------------------------ */

/** Chromium's non-standard event; not in lib.dom. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

type Snapshot = {
  platform: InstallPlatform;
  /** The deferred Chromium event, once it has fired. */
  deferred: BeforeInstallPromptEvent | null;
  offered: boolean;
};

const listeners = new Set<() => void>();
let snapshot: Snapshot = { platform: "none", deferred: null, offered: false };
let listening = false;

const SERVER_SNAPSHOT: Snapshot = { platform: "none", deferred: null, offered: false };

function emit(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

function currentInputs(): PlatformInputs {
  return {
    userAgent: navigator.userAgent,
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
    displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  };
}

function currentPlatform(): InstallPlatform {
  return detectInstallPlatform(currentInputs());
}

/** This device's `installGuide`, or `none` during server rendering. */
export function currentInstallGuide(): InstallGuide {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "none";
  return installGuide(currentInputs());
}

function refreshOffered() {
  emit({
    offered: shouldOfferInstall({
      now: Date.now(),
      dismissedAt: readStamp(DISMISSED_AT_KEY),
      installedAt: readStamp(INSTALLED_KEY),
    }),
  });
}

/**
 * Start listening. Called once from the root route; Chrome fires
 * `beforeinstallprompt` after load and only after the manifest and worker
 * checks pass, so an effect on mount is early enough. Idempotent.
 */
export function listenForInstallPrompt(): void {
  if (typeof window === "undefined" || listening) return;
  listening = true;
  emit({ platform: currentPlatform() });
  refreshOffered();
  window.addEventListener("beforeinstallprompt", (e) => {
    // Chrome would otherwise show its own mini-infobar at a moment of its
    // choosing; we hold the event and prompt from our own button.
    e.preventDefault();
    emit({ deferred: e as BeforeInstallPromptEvent });
  });
  window.addEventListener("appinstalled", () => {
    writeStamp(INSTALLED_KEY, String(Date.now()));
    emit({ deferred: null, platform: "installed" });
    refreshOffered();
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function dismissInstallOffer(): void {
  writeStamp(DISMISSED_AT_KEY, String(Date.now()));
  refreshOffered();
}

/**
 * What the UI needs: which affordance to draw (if any), and the two actions.
 *
 * `canPrompt` is true only once Chromium has actually handed us the event —
 * the menu entry on Android hides until then rather than showing a button
 * that does nothing. On iOS `canPrompt` is always false and the entry opens
 * the sheet instead.
 */
export function useInstallPrompt() {
  const snap = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );

  useEffect(() => {
    listenForInstallPrompt();
  }, []);

  const promptInstall = useCallback(async () => {
    const ev = snapshot.deferred;
    if (!ev) return "unavailable" as const;
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    // The event is single-use either way. A decline counts as a dismissal so
    // the banner does not come straight back on the next page.
    emit({ deferred: null });
    if (outcome === "dismissed") dismissInstallOffer();
    return outcome;
  }, []);

  return {
    platform: snap.platform,
    canPrompt: snap.platform === "prompt" && snap.deferred !== null,
    offered: snap.offered,
    promptInstall,
    dismiss: dismissInstallOffer,
  };
}
