/**
 * Links that hand a place to Google Maps, built one way.
 *
 * The canonical form is Google's documented Maps URL,
 * `https://www.google.com/maps/search/?api=1&query=<lat>,<lon>` (or the
 * address, URL-encoded). It always opens as a top-level page in a new tab:
 * a plain `<a target="_blank">`, never an iframe and never `window.open` from
 * a frame. Google's map pages refuse to be framed (X-Frame-Options) and send
 * Cross-Origin-Opener-Policy, which Chrome will not load into a sandboxed
 * browsing context — both show up as ERR_BLOCKED_BY_RESPONSE.
 */

/** `rel` for every link that leaves the app in a new tab. */
export const EXTERNAL_LINK_REL = "noopener noreferrer";

export type MapsQuery = { lat: number; lon: number } | string;

/**
 * Google Maps search URL for a point or an address, or null when there is
 * nothing to search for (no address, or coordinates that are not numbers).
 */
export function googleMapsSearchUrl(query: MapsQuery | null | undefined): string | null {
  if (query == null) return null;
  if (typeof query === "string") {
    const q = query.trim();
    return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
  }
  const { lat, lon } = query;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // The comma stays literal, as in Google's own examples.
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

/**
 * Whether this page is running inside someone else's frame (the Lovable
 * editor's preview, for one). A new tab opened from a sandboxed frame keeps
 * the frame's sandbox, and Google refuses to load into it — nothing the app
 * sends can lift that, so the link offers to copy itself there instead.
 */
export function isFramed(
  win: Pick<Window, "self" | "top"> | undefined = globalThis.window,
): boolean {
  if (!win) return false;
  try {
    return win.self !== win.top;
  } catch {
    // A cross-origin parent can throw on access: that is a frame too.
    return true;
  }
}
