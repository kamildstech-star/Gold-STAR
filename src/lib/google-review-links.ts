const GOOGLE_REVIEW_HOSTS = new Set([
  "g.page",
  "google.com",
  "www.google.com",
  "maps.google.com",
  "maps.app.goo.gl",
  "search.google.com",
]);

/** Accept only Google-owned HTTPS destinations; the tracked route must not become an open redirect. */
export function normalizeGoogleReviewDestination(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !GOOGLE_REVIEW_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function googleReviewTrackingUrl(token: string, origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/review/${encodeURIComponent(token)}`;
}
