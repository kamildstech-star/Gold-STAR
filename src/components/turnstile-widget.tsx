/**
 * Cloudflare Turnstile, as a script tag.
 *
 * Deliberately not a dependency. `@marsidev/react-turnstile` — the package the
 * Supabase guide reaches for — is a thin wrapper around the same global that
 * this file calls directly, and the verification half is not ours to write:
 * Supabase Auth checks the token against Cloudflare server-side when CAPTCHA
 * protection is switched on for the project, using the secret key stored in the
 * Supabase dashboard. The app never sees that secret and never calls siteverify.
 *
 * Configuration, all of it the client's to do:
 *   1. Cloudflare dashboard -> Turnstile -> create a widget for the app's
 *      hostname. Copy the site key and the secret key.
 *   2. Supabase dashboard -> Authentication -> Attack Protection -> enable
 *      CAPTCHA protection, provider "Turnstile", paste the SECRET key.
 *   3. Set VITE_TURNSTILE_SITE_KEY (the public half) in the app's environment.
 *
 * Until step 3 is done this renders nothing and sign-in behaves exactly as it
 * does today — the widget must never be the reason nobody can log in. Note the
 * halves are independent: if Supabase has the secret but the app has no site
 * key, Supabase will reject every sign-in for a missing token, so steps 2 and 3
 * belong in the same maintenance window.
 */
import { useEffect, useId, useRef } from "react";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "auto" | "light" | "dark";
      action?: string;
      size?: TurnstileSize;
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * How wide the widget is drawn, from the width it has to sit in.
 *
 * The default ("normal") is a fixed 300px iframe. Inside the sign-in card on a
 * 320px phone the card's content box is well under that, so the challenge
 * stuck out of the card and the page scrolled sideways (phone-width audit,
 * PR #278). "flexible" fills its container but Cloudflare floors it at 300px,
 * so on its own it overflows exactly the same screens. Below 300px the only
 * size that fits is "compact" (150 x 140); from 300px up "flexible" lines the
 * challenge up with the full-width fields and button around it. The frame
 * comes from challenges.cloudflare.com either way, which the CSP's frame-src
 * already allows (PR #259) — size is a render option, not a new origin.
 */
export type TurnstileSize = "normal" | "flexible" | "compact";
export const TURNSTILE_MIN_FLEXIBLE_WIDTH = 300;
export function turnstileSize(containerWidth: number): TurnstileSize {
  return containerWidth >= TURNSTILE_MIN_FLEXIBLE_WIDTH ? "flexible" : "compact";
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export const turnstileSiteKey = (): string =>
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? "";

export const turnstileEnabled = (): boolean => turnstileSiteKey().length > 0;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Turnstile failed to load")));
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("Turnstile failed to load")));
    document.head.appendChild(script);
  });
}

export type TurnstileHandle = { reset: () => void };

/**
 * A Turnstile token is single-use. `onToken` fires with the token when the
 * challenge passes and with null when it expires or errors, so the form can
 * stop offering a submit that Supabase is certain to reject.
 */
export function TurnstileWidget({
  onToken,
  handleRef,
}: {
  onToken: (token: string | null) => void;
  handleRef?: React.MutableRefObject<TurnstileHandle | null>;
}) {
  const containerId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  // Kept in a ref so re-renders never tear down and re-render the widget —
  // Turnstile issues a fresh challenge each time it mounts.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    const siteKey = turnstileSiteKey();
    if (!siteKey) return;

    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        const size = turnstileSize(containerRef.current.clientWidth);
        // Read by the container's class: a flexible widget only fills a wrapper
        // that is itself full width, and flex centring would shrink it to 300.
        containerRef.current.dataset.size = size;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: "auto",
          size,
          action: "signin",
          callback: (token) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
        if (handleRef) {
          handleRef.current = {
            reset: () => {
              onTokenRef.current(null);
              if (widgetIdRef.current) window.turnstile?.reset(widgetIdRef.current);
            },
          };
        }
      })
      .catch((error) => {
        console.error("[turnstile]", error);
        onTokenRef.current(null);
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current) window.turnstile?.remove(widgetIdRef.current);
      widgetIdRef.current = null;
      if (handleRef) handleRef.current = null;
    };
  }, [handleRef]);

  if (!turnstileEnabled()) return null;
  // w-full so clientWidth above is the room the form actually has.
  return (
    <div
      ref={containerRef}
      id={containerId}
      className="flex w-full justify-center data-[size=flexible]:[&>div]:w-full"
    />
  );
}
