/**
 * The install affordances: a user-menu entry, a one-time dashboard banner on
 * phones, and the iPhone walkthrough sheet.
 *
 * Mark: "make this a web app with install feature for both apple and android"
 *
 * On Android and desktop Chrome/Edge the entry calls the browser's own prompt.
 * On iPhone/iPad there is no prompt to call — Apple has never exposed one — so
 * the entry opens a sheet with the three taps Safari actually needs. Anything
 * else (Firefox, desktop Safari, a browser already running as the installed
 * app) draws nothing at all: an Install button that cannot install is worse
 * than none.
 *
 * All three share one rule from `pwa-install.ts`: once dismissed, nothing
 * shows again for fourteen days; once installed, never.
 */
import { T } from "@/components/bilingual";
import { useSyncExternalStore } from "react";
import { useRouterState } from "@tanstack/react-router";
import { MonitorDown, Share, Smartphone, SquarePlus, X } from "lucide-react";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { currentInstallGuide, useInstallPrompt } from "@/lib/pwa-install";

/* ------------------------------------------------------------------------ */
/* iPhone sheet                                                              */
/* ------------------------------------------------------------------------ */

/*
 * The sheet is opened from a dropdown item, and Radix unmounts the menu's
 * content the moment an item is selected — a sheet rendered inside the menu
 * would vanish with it. So the open flag lives here, outside React, and one
 * `<IosInstallSheetHost />` in the app shell draws the sheet wherever it was
 * asked for.
 */
const sheetListeners = new Set<() => void>();
/** Which set of steps the sheet is showing. */
type SheetKind = "ios" | "manual";
let sheetKind: SheetKind = "ios";
let sheetOpen = false;
function setIosSheet(open: boolean, kind: SheetKind = sheetKind) {
  sheetKind = kind;
  sheetOpen = open;
  sheetListeners.forEach((l) => l());
}
export const openIosInstallSheet = () => setIosSheet(true, "ios");
/**
 * The steps for a browser that CAN install but has not offered to.
 *
 * Chrome only fires `beforeinstallprompt` once its own engagement heuristics
 * are satisfied, so an Android field tech opening the app for the first time
 * had no install path at all — iOS had manual steps and Android had nothing.
 * Melly, 17 Sep: "you get a downloadable app and you download it and it shows
 * up as an icon". That has to be true on the first visit, not the third.
 */
export const openManualInstallSheet = () => setIosSheet(true, "manual");
function subscribeSheet(l: () => void) {
  sheetListeners.add(l);
  return () => {
    sheetListeners.delete(l);
  };
}

/** Mount once, in the shell. */
export function IosInstallSheetHost() {
  const open = useSyncExternalStore(
    subscribeSheet,
    () => sheetOpen,
    () => false,
  );
  const kind = useSyncExternalStore(
    subscribeSheet,
    () => sheetKind,
    () => "ios" as SheetKind,
  );
  return kind === "manual" ? (
    <ManualInstallSheet open={open} onOpenChange={setIosSheet} />
  ) : (
    <IosInstallSheet open={open} onOpenChange={setIosSheet} />
  );
}

function ShareGlyph() {
  // Apple's share icon is a box with an arrow out the top; lucide's `Share`
  // is the same shape, so the person can match it against their toolbar.
  return (
    <span className="inline-flex size-6 items-center justify-center rounded-[6px] border border-border bg-muted align-middle">
      <Share className="size-3.5 text-[var(--link)]" aria-hidden />
    </span>
  );
}

function AddGlyph() {
  return (
    <span className="inline-flex size-6 items-center justify-center rounded-[6px] border border-border bg-muted align-middle">
      <SquarePlus className="size-3.5" aria-hidden />
    </span>
  );
}

export function IosInstallSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const safari = currentInstallGuide() !== "ios-open-in-safari";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-xl">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            <Smartphone className="size-4" aria-hidden />
            <T>Install on iPhone</T>
          </SheetTitle>
          <SheetDescription>
            <T>
              Put Recovery Hub on your home screen so it opens full-screen like an app, without the
              Safari bars.
            </T>
          </SheetDescription>
        </SheetHeader>
        {!safari ? (
          // Chrome and Firefox on iOS can add to the home screen too since
          // iOS 16.4, but the menu is in a different place in each, and the
          // in-app browsers (a link tapped inside Facebook, the Google app)
          // cannot at all. One set of steps, in the browser they describe.
          <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            Open this page in <span className="font-semibold">Safari</span> first, then follow the
            steps below.
          </p>
        ) : null}
        <ol className="mt-4 space-y-3 text-sm">
          <li className="flex items-start gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              1
            </span>
            {/*
             * iOS 26 moved Share off Safari's toolbar into the ••• menu. Both
             * layouts are in crews' pockets, so the step names both rather
             * than sending half of them looking for a button that is not
             * there.
             */}
            <span>
              Tap the <ShareGlyph /> <span className="font-semibold">Share</span> button. On newer
              iPhones, tap <span className="font-semibold">•••</span> first to find it.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              2
            </span>
            <span>
              Scroll the list and tap <AddGlyph />{" "}
              <span className="font-semibold">Add to Home Screen</span>.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              3
            </span>
            <span>
              Tap <span className="font-semibold">Add</span> in the top-right corner. Recovery Hub
              appears on your home screen.
            </span>
          </li>
        </ol>
        {/*
         * Honest about the limits. iOS evicts a home-screen app's storage
         * after a week or so of not being opened, and there is no background
         * sync, so anything held in the offline queue only sends while the
         * app is open. Field crews should open it once they have signal.
         */}
        {/*
         * Gmail and some other apps open links in a Safari panel that reports
         * itself as Safari but has no Add to Home Screen — the user agent
         * cannot tell them apart, so the way out is said in words. The panel
         * has a compass button that hands the page to real Safari.
         */}
        <p className="mt-4 text-xs text-muted-foreground">
          No &ldquo;Add to Home Screen&rdquo;? The link opened inside another app. Tap the compass
          or &ldquo;Open in Safari&rdquo; button, then start again.
        </p>
        {/*
         * iOS gives a home-screen app its own storage, separate from Safari's,
         * so the session does not come with it. On Android it does — the
         * installed app shares Chrome's — which is why this line is here and
         * not on the Android steps.
         */}
        <p className="mt-2 text-xs text-muted-foreground">
          The home-screen app keeps its own sign-in, separate from Safari&rsquo;s — sign in there
          once.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Work saved while offline sends the next time you open the app with signal — iPhone does
          not send it in the background.
        </p>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Steps for a browser that can install but has not offered to.
 *
 * Chrome's own menu does the install; it is two taps and it is always there,
 * unlike `beforeinstallprompt`, which fires on Chrome's schedule rather than
 * the user's. Deliberately vague about the menu's exact wording — Chrome,
 * Edge and Samsung Internet each label it differently and all three are in
 * the field.
 *
 * No "you will have to sign in again" line here. That is iOS behaviour; on
 * Android the installed app shares Chrome's storage and opens signed in, and
 * the warning this sheet used to carry only set people up to expect a
 * password prompt that never came.
 */
function ManualInstallSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inAppBrowser = currentInstallGuide() === "android-open-in-chrome";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-xl">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">
            <MonitorDown className="size-4" aria-hidden />
            <T>Install Recovery Hub</T>
          </SheetTitle>
          <SheetDescription>
            <T>
              Put Recovery Hub on your home screen so it opens full-screen like an app, without the
              browser bars.
            </T>
          </SheetDescription>
        </SheetHeader>
        {inAppBrowser ? (
          // A link tapped inside Facebook, Instagram or a chat app opens in
          // that app's WebView, whose menu has no install entry at all.
          <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            This page is open inside another app. Use its menu to{" "}
            <span className="font-semibold">Open in Chrome</span> first, then follow the steps
            below.
          </p>
        ) : null}
        <ol className="mt-4 space-y-3 text-sm">
          <li className="flex items-start gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              1
            </span>
            <span>
              Open your browser&rsquo;s menu — the <span className="font-semibold">three dots</span>{" "}
              in the corner.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              2
            </span>
            <span>
              Tap <span className="font-semibold">Install app</span> or{" "}
              <span className="font-semibold">Add to Home screen</span> — the wording depends on
              your browser.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              3
            </span>
            <span>
              Confirm. Recovery Hub appears with the other apps and opens without the browser bars.
            </span>
          </li>
        </ol>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------------ */
/* User-menu entry                                                           */
/* ------------------------------------------------------------------------ */

/**
 * "Install app" / "Install on iPhone" in the user menu.
 *
 * Always present on a platform that CAN install. It used to render nothing on
 * Android until Chrome had fired `beforeinstallprompt`, which it does on its
 * own engagement schedule — so a field tech opening the app for the first time
 * was told nothing, on the one platform that has a real install. When there is
 * no prompt to fire, the manual steps open instead.
 *
 * Still nothing on a browser that genuinely cannot install — a desktop Firefox
 * has no such feature, and an entry that opens instructions for a button that
 * does not exist is worse than no entry.
 */
export function InstallMenuItem() {
  const { platform, canPrompt, promptInstall } = useInstallPrompt();

  if (platform === "ios") {
    return (
      <DropdownMenuItem onSelect={openIosInstallSheet}>
        <Smartphone className="mr-2 size-4" />
        <T>Install on iPhone</T>
      </DropdownMenuItem>
    );
  }
  if (platform !== "prompt") return null;
  return (
    <DropdownMenuItem
      onSelect={() => (canPrompt ? void promptInstall() : openManualInstallSheet())}
    >
      <MonitorDown className="mr-2 size-4" />
      Install app
    </DropdownMenuItem>
  );
}

/* ------------------------------------------------------------------------ */
/* Dashboard banner (phones only)                                            */
/* ------------------------------------------------------------------------ */

/**
 * Where the banner may appear: each role's home screen, nowhere else.
 * "/" is the dashboard (crew land on their Today view there); "/chase" is the
 * field chaser's home and their bottom bar has no link to "/", so with only
 * "/" a chaser saw the offer once, on first sign-in, and never again.
 */
export const INSTALL_BANNER_PATHS: readonly string[] = ["/", "/chase"];

/**
 * One-line offer above a home screen on a phone. Only there: a field tech
 * opening a job from a text message should see the job, not a pitch.
 * `md:hidden` keeps it off laptops, where the menu entry is enough.
 */
export function InstallBanner() {
  const onDashboard = useRouterState({
    select: (r) => INSTALL_BANNER_PATHS.includes(r.location.pathname.replace(/(.)\/$/, "$1")),
  });
  const { platform, canPrompt, offered, promptInstall, dismiss } = useInstallPrompt();

  if (!onDashboard || !offered) return null;
  const ios = platform === "ios";
  if (!ios && platform !== "prompt") return null;

  return (
    <div
      role="region"
      aria-label="Install Recovery Hub"
      className="flex items-center gap-2 border-b border-l-[3px] border-l-[var(--brand-gold)] bg-[color-mix(in_oklab,var(--brand-gold)_10%,var(--card))] px-3 py-2 text-sm md:hidden"
    >
      <Smartphone className="size-4 shrink-0 text-[var(--brand-gold-text)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        <T>{ios ? "Add Recovery Hub to your home screen" : "Install Recovery Hub on this phone"}</T>
      </span>
      {/*
       * Phone-only, so sized for a thumb: the 28px button and cross this
       * banner had were a reach in gloves on a job site. 40px keeps the
       * banner one line.
       */}
      <Button
        size="sm"
        variant="outline"
        className="h-10 px-3 text-sm"
        onClick={() =>
          ios ? openIosInstallSheet() : canPrompt ? void promptInstall() : openManualInstallSheet()
        }
      >
        <T>{ios ? "Show me" : "Install"}</T>
      </Button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Not now"
        className="grid size-10 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Sign-in page                                                              */
/* ------------------------------------------------------------------------ */

/**
 * "Install the app on this phone" under the sign-in card.
 *
 * Mark: "iphone and android, should be a way to install it". A crew member's
 * first contact with the app is a link and this page — before there is a user
 * menu or a dashboard banner to find. On an iPhone it is also the RIGHT moment:
 * the home-screen app keeps its own storage, so someone who signs in in
 * Safari and installs afterwards signs in twice, and someone who installs
 * from here signs in once, in the app.
 *
 * A quiet link, not a banner, and no dismissal: this page is seen once per
 * device, and someone who came only to sign in can ignore one line. Phones
 * only, same as the banner; nothing on a browser that cannot install, and
 * nothing once running as the installed app.
 */
export function InstallHint() {
  const { platform, canPrompt, promptInstall } = useInstallPrompt();
  if (platform !== "ios" && platform !== "prompt") return null;
  const ios = platform === "ios";
  return (
    <div className="mt-4 flex justify-center md:hidden">
      <button
        type="button"
        onClick={() =>
          ios ? openIosInstallSheet() : canPrompt ? void promptInstall() : openManualInstallSheet()
        }
        className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-foreground underline-offset-4 hover:underline"
      >
        <Smartphone className="size-4 text-[var(--brand-gold-text)]" aria-hidden />
        {ios ? "Add Recovery Hub to your home screen" : "Install the app on this phone"}
      </button>
    </div>
  );
}
