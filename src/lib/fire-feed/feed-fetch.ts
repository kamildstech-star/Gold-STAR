/**
 * One polite GET of a feed: who we are, a timeout, and a conditional request
 * when the server gave us a validator last time.
 *
 * A feed polled every quarter hour is mostly unchanged; ETag / Last-Modified
 * let the server answer 304 with no body, which is cheaper for them and for
 * us. Never throws — a failure is a reason the run log keeps.
 *
 * Redirects are followed by hand, at most three, and every hop must pass
 * `checkPublicUrl`: an admin-typed feed URL must not become a way to make
 * this server request a private address.
 */
import { checkPublicUrl } from "@/lib/public-url";

import { FIRE_FEED_USER_AGENT } from "./types";

export const FEED_TIMEOUT_MS = 15_000;
/** A feed bigger than this is not a feed we should be parsing every few minutes. */
export const FEED_MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

export type FeedFetch =
  | { ok: true; status: number; body: string; etag: string | null; lastModified: string | null }
  | { ok: true; status: 304; notModified: true; etag: string | null; lastModified: string | null }
  | { ok: false; status: number | null; error: string };

export async function fetchFeed(
  fetchImpl: typeof fetch,
  url: string,
  validators: { etag?: string | null; lastModified?: string | null } = {},
): Promise<FeedFetch> {
  const headers: Record<string, string> = {
    "User-Agent": FIRE_FEED_USER_AGENT,
    Accept:
      "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
  };
  if (validators.etag) headers["If-None-Match"] = validators.etag;
  if (validators.lastModified) headers["If-Modified-Since"] = validators.lastModified;

  let target = url;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const check = checkPublicUrl(target);
    if (!check.ok) return { ok: false, status: null, error: check.reason };
    try {
      res = await fetchImpl(check.url.toString(), {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        status: null,
        error: /abort|timeout/i.test(msg) ? "Timed out" : msg.slice(0, 200),
      };
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
      target = new URL(location, check.url).toString();
      continue;
    }
    break;
  }
  if (!res) return { ok: false, status: null, error: "No response" };
  if (res.status >= 300 && res.status < 400 && res.status !== 304) {
    return { ok: false, status: res.status, error: "Too many redirects" };
  }

  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  if (res.status === 304)
    return {
      ok: true,
      status: 304,
      notModified: true,
      etag: etag ?? validators.etag ?? null,
      lastModified: lastModified ?? validators.lastModified ?? null,
    };
  if (!res.ok) {
    const reason = res.status === 429 ? "Rate limited by the server (429)" : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: reason };
  }
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > FEED_MAX_BYTES) {
    return { ok: false, status: res.status, error: "Feed is larger than 2 MB" };
  }
  const body = await res.text();
  if (body.length > FEED_MAX_BYTES)
    return { ok: false, status: res.status, error: "Feed is larger than 2 MB" };
  return { ok: true, status: res.status, body, etag, lastModified };
}
