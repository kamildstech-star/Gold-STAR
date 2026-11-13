/**
 * Google's static image APIs (Maps Static, Street View Static) — server only.
 *
 * Until this module existed the app built two of these image URLs in the
 * browser with the browser key: the offline map cached at accept time in
 * `chase-prefetch.ts`, and the property photo on the chase jobs panel. The
 * browser key is public by design — it ships in the JS bundle — so the only
 * thing stopping anyone from billing Google against this project from a
 * script is the key's referrer list. Measured against the deployed key, it
 * stopped nothing: a request with no referrer at all came back 200. Moving
 * the fetch here puts every static image behind Supabase auth on a key that
 * never leaves the server, the same rule `route-map.functions.ts` has stated
 * at the top of its file since the route map was built.
 *
 * Every handler that wants one of these reaches this file with
 * `await import("./static-maps.server")` — never a top-level import, or the
 * key read below ships to the client bundle with it. The result travels back
 * as a data URL, so the caller can cache the bytes (IndexedDB) or paint them
 * (`<img src>`) without another round trip to Google.
 */

export type ImageResult = { dataUrl: string | null; error: string | null };

/** Own server key first; the shared connector key is the fallback. */
async function serverKey(): Promise<string | null> {
  const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
  await ensureIntegrationEnv();
  return process.env["GOOGLE_MAPS_SERVER_KEY"] ?? process.env["GOOGLE_MAPS_API_KEY"] ?? null;
}

/**
 * Base64 in 8 KB slices. A 1280x1280 map is several hundred kilobytes, and the
 * one-character-at-a-time string append the route map used to do is quadratic
 * on engines that do not optimise it.
 */
function toBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x2000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x2000));
  }
  return btoa(bin);
}

/**
 * One Google image, as a data URL. The only place in the app a static image
 * URL is built or a static image is fetched.
 *
 * `path` is the API under maps.googleapis.com/maps/api and `query` is the
 * already-encoded query string without the key. Static Maps answers PNG and
 * Street View answers JPEG, so the MIME type comes from the response rather
 * than being assumed.
 */
export async function googleImageAsDataUrl(
  path: "staticmap" | "streetview",
  query: string,
): Promise<ImageResult> {
  const key = await serverKey();
  if (!key) return { dataUrl: null, error: "No map key configured." };
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/${path}?${query}&key=${key}`);
    if (!res.ok) return { dataUrl: null, error: "Map service unavailable." };
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { dataUrl: `data:${mime};base64,${toBase64(bytes)}`, error: null };
  } catch {
    return { dataUrl: null, error: "Map service unavailable." };
  }
}

/** A polyline through the stops with numbered markers — the visit planner's route map. */
export function routeMap(
  points: { lat: number; lon: number }[],
  width: number,
  height: number,
): Promise<ImageResult> {
  const path = points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join("|");
  const markers = points
    .slice(0, 20)
    .map((p, i) => `markers=color:0x1B5FA8%7Clabel:${(i + 1) % 10}%7C${p.lat},${p.lon}`)
    .join("&");
  // Hand-built rather than URLSearchParams: the `|` separators inside path=
  // are what Google documents, and the markers repeat a parameter name.
  return googleImageAsDataUrl(
    "staticmap",
    `size=${width}x${height}&scale=2&path=color:0x1B5FA8CC|weight:4|${encodeURIComponent(path)}&${markers}`,
  );
}

/**
 * The destination pinned on a roadmap — the map a chaser has on the doorstep
 * when the live basemap cannot load. 640x640 at scale 2 is the largest Static
 * Maps will serve, and zoom 17 shows the block, not just the roof. Same
 * parameters the browser used to send, so the cached map looks the same.
 */
export function destinationMap(lat: number, lon: number): Promise<ImageResult> {
  return googleImageAsDataUrl(
    "staticmap",
    `center=${lat},${lon}&zoom=17&size=640x640&scale=2&maptype=roadmap&markers=color:red%7C${lat},${lon}`,
  );
}

/**
 * The property from the street, at the size the jobs panel paints it.
 * `return_error_code` makes Google answer 404 where it has no imagery instead
 * of a 200 with a grey "no image" tile, so the panel's "No property photo
 * yet" state means what it says.
 */
export function streetView(lat: number, lon: number): Promise<ImageResult> {
  return googleImageAsDataUrl(
    "streetview",
    `size=640x320&location=${lat},${lon}&return_error_code=true`,
  );
}
