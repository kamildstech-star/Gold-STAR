/**
 * Which credential a server-side map call uses — one rule for every caller
 * (address search, geocoding, the exposure sheet's neighbours).
 *
 * On Lovable, Google and Mapbox could be reached two ways: with our own key
 * straight to the vendor, or through Lovable's connector gateway
 * (connector-gateway.lovable.dev), which holds the vendor key and is opened
 * with LOVABLE_API_KEY plus a per-connection key (GOOGLE_MAPS_API_KEY,
 * MAPBOX_API_KEY). Off Lovable there is no gateway, so:
 *
 *   1. our own key first — GOOGLE_MAPS_SERVER_KEY (or GOOGLE_PLACES_API_KEY),
 *      MAPBOX_ACCESS_TOKEN — straight to Google / Mapbox;
 *   2. the connector gateway ONLY when LOVABLE_API_KEY is present to open it.
 *      Without it the gateway would only ever answer 401, so the caller
 *      moves on to the next provider (and finally the free OSM lookups)
 *      instead of spending a request on a sure failure.
 *
 * On Lovable both gateway keys are injected, so every call resolves exactly as
 * it did before this file. The browser key is a separate matter, resolved in
 * google-maps-loader.ts (runtime GOOGLE_MAPS_BROWSER_KEY first; the build's
 * VITE_LOVABLE_CONNECTOR_* key only on Lovable hosts or when no runtime key).
 */

export const CONNECTOR_GATEWAY = "https://connector-gateway.lovable.dev";

type Env = Record<string, string | undefined>;

function processEnv(): Env {
  return typeof process === "undefined" ? {} : (process.env as Env);
}

export type MapsAuth = {
  /** Our own vendor key, or the gateway's per-connection key. */
  key: string;
  viaGateway: boolean;
};

const present = (v: string | undefined) => (v?.trim() ? v.trim() : null);

/** Google for geocoding and Places: own server key, else the gateway if it can be opened. */
export function googleServerAuth(env: Env = processEnv()): MapsAuth | null {
  const direct = present(env["GOOGLE_MAPS_SERVER_KEY"]) ?? present(env["GOOGLE_PLACES_API_KEY"]);
  if (direct) return { key: direct, viaGateway: false };
  const conn = present(env["GOOGLE_MAPS_API_KEY"]);
  if (conn && present(env["LOVABLE_API_KEY"])) return { key: conn, viaGateway: true };
  return null;
}

/** Mapbox geocoding: own access token, else the gateway if it can be opened. */
export function mapboxAuth(env: Env = processEnv()): MapsAuth | null {
  const token = present(env["MAPBOX_ACCESS_TOKEN"]);
  if (token) return { key: token, viaGateway: false };
  const conn = present(env["MAPBOX_API_KEY"]);
  if (conn && present(env["LOVABLE_API_KEY"])) return { key: conn, viaGateway: true };
  return null;
}

/** The two headers that open the connector gateway for one connection. */
export function gatewayHeaders(
  connectionKey: string,
  env: Env = processEnv(),
): Record<string, string> {
  return {
    Authorization: `Bearer ${env["LOVABLE_API_KEY"] ?? ""}`,
    "X-Connection-Api-Key": connectionKey,
  };
}
