/**
 * Fetching a public incident page the way a well-behaved reader does.
 *
 * Mark's rule for these pages (relayed 11 Oct): only public government
 * pages, no logins, no CAPTCHAs, nothing behind auth, respect robots.txt,
 * never more often than every two minutes per URL. So, before every fetch:
 *
 *  1. The address must be public (`checkPublicUrl`): http(s), no
 *     credentials, nothing on a private network.
 *  2. Two minutes since this URL was last fetched, or longer if the site's
 *     robots.txt asks for a Crawl-delay. (The database's poll_minutes CHECK
 *     and the kick enforce the same floor; this is the last line.)
 *  3. robots.txt allows our user agent to read the path (RFC 9309: a 4xx
 *     robots.txt means no rules; a 5xx or no answer means stay away). The
 *     answer is remembered for a day — an hour after a failure.
 *  4. The request says who we are and is conditional (ETag /
 *     Last-Modified), so an unchanged page costs the site a 304.
 *  5. Redirects are followed only on the same site, each hop re-checked.
 *  6. A page that wants a login or shows a CAPTCHA is refused, not parsed.
 *
 * State (robots verdicts, last-fetch times) lives in the source's cursors
 * (fire_feed_cursors), which no client role can write.
 */
import { checkPublicUrl } from "@/lib/public-url";

import { looksGated } from "./public-page";
import type { FetchContext } from "./types";
import { FIRE_FEED_USER_AGENT } from "./types";

/** The token robots.txt groups are matched against. */
export const ROBOTS_AGENT_TOKEN = "RecoveryHub-FireFeed";
export const MIN_INTERVAL_MS = 120_000;
const ROBOTS_TTL_MS = 86_400_000;
const ROBOTS_FAIL_TTL_MS = 3_600_000;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;

/* ------------------------------------------------------------------ */
/*  robots.txt                                                          */
/* ------------------------------------------------------------------ */

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
  /** True when robots.txt could not be read and the site is treated as off limits. */
  unreachable?: boolean;
}

/**
 * The group for our agent, else the `*` group. Groups are consecutive
 * User-agent lines followed by their rules (RFC 9309 §2.2.1).
 */
export function parseRobots(text: string, agent = ROBOTS_AGENT_TOKEN): RobotsPolicy {
  type Group = { agents: string[]; rules: RobotsRule[]; delay: number | null };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: key === "allow", path: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }
  const me = agent.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && me.startsWith(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySeconds: chosen.reduce<number | null>(
      (d, g) => (g.delay != null ? Math.max(d ?? 0, g.delay) : d),
      null,
    ),
  };
}

function ruleRegex(path: string): RegExp {
  const anchored = path.endsWith("$");
  const body = (anchored ? path.slice(0, -1) : path)
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Longest matching rule wins; on a tie, Allow wins; no match allows. */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (policy.unreachable) return false;
  let best: RobotsRule | null = null;
  for (const r of policy.rules) {
    if (!ruleRegex(r.path).test(pathAndQuery)) continue;
    if (
      !best ||
      r.path.length > best.path.length ||
      (r.path.length === best.path.length && r.allow)
    )
      best = r;
  }
  return best ? best.allow : true;
}

/* ------------------------------------------------------------------ */
/*  The fetch                                                           */
/* ------------------------------------------------------------------ */

export type PoliteResult =
  | {
      kind: "body";
      status: number;
      body: string;
      contentType: string;
      etag: string | null;
      lastModified: string | null;
      url: string;
    }
  | { kind: "not_modified"; etag: string | null; lastModified: string | null }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; status: number | null; reason: string };

async function getOnce(fetchImpl: typeof fetch, url: string, headers: Record<string, string>) {
  return fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Same-site redirects only, each hop through checkPublicUrl. */
async function getFollowing(
  fetchImpl: typeof fetch,
  start: URL,
  headers: Record<string, string>,
): Promise<{ res: Response; url: URL } | { error: string; status: number | null }> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await getOnce(fetchImpl, url.toString(), headers);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { error: /abort|timeout/i.test(msg) ? "Timed out" : msg.slice(0, 200), status: null };
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && res.status !== 304 && loc) {
      const next = checkPublicUrl(new URL(loc, url).toString());
      if (!next.ok) return { error: next.reason, status: res.status };
      if (next.url.host !== start.host) {
        return {
          error: `This page redirects to another site (${next.url.host}) — add that address instead.`,
          status: res.status,
        };
      }
      url = next.url;
      continue;
    }
    return { res, url };
  }
  return { error: "Too many redirects", status: null };
}

async function robotsFor(
  ctx: Pick<FetchContext, "fetch" | "now" | "cursors">,
  origin: URL,
): Promise<RobotsPolicy> {
  const key = `robots:${origin.host}`;
  try {
    const cached = JSON.parse(ctx.cursors.get(key) ?? "null") as
      (RobotsPolicy & { at: string }) | null;
    if (cached) {
      const age = ctx.now.getTime() - Date.parse(cached.at);
      if (age < (cached.unreachable ? ROBOTS_FAIL_TTL_MS : ROBOTS_TTL_MS)) return cached;
    }
  } catch {
    /* a bad cursor is a missing one */
  }
  const robotsUrl = new URL("/robots.txt", origin);
  const got = await getFollowing(ctx.fetch, robotsUrl, {
    "User-Agent": FIRE_FEED_USER_AGENT,
    Accept: "text/plain",
  });
  let policy: RobotsPolicy;
  if ("error" in got) {
    policy = { rules: [], crawlDelaySeconds: null, unreachable: true };
  } else if (got.res.status >= 200 && got.res.status < 300) {
    policy = parseRobots((await got.res.text()).slice(0, 500_000));
  } else if (got.res.status >= 400 && got.res.status < 500) {
    policy = { rules: [], crawlDelaySeconds: null };
  } else {
    policy = { rules: [], crawlDelaySeconds: null, unreachable: true };
  }
  ctx.cursors.set(key, JSON.stringify({ ...policy, at: ctx.now.toISOString() }));
  return policy;
}

/**
 * Every rule above, then the GET. `validators` are the source row's ETag /
 * Last-Modified. Never throws.
 */
export async function politeFetch(
  ctx: Pick<FetchContext, "fetch" | "now" | "cursors">,
  rawUrl: string,
  opts: {
    accept: string;
    validators?: { etag?: string | null; lastModified?: string | null };
    respectInterval?: boolean;
  },
): Promise<PoliteResult> {
  const check = checkPublicUrl(rawUrl);
  if (!check.ok) return { kind: "error", status: null, reason: check.reason };
  const url = check.url;

  const lastKey = `last:${url.toString()}`;
  const last = ctx.cursors.get(lastKey);
  const robots = await robotsFor(ctx, url);
  if (robots.unreachable) {
    return {
      kind: "error",
      status: null,
      reason:
        "Could not read the site's robots.txt (server error or no answer), so the feed stays away for now.",
    };
  }
  if (!robotsAllows(robots, `${url.pathname}${url.search}`)) {
    return {
      kind: "error",
      status: null,
      reason:
        "The site's robots.txt asks automated readers not to fetch this page, so the feed will not read it.",
    };
  }
  if (opts.respectInterval !== false && last) {
    const since = ctx.now.getTime() - Date.parse(last);
    const floor = Math.max(MIN_INTERVAL_MS, (robots.crawlDelaySeconds ?? 0) * 1000);
    if (since < floor) {
      return {
        kind: "skipped",
        reason: `Checked ${Math.round(since / 1000)}s ago; this site is read at most every ${Math.round(floor / 1000)}s.`,
      };
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": FIRE_FEED_USER_AGENT,
    Accept: opts.accept,
  };
  if (opts.validators?.etag) headers["If-None-Match"] = opts.validators.etag;
  if (opts.validators?.lastModified) headers["If-Modified-Since"] = opts.validators.lastModified;
  const got = await getFollowing(ctx.fetch, url, headers);
  ctx.cursors.set(lastKey, ctx.now.toISOString());
  if ("error" in got) return { kind: "error", status: got.status, reason: got.error };
  const { res } = got;
  const etag = res.headers.get("etag");
  const lastModified = res.headers.get("last-modified");
  if (res.status === 304) {
    return {
      kind: "not_modified",
      etag: etag ?? opts.validators?.etag ?? null,
      lastModified: lastModified ?? opts.validators?.lastModified ?? null,
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      kind: "error",
      status: res.status,
      reason: "The page refused us (login or permission required) — only public pages can be read.",
    };
  }
  if (res.status === 429)
    return {
      kind: "error",
      status: 429,
      reason: "The site asked us to slow down (429). Check this page less often.",
    };
  if (!res.ok) return { kind: "error", status: res.status, reason: `HTTP ${res.status}` };
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES)
    return { kind: "error", status: res.status, reason: "The page is larger than 3 MB" };
  const body = await res.text();
  if (body.length > MAX_BYTES)
    return { kind: "error", status: res.status, reason: "The page is larger than 3 MB" };
  const contentType = res.headers.get("content-type") ?? "";
  if (/html/i.test(contentType) || /^\s*(<!doctype html|<html)/i.test(body)) {
    const gated = looksGated(body);
    if (gated) return { kind: "error", status: res.status, reason: gated };
  }
  return {
    kind: "body",
    status: res.status,
    body,
    contentType,
    etag,
    lastModified,
    url: got.url.toString(),
  };
}
