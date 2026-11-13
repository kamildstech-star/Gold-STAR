/**
 * The app's public address — ONE setting, read the same way everywhere a URL
 * is built for someone outside the current page: emails and automation links,
 * the Outlook webhook, the Microsoft redirect allowlist, intake / signing /
 * portal / share / review links, and the endpoints the Integrations screen
 * tells an admin to paste into a vendor's dashboard.
 *
 * Why one setting: the app is moving off Lovable's hosting. Until now the
 * address was either `window.location.origin` (whatever host the person
 * happened to be on) or a hard-coded `flood-hero-hub.lovable.app`, depending
 * on which file you read. With this module, moving host is setting
 * PUBLIC_SITE_URL (server, at runtime) and VITE_PUBLIC_SITE_URL (browser, at
 * build) — nothing else in the code names a host.
 *
 * Defaults are exactly what each caller did before, so a deployment that sets
 * neither variable (Lovable today) behaves as it always has:
 *   - server: VITE_PUBLIC_SITE_URL, then PUBLIC_SITE_URL, then the Lovable
 *     host below (the order the three server copies of this already used);
 *   - browser: VITE_PUBLIC_SITE_URL baked in at build, else the page's own
 *     origin.
 *
 * The database has its own copy of the same setting for the pg_cron hooks —
 * `app_settings` key `app_base_url` (migration 20261012150000) — because a
 * scheduled job has no request to read a host from.
 */

/** Where the app answered before any of this was configurable. */
export const DEFAULT_APP_ORIGIN = "https://flood-hero-hub.lovable.app";

type Env = Record<string, string | undefined>;

/**
 * `https://host[:port]` from whatever was typed into a secret — a trailing
 * slash, a path, stray spaces. Anything that is not an http(s) URL is treated
 * as not set, so a typo falls back to the default instead of building
 * `undefined/intake/…` links.
 */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The origin a deployment configured, or null when it configured none. */
export function configuredAppOrigin(env: Env): string | null {
  return normalizeOrigin(env["VITE_PUBLIC_SITE_URL"]) ?? normalizeOrigin(env["PUBLIC_SITE_URL"]);
}

function processEnv(): Env {
  // Guarded so a stray import into browser code cannot throw on `process`.
  return typeof process === "undefined" ? {} : (process.env as Env);
}

/**
 * Server side: the address links and webhooks should point at. Read per call,
 * not at module load — on Workers the environment is bound per request.
 */
export function serverAppOrigin(env: Env = processEnv()): string {
  return configuredAppOrigin(env) ?? DEFAULT_APP_ORIGIN;
}

/** Server side: the configured origin only (null when unset), for display. */
export function serverConfiguredAppOrigin(env: Env = processEnv()): string | null {
  return configuredAppOrigin(env);
}

/** The build-time public origin, if the build was given one. */
export function buildAppOrigin(): string | null {
  return normalizeOrigin(import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined);
}

/**
 * Browser side: the address to put in a link someone else will open. The
 * build's VITE_PUBLIC_SITE_URL when set, else the page's own origin (what
 * every one of these links used before), else "" during SSR.
 */
export function browserAppOrigin(): string {
  return buildAppOrigin() ?? (typeof window === "undefined" ? "" : window.location.origin);
}

/** `<origin><path>` with exactly one slash between them. */
export function joinOrigin(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
