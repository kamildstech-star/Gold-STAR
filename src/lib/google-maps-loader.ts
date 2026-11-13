/// <reference types="google.maps" />
import { useEffect, useState } from "react";

/**
 * The one place the browser Google Maps key is read.
 *
 * Every live map surface (routes, fleet, chase cockpit, dashboard) goes
 * through here, so a missing or rejected key fails the same way everywhere
 * and names the same variable. The key is a Lovable Cloud connector secret:
 * `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY`, referrer-restricted to
 * the app's domains. It is only ever used for the Maps JavaScript SDK, the
 * one Google product that has to run in the browser. Static images (the
 * offline map, Street View, the route map) are fetched server-side on the
 * server key -- see `route-map.functions.ts` -- and the geocoding key is
 * likewise a server secret. Neither reaches the browser.
 */
export const GOOGLE_MAPS_BROWSER_KEY_ENV = "VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY";
export const GOOGLE_MAPS_CHANNEL_ENV = "VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID";

/** Key fetched from the server at runtime (project secret), once resolved. */
let runtimeKey: string | null = null;
let runtimeKeyPromise: Promise<string | null> | null = null;

/** The build-time (Lovable-managed) key. Only valid on *.lovable.app. */
function inlinedBrowserKey(): string | null {
  // Literal property access so Vite can inline it in production builds.
  const key = import.meta.env["VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY"] as
    string | undefined;
  return key?.trim() ? key.trim() : null;
}

/** The browser key, or null when none is available yet. */
export function googleMapsBrowserKey(): string | null {
  // The project's own key (server secret) wins: the Lovable-managed key is
  // referrer-restricted to *.lovable.app and is rejected on custom domains.
  return runtimeKey ?? inlinedBrowserKey();
}

/** Resolve the key: project secret first, managed build-time key as fallback. */
export async function resolveGoogleMapsBrowserKey(): Promise<string | null> {
  if (runtimeKey) return runtimeKey;
  if (typeof window === "undefined") return inlinedBrowserKey();
  if (!runtimeKeyPromise) {
    runtimeKeyPromise = import("./maps-key.functions")
      .then((m) => m.getGoogleMapsBrowserKey())
      .then((r) => {
        runtimeKey = r.key;
        return r.key ?? inlinedBrowserKey();
      })
      .catch(() => {
        runtimeKeyPromise = null;
        return inlinedBrowserKey();
      });
  }
  return runtimeKeyPromise;
}

function googleMapsChannel(): string | null {
  const channel = import.meta.env["VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID"] as
    string | undefined;
  return channel?.trim() ? channel.trim() : null;
}

export type MapsFailure =
  /** No key in the build: nothing was ever requested from Google. */
  | "no-key"
  /** The script tag failed (offline, blocked by an extension or CSP). */
  | "script"
  /** Google accepted the request then rejected the key (referrer, disabled API, invalid key). */
  | "auth";

export class MapsLoadError extends Error {
  readonly reason: MapsFailure;
  constructor(reason: MapsFailure, message: string) {
    super(message);
    this.name = "MapsLoadError";
    this.reason = reason;
  }
}

/**
 * The last few characters of the key this build shipped with, so it can be
 * told apart from the key somebody is editing in the Cloud console. Not the
 * whole key only because the whole key is noise here, not because it is a
 * secret -- it travels in the script URL on every page load.
 */
export function keyHint(): string {
  const key = googleMapsBrowserKey();
  return key ? `This build is using the key ending ${key.slice(-6)}.` : "This build has no key.";
}

/** Human copy for each failure, including what to do about it. */
export function describeMapsFailure(reason: MapsFailure): { title: string; detail: string } {
  const host = typeof window !== "undefined" ? window.location.hostname : "this domain";
  switch (reason) {
    case "no-key":
      return {
        title: "Google Maps key is not configured.",
        // Off Lovable (Fire Feed handoff, known issue 6): the project's own
        // key, read at runtime, is the one that works on a custom domain.
        detail:
          "Set GOOGLE_MAPS_BROWSER_KEY in the server's environment (a deployment secret) with " +
          `${host} in its allowed websites, then restart and reload. The Lovable ` +
          `build key (${GOOGLE_MAPS_BROWSER_KEY_ENV}) only works on *.lovable.app.`,
      };
    case "auth":
      /*
       * Mark: "why isnt this working??" -- after a day of WhatsApp with the
       * Cloud admin, who had already added the referrer and already enabled
       * Maps JavaScript API, because those are the only two things this
       * message used to name.
       *
       * `gm_authFailure` fires for at least four different reasons and Google
       * does not tell the page which. Naming two of them sends people to check
       * the two that are usually already right. Billing lapsing on the project
       * is the commonest cause of all, and a stale build is the nastiest --
       * VITE_ values are baked in at build time, so a deploy made before the
       * secret was set carries a different key than the one being edited in
       * the console, and no amount of fixing that key touches this page.
       *
       * The key tail is what breaks that deadlock: it says which key this
       * build actually shipped with, so it can be compared against the key
       * being edited. Printing it is safe -- the full browser key is in the
       * script URL in the network tab, public by design, which is why it is
       * referrer-restricted rather than secret.
       */
      return {
        title: `Google rejected the Maps key for ${host}.`,
        detail:
          `${keyHint()} Google's own error code is in the browser console and says which of ` +
          `these it is: the key must allow the referrer ${host}; Maps JavaScript API and ` +
          "Directions must both be enabled on it; billing must be active on that Cloud " +
          "project; and the key above must be the key you are editing — a build made before " +
          "the secret changed still carries the old one until it is rebuilt.",
      };
    case "script":
    default:
      return {
        title: "Google Maps could not be downloaded.",
        detail: "Check the connection (or an ad blocker / content filter) and try again.",
      };
  }
}

/* ------------------------------------------------------------ auth failures
 * Google reports a rejected key asynchronously through window.gm_authFailure
 * and paints its own grey overlay inside every map container. We capture it
 * once, remember it, and let each surface render an explanatory panel. */
let authFailed = false;
const authListeners = new Set<() => void>();

export function mapsAuthFailed(): boolean {
  return authFailed;
}

export function useMapsAuthFailed(): boolean {
  const [failed, setFailed] = useState(authFailed);
  useEffect(() => {
    if (authFailed) setFailed(true);
    const fn = () => setFailed(true);
    authListeners.add(fn);
    return () => {
      authListeners.delete(fn);
    };
  }, []);
  return failed;
}

let loaderPromise: Promise<void> | null = null;
let loadAttempt = 0;
const MAPS_LOAD_TIMEOUT_MS = 15_000;

/**
 * Load the Maps JavaScript SDK once. Resolves when `google.maps` is usable.
 * Rejects with a `MapsLoadError` naming the reason; a failed load is not
 * remembered, so the next call (a Retry button) tries again.
 */
export function loadGoogleMaps(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new MapsLoadError("script", "Maps cannot load during SSR"));
  }
  if (authFailed) {
    return Promise.reject(new MapsLoadError("auth", "Google rejected the Maps key"));
  }
  const w = window as unknown as { google?: { maps?: { Map?: unknown } } };
  if (w.google?.maps?.Map) return Promise.resolve();
  if (loaderPromise) return loaderPromise;

  // On Lovable-hosted domains the build-time managed key is valid, so inject
  // synchronously. On a custom domain that key is referrer-rejected by Google,
  // so resolve the project's own key from the server first.
  const host = String(
    (window as unknown as { location?: { hostname?: string } }).location?.hostname ?? "",
  );
  const onLovableHost = host.endsWith(".lovable.app") || host.endsWith(".lovableproject.com");
  const inlinedKey = onLovableHost ? inlinedBrowserKey() : null;
  if (inlinedKey) {
    loaderPromise = injectScript(inlinedKey);
    return loaderPromise;
  }

  loaderPromise = resolveGoogleMapsBrowserKey().then((key) => {
    if (!key) {
      loaderPromise = null;
      throw new MapsLoadError("no-key", `${GOOGLE_MAPS_BROWSER_KEY_ENV} is not set`);
    }
    return injectScript(key);
  });
  return loaderPromise;
}

function injectScript(key: string): Promise<void> {
  const channel = googleMapsChannel();
  return new Promise<void>((resolve, reject) => {
    const cbName = `__reviveInitMap${++loadAttempt}`;
    let settled = false;
    const s = document.createElement("script");
    const win = window as unknown as Record<string, unknown>;
    const finish = (err: MapsLoadError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete win[cbName];
      if (err) {
        s.remove();
        loaderPromise = null;
        reject(err);
      } else {
        resolve();
      }
    };
    win[cbName] = () => finish(null);
    win["gm_authFailure"] = () => {
      authFailed = true;
      authListeners.forEach((fn) => fn());
      finish(new MapsLoadError("auth", "Google rejected the Maps key"));
    };
    const timer = setTimeout(
      () => finish(new MapsLoadError("script", "Google Maps timed out")),
      MAPS_LOAD_TIMEOUT_MS,
    );
    const params = new URLSearchParams({ key, loading: "async", callback: cbName });
    if (channel) params.set("channel", channel);
    s.src = `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
    s.async = true;
    s.onerror = () => {
      s.remove();
      finish(new MapsLoadError("script", "Google Maps script failed to load"));
    };
    document.head.appendChild(s);
  });
}

/** Normalise anything thrown by the loader into a failure reason. */
export function mapsFailureOf(err: unknown): MapsFailure {
  if (err instanceof MapsLoadError) return err.reason;
  if (authFailed) return "auth";
  return "script";
}
