import { describe, expect, it } from "vitest";

import { parseRobots, politeFetch, robotsAllows, ROBOTS_AGENT_TOKEN } from "./polite-fetch";
import { FIRE_FEED_USER_AGENT } from "./types";

describe("robots.txt", () => {
  const txt = `
# County site
User-agent: *
Disallow: /admin/
Disallow: /*.pdf$
Allow: /admin/public-incidents
Crawl-delay: 10

User-agent: BadBot
Disallow: /
`;

  it("uses the * group when ours is not named, longest rule wins, Allow wins a tie", () => {
    const p = parseRobots(txt);
    expect(p.crawlDelaySeconds).toBe(10);
    expect(robotsAllows(p, "/active-incidents")).toBe(true);
    expect(robotsAllows(p, "/admin/users")).toBe(false);
    expect(robotsAllows(p, "/admin/public-incidents?page=1")).toBe(true);
    expect(robotsAllows(p, "/files/report.pdf")).toBe(false);
    expect(robotsAllows(p, "/files/report.pdf?x=1")).toBe(true);
  });

  it("a group naming us outranks the * group", () => {
    const p = parseRobots(
      `User-agent: *\nAllow: /\n\nUser-agent: ${ROBOTS_AGENT_TOKEN}\nDisallow: /calls\n`,
    );
    expect(robotsAllows(p, "/calls")).toBe(false);
    expect(robotsAllows(p, "/news")).toBe(true);
  });

  it("consecutive User-agent lines share their rules; an empty Disallow allows all", () => {
    const p = parseRobots("User-agent: Googlebot\nUser-agent: *\nDisallow:\n");
    expect(p.rules).toEqual([]);
    expect(robotsAllows(p, "/anything")).toBe(true);
  });

  it("Disallow: / shuts the whole site", () => {
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /\n"), "/active")).toBe(false);
  });
});

type Route = (url: string, headers: Record<string, string>) => Response;

function harness(route: Route, now = new Date("2026-10-11T21:00:00Z")) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const cursors = new Map<string, string>();
  const ctx = {
    now,
    cursors: {
      get: (k: string) => cursors.get(k) ?? null,
      set: (k: string, v: string) => void cursors.set(k, v),
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ url, headers });
      return route(url, headers);
    }) as typeof fetch,
  };
  return { ctx, requests, cursors };
}

const PAGE = "https://911.example.gov/active";
const html = (body: string) =>
  new Response(`<!doctype html><html><body>${body}</body></html>`, {
    headers: { "content-type": "text/html", etag: 'W/"p1"' },
  });

describe("politeFetch", () => {
  it("reads robots.txt first, says who it is, and returns the page", async () => {
    const { ctx, requests } = harness((url) =>
      url.endsWith("/robots.txt")
        ? new Response("User-agent: *\nAllow: /\n")
        : html("<table></table>"),
    );
    const r = await politeFetch(ctx, PAGE, { accept: "text/html" });
    expect(r.kind).toBe("body");
    expect(requests.map((q) => q.url)).toEqual(["https://911.example.gov/robots.txt", PAGE]);
    expect(requests[1]!.headers["User-Agent"]).toBe(FIRE_FEED_USER_AGENT);
  });

  it("does not fetch a page robots.txt disallows", async () => {
    const { ctx, requests } = harness((url) =>
      url.endsWith("/robots.txt") ? new Response("User-agent: *\nDisallow: /active\n") : html("x"),
    );
    const r = await politeFetch(ctx, PAGE, { accept: "text/html" });
    expect(r).toMatchObject({ kind: "error" });
    expect(r.kind === "error" && r.reason).toMatch(/robots\.txt asks/);
    expect(requests).toHaveLength(1);
  });

  it("a missing robots.txt (404) means no rules; a broken one (503) means stay away", async () => {
    const ok = harness((url) =>
      url.endsWith("/robots.txt") ? new Response("nope", { status: 404 }) : html("x"),
    );
    expect((await politeFetch(ok.ctx, PAGE, { accept: "text/html" })).kind).toBe("body");
    const down = harness((url) =>
      url.endsWith("/robots.txt") ? new Response("busy", { status: 503 }) : html("x"),
    );
    const r = await politeFetch(down.ctx, PAGE, { accept: "text/html" });
    expect(r.kind).toBe("error");
    expect(down.requests).toHaveLength(1);
  });

  it("remembers robots.txt for a day, and never reads a page twice within two minutes (or the Crawl-delay)", async () => {
    const t0 = new Date("2026-10-11T21:00:00Z");
    const h = harness(
      (url) =>
        url.endsWith("/robots.txt") ? new Response("User-agent: *\nCrawl-delay: 300\n") : html("x"),
      t0,
    );
    await politeFetch(h.ctx, PAGE, { accept: "text/html" });
    const again = await politeFetch({ ...h.ctx, now: new Date(t0.getTime() + 90_000) }, PAGE, {
      accept: "text/html",
    });
    expect(again.kind).toBe("skipped");
    const later = await politeFetch({ ...h.ctx, now: new Date(t0.getTime() + 200_000) }, PAGE, {
      accept: "text/html",
    });
    expect(later.kind).toBe("skipped"); // 300 s Crawl-delay
    const after = await politeFetch({ ...h.ctx, now: new Date(t0.getTime() + 301_000) }, PAGE, {
      accept: "text/html",
    });
    expect(after.kind).toBe("body");
    expect(h.requests.filter((q) => q.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("asks conditionally and treats 304 as 'unchanged'", async () => {
    const { ctx, requests } = harness((url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(null, { status: 304 }),
    );
    const r = await politeFetch(ctx, PAGE, {
      accept: "text/html",
      validators: { etag: 'W/"p1"', lastModified: "Sun, 11 Oct 2026 20:00:00 GMT" },
    });
    expect(r.kind).toBe("not_modified");
    expect(requests[1]!.headers["If-None-Match"]).toBe('W/"p1"');
    expect(requests[1]!.headers["If-Modified-Since"]).toBe("Sun, 11 Oct 2026 20:00:00 GMT");
  });

  it("refuses a login page, a CAPTCHA page and a 401/403", async () => {
    const login = harness((url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : html('<form><input type="password"></form>'),
    );
    expect(await politeFetch(login.ctx, PAGE, { accept: "text/html" })).toMatchObject({
      kind: "error",
    });
    const captcha = harness((url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : html('<div class="cf-turnstile"></div>'),
    );
    expect(await politeFetch(captcha.ctx, PAGE, { accept: "text/html" })).toMatchObject({
      kind: "error",
    });
    const denied = harness((url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response("no", { status: 403 }),
    );
    const r = await politeFetch(denied.ctx, PAGE, { accept: "text/html" });
    expect(r.kind === "error" && r.reason).toMatch(/login or permission/);
  });

  it("follows a redirect on the same site, refuses one to another site or inward", async () => {
    const same = harness((url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : url === PAGE
          ? new Response(null, { status: 301, headers: { location: "/active/" } })
          : html("ok"),
    );
    const s = await politeFetch(same.ctx, PAGE, { accept: "text/html" });
    expect(s.kind === "body" && s.url).toBe("https://911.example.gov/active/");

    const other = harness((url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(null, {
            status: 302,
            headers: { location: "https://elsewhere.example.com/x" },
          }),
    );
    const o = await politeFetch(other.ctx, PAGE, { accept: "text/html" });
    expect(o.kind === "error" && o.reason).toMatch(/redirects to another site/);

    const inward = harness((url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
    );
    const i = await politeFetch(inward.ctx, PAGE, { accept: "text/html" });
    expect(i.kind === "error" && i.reason).toBe("That address points inside a private network");
  });

  it("refuses a private address before any request", async () => {
    const h = harness(() => html("never"));
    expect(
      await politeFetch(h.ctx, "http://192.168.1.10/calls", { accept: "text/html" }),
    ).toMatchObject({ kind: "error" });
    expect(h.requests).toHaveLength(0);
  });
});
