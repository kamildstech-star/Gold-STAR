import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { availableSourceKinds, fireSourceFor } from "./registry";
import type { FetchContext, SourceRow, WatchArea } from "./types";
import { FIRE_FEED_USER_AGENT } from "./types";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const areas: WatchArea[] = [
  {
    id: "lkw",
    label: "Lakewood, NJ",
    locality: "Lakewood",
    county: "Ocean",
    state: "NJ",
    postal_codes: [],
    center_lat: 40.08,
    center_lon: -74.21,
    radius_miles: 15,
    active: true,
  },
  {
    id: "hav",
    label: "Haverstraw, NY",
    locality: "Haverstraw",
    county: null,
    state: "NY",
    postal_codes: [],
    center_lat: 41.19,
    center_lon: -73.96,
    radius_miles: 15,
    active: true,
  },
];

const source = (over: Partial<SourceRow>): SourceRow => ({
  id: "src",
  kind: "rss",
  label: "Feed",
  url: null,
  config: {},
  area_id: null,
  poll_minutes: 15,
  enabled: true,
  last_fetched_at: null,
  etag: null,
  last_modified: null,
  ...over,
});

function ctx(src: SourceRow, respond: (url: string, init?: RequestInit) => Response) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const cursors = new Map<string, string>();
  const c: FetchContext = {
    source: src,
    areas,
    now: new Date("2026-10-11T21:00:00Z"),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return respond(url, init);
    }) as typeof fetch,
    cursors: { get: (k) => cursors.get(k) ?? null, set: (k, v) => void cursors.set(k, v) },
  };
  return { c, requests, cursors };
}

describe("the registry finds sources by file name", () => {
  it("has Google News and RSS in this build", () => {
    expect(availableSourceKinds()).toEqual(expect.arrayContaining(["google_news", "rss"]));
    expect(fireSourceFor("google_news")?.label).toBe("Google News");
    expect(fireSourceFor("x")).toBeNull();
  });
});

describe("Google News source (recorded responses)", () => {
  const gn = fireSourceFor("google_news")!;

  it("asks the RSS endpoint once per area, says who it is, and keys items by Google's guid", async () => {
    const { c, requests } = ctx(
      source({ kind: "google_news", label: "Google News" }),
      (url) =>
        new Response(
          fixture(
            url.includes("Haverstraw")
              ? "google-news-haverstraw-ny.xml"
              : "google-news-lakewood-nj.xml",
          ),
          {
            status: 200,
            headers: { "content-type": "application/xml" },
          },
        ),
    );
    const out = await gn.fetch(c);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.url.startsWith("https://news.google.com/rss/search?q="))).toBe(
      true,
    );
    expect(requests[0]!.headers["User-Agent"]).toBe(FIRE_FEED_USER_AGENT);
    // 5 + 7, less the one story ("What about the jet skis?…") both queries returned.
    expect(out.items).toHaveLength(11);
    const first = out.items[0]!;
    expect(first.key).toMatch(/^gnews:CBMi/);
    expect(first.title).toBe("Squatter accused of arson in blaze that injured firefighter");
    expect(first.publisher).toBe("NJ.com");
    expect(first.areaId).toBe("lkw");
    expect(out.notes).toEqual(["Lakewood, NJ: 5 items", "Haverstraw, NY: 7 items"]);
    expect(out.state.error).toBeNull();
  });

  it("one area failing is reported without losing the others", async () => {
    const { c } = ctx(source({ kind: "google_news" }), (url) =>
      url.includes("Haverstraw")
        ? new Response("busy", { status: 503 })
        : new Response(fixture("google-news-lakewood-nj.xml")),
    );
    const out = await gn.fetch(c);
    expect(out.items).toHaveLength(5);
    expect(out.state.error).toBe("1 of 2 area queries failed — Haverstraw, NY: HTTP 503");
  });

  it("a source pinned to one area asks only about that area", async () => {
    const { c, requests } = ctx(
      source({ kind: "google_news", area_id: "hav" }),
      () => new Response(fixture("google-news-haverstraw-ny.xml")),
    );
    await gn.fetch(c);
    expect(requests).toHaveLength(1);
    expect(decodeURIComponent(requests[0]!.url)).toContain('"Haverstraw" NY');
  });
});

describe("RSS source", () => {
  const rss = fireSourceFor("rss")!;

  it("reads a county 911 feed: guid keys, coordinates, the agency as publisher", async () => {
    const { c } = ctx(
      source({ url: "https://www.monroecounty.gov/incidents911.rss", label: "Monroe County 911" }),
      () => new Response(fixture("monroe-county-911.xml"), { headers: { etag: 'W/"abc"' } }),
    );
    const out = await rss.fetch(c);
    expect(out.items).toHaveLength(6);
    const it = out.items[0]!;
    expect(it.key).toBe("https://monroecounty.gov/safety-incidents?GREE2628401918=");
    expect(it.point).toEqual({ lat: 43.2381, lon: -77.6474 });
    expect(it.publisher).toBe("Monroe County 911");
    expect(out.state.etag).toBe('W/"abc"');
  });

  it("asks conditionally with the validators it was given, and a 304 is 'nothing new'", async () => {
    const { c, requests } = ctx(
      source({
        url: "https://fire.example.gov/rss",
        etag: 'W/"abc"',
        last_modified: "Sun, 11 Oct 2026 20:00:00 GMT",
      }),
      () => new Response(null, { status: 304 }),
    );
    const out = await rss.fetch(c);
    expect(requests[0]!.headers["If-None-Match"]).toBe('W/"abc"');
    expect(requests[0]!.headers["If-Modified-Since"]).toBe("Sun, 11 Oct 2026 20:00:00 GMT");
    expect(out.items).toEqual([]);
    expect(out.state.notModified).toBe(true);
  });

  it("canonical article URLs are the keys for a news feed", async () => {
    const { c } = ctx(
      source({ url: "https://fire.example.gov/rss" }),
      () => new Response(fixture("fire-department-sample.xml")),
    );
    const out = await rss.fetch(c);
    expect(out.items[0]!.key).toBe("https://fire.example.gov/incidents/2026-1011-01");
  });

  it("says plainly when a URL is not a feed", async () => {
    const { c } = ctx(
      source({ url: "https://fire.example.gov/" }),
      () => new Response("<!doctype html><title>Home</title>"),
    );
    const out = await rss.fetch(c);
    expect(out.state.error).toBe("That URL did not return an RSS or Atom feed");
  });

  it("a network failure is a reason, not a throw", async () => {
    const { c } = ctx(source({ url: "https://fire.example.gov/rss" }), () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const out = await rss.fetch(c);
    expect(out.state.error).toBe("getaddrinfo ENOTFOUND");
  });

  it("follows a redirect to another public address", async () => {
    const { c, requests } = ctx(source({ url: "http://fire.example.gov/rss" }), (url) =>
      url.startsWith("http://")
        ? new Response(null, { status: 301, headers: { location: "https://fire.example.gov/rss" } })
        : new Response(fixture("fire-department-sample.xml")),
    );
    const out = await rss.fetch(c);
    expect(requests.map((r) => r.url)).toEqual([
      "http://fire.example.gov/rss",
      "https://fire.example.gov/rss",
    ]);
    expect(out.items).toHaveLength(6);
  });

  it("refuses a redirect into a private network, and a private address outright", async () => {
    const { c, requests } = ctx(
      source({ url: "https://fire.example.gov/rss" }),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );
    const out = await rss.fetch(c);
    expect(out.state.error).toBe("That address points inside a private network");
    expect(requests).toHaveLength(1);

    const direct = ctx(source({ url: "http://127.0.0.1:8080/feed" }), () => new Response("never"));
    expect((await rss.fetch(direct.c)).state.error).toBe(
      "That address points inside a private network",
    );
    expect(direct.requests).toHaveLength(0);
  });
});
