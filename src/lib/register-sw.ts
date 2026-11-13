/**
 * Single guarded registrar for the app-shell service worker.
 *
 * Never registers in dev, in an iframe, or in a Lovable preview host — a
 * worker there caches editor traffic and confuses hot reloads. `?sw=off` is
 * the kill switch: it unregisters and leaves the page uncached.
 */
import { toast } from "sonner";

const SW_URL = "/sw.js";

/** An installed app can sit open for days; Chrome only re-checks the worker on navigation. */
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Remove private responses retained by older workers, keeping static assets. */
export async function retirePrivatePageCaches(storage: CacheStorage): Promise<void> {
  await storage.delete("html-nav");
  if (!(await storage.has("static-assets"))) return;
  const cache = await storage.open("static-assets");
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => new URL(request.url).pathname.startsWith("/api/"))
      .map((request) => cache.delete(request)),
  );
}

function refused(): boolean {
  if (!import.meta.env.PROD) return true;
  if (typeof window === "undefined") return true;
  if (window.self !== window.top) return true;
  const h = window.location.hostname;
  if (h.startsWith("id-preview--") || h.startsWith("preview--")) return true;
  if (h === "lovableproject.com" || h.endsWith(".lovableproject.com")) return true;
  if (h === "lovableproject-dev.com" || h.endsWith(".lovableproject-dev.com")) return true;
  if (h === "beta.lovable.dev" || h.endsWith(".beta.lovable.dev")) return true;
  if (new URLSearchParams(window.location.search).get("sw") === "off") return true;
  return false;
}

async function unregisterApp(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.allSettled(
    regs
      .filter((r) => (r.active?.scriptURL ?? r.installing?.scriptURL ?? "").includes(SW_URL))
      .map((r) => r.unregister()),
  );
}

export function registerAppServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  // Retire the old navigation cache even when registration is disabled.
  // Keep static assets and unsent field-work queues intact.
  if ("caches" in window) void retirePrivatePageCaches(caches).catch(() => {});
  if (refused()) {
    void unregisterApp();
    return;
  }
  window.addEventListener("load", () => {
    void registerIfServed();
  });
}

/**
 * Register only once `/sw.js` is known to be there, and to be a script.
 *
 * `register()` rejects when the script 404s, and the `.catch()` that used to
 * wrap it looked like it handled that. It does not: the browser writes "A bad
 * HTTP response code (404) was received when fetching the script" to the
 * console itself, before the promise ever settles, and no JavaScript can take
 * it back. That line is what QA found on 2026-09-16 — reported against Admin ›
 * Test users, which is simply the page that happened to be open when the
 * browser next re-checked the worker.
 *
 * A deployment that does not serve the file is the case worth surviving: the
 * app works perfectly without a service worker, so a missing one should cost a
 * silent skip, not a red line on every page. The same probe catches the other
 * way this fails — a host answering unknown paths with the SPA's index.html,
 * which registers as an "unsupported MIME type" error instead.
 */
async function registerIfServed(): Promise<void> {
  try {
    const res = await fetch(SW_URL, { method: "GET", cache: "no-store" });
    void res.body?.cancel().catch(() => {});
    if (!res.ok) return;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    // An empty content-type is not evidence of a problem; anything that names
    // itself as markup is.
    if (type.includes("html") || type.includes("xml")) return;
  } catch {
    // Offline, or the probe was blocked. Registering now would be a guess.
    return;
  }
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" }).catch(() => null);
  if (reg) watchForUpdates(reg);
}

/**
 * New version → "Update available — Reload", never a silent switch.
 *
 * The worker is built with `registerType: "prompt"` (vite.config.ts), so a
 * freshly installed worker waits instead of taking over the running page.
 * Taking over mid-session is the failure this replaces: the old page keeps
 * running old chunks while the new worker has already dropped them from its
 * precache, so the next lazy route 404s in the middle of a form. Leaving the
 * worker waiting forever is the other failure — a phone that never fully
 * closes the app never gets the fix it was promised. So: tell them, and let
 * them pick the moment. Reload is a hard refresh from their point of view, so
 * the toast stays until it is dismissed rather than timing out over a form.
 *
 * The offline queue is IndexedDB and survives the reload; nothing held for a
 * basement is lost by tapping Reload.
 */
function watchForUpdates(reg: ServiceWorkerRegistration): void {
  // The toast's Reload looks at the registration when it is tapped, not at the
  // worker that happened to be waiting when the toast went up — see applyUpdate.
  const ready = () => showUpdateToast(() => applyUpdate(reg, BROWSER));

  // A worker can already be waiting from a previous visit that never reloaded.
  if (reg.waiting && navigator.serviceWorker.controller) ready();

  reg.addEventListener("updatefound", () => {
    const installing = reg.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      // "installed" with no controller is the very first install, not an
      // update; there is nothing to reload into.
      if (installing.state === "installed" && navigator.serviceWorker.controller) ready();
    });
  });

  const check = () => void reg.update().catch(() => {});
  window.setInterval(check, UPDATE_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
}

/** What tapping Reload touches, injected so the decision can be unit tested. */
export interface UpdateEnv {
  reload: () => void;
  onControllerChange: (listener: () => void) => void;
  later: (fn: () => void, ms: number) => void;
}

/**
 * How long the tab that asked for the update waits for the new worker to take
 * over before reloading anyway. The tap was the request; this only stops a
 * worker that never answers SKIP_WAITING from making the button do nothing.
 */
export const TAKEOVER_TIMEOUT_MS = 5000;

const BROWSER: UpdateEnv = {
  reload: () => window.location.reload(),
  onControllerChange: (listener) =>
    navigator.serviceWorker.addEventListener("controllerchange", listener),
  later: (fn, ms) => void window.setTimeout(fn, ms),
};

/**
 * Reload was tapped. Two different situations look the same from the toast.
 *
 * 1. The new worker is still waiting. Ask it to take over and reload once it
 *    has (controllerchange), so the page comes back on the new build.
 *
 * 2. Nothing is waiting any more: Reload was already tapped in ANOTHER open
 *    tab, and with `clientsClaim: true` the new worker took this tab over
 *    too. This tab rightly did not reload when that happened — it may hold a
 *    half-filled form, and PR #269 settled that switching tabs must never wipe
 *    one. But its own toast was still up, and Reload used to post
 *    SKIP_WAITING to a worker that was already active: controllerchange never
 *    fired again, so the button did nothing, and the tab kept running the old
 *    build's chunks that the new worker no longer serves (its next lazy route
 *    could 404). Here the only useful thing to do is the reload itself.
 *
 * Either way the reload happens because someone tapped Reload in THIS tab.
 * Nothing here runs on its own: the controllerchange listener is added only
 * by a tap, so other tabs being taken over never reloads them.
 */
export function applyUpdate(
  reg: { waiting: Pick<ServiceWorker, "postMessage"> | null },
  env: UpdateEnv,
): "activating" | "reloading" {
  const waiting = reg.waiting;
  if (!waiting) {
    env.reload();
    return "reloading";
  }
  let reloading = false;
  const reloadOnce = () => {
    if (reloading) return;
    reloading = true;
    env.reload();
  };
  env.onControllerChange(reloadOnce);
  env.later(reloadOnce, TAKEOVER_TIMEOUT_MS);
  // The generated worker listens for exactly this message and calls
  // skipWaiting(); clientsClaim then fires controllerchange above.
  waiting.postMessage({ type: "SKIP_WAITING" });
  return "activating";
}

const UPDATE_TOAST_ID = "sw-update";

function showUpdateToast(apply: () => void): void {
  toast("Update available", {
    id: UPDATE_TOAST_ID,
    description: "A newer version of Recovery Hub is ready.",
    duration: Infinity,
    action: { label: "Reload", onClick: apply },
  });
}
