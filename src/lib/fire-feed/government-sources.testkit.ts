/**
 * Test-only: the government sources of migration 20261012090000, read from
 * the migration file itself, wired to the recorded responses in fixtures/ —
 * so the parser tests and the offline dry run use exactly the rows that
 * migration inserts. Imported only by *.test.ts files.
 */
import { readFileSync } from "node:fs";

import type { FireSourceKind, SourceRow, WatchArea } from "./types";

const MIGRATION = "supabase/migrations/20261012090000_fire_feed_government_sources.sql";

/** The watch areas as production seeded them (11 Oct 2026), Lakewood corrected. */
export const PRODUCTION_AREAS: WatchArea[] = [
  ["hav", "Haverstraw", "NY", 41.197858, -73.963419],
  ["brk", "Brooklyn", "NY", 40.627671, -73.942121],
  ["la", "Los Angeles", "CA", 33.989125, -118.275249],
  ["hou", "Houston", "TX", 29.653674, -95.509832],
  ["lkw", "Lakewood", "NJ", 40.102142, -74.171273],
].map(([id, locality, state, lat, lon]) => ({
  id: id as string,
  label: `${locality}, ${state}`,
  locality: locality as string,
  county: null,
  state: state as string,
  postal_codes: [],
  center_lat: lat as number,
  center_lon: lon as number,
  radius_miles: 15,
  active: true,
}));

const AREA_BY_TOWN: Record<string, string> = {
  Haverstraw: "hav",
  Brooklyn: "brk",
  "Los Angeles": "la",
  Houston: "hou",
  Lakewood: "lkw",
};

/** Recorded response per URL (fetched 11 Oct 2026 by the research pass). */
export const FIXTURE_FOR_URL: Record<string, string> = {
  "http://firewatch.44-control.net/status.json": "rockland-firewatch-status.json",
  "https://feeds.everbridge.net/feeds/453003085617722/rss/rss.xml": "notify-nyc-cap-rss.xml",
  "https://lafd.org/alerts-rss.xml": "lafd-alerts-rss.xml",
  "https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx?agency=F":
    "houston-hfd-active-incidents.html",
};

/** Every source row the migration inserts, as the run would load it. */
export function migrationSources(): SourceRow[] {
  const sql = readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
  const rows: SourceRow[] = [];
  const re =
    /\('(public_page|rss)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),\s*'([^']+)',\s*'([A-Z]{2})',\s*\$cfg\$([\s\S]*?)\$cfg\$::jsonb\)/g;
  for (const m of sql.matchAll(re)) {
    rows.push({
      id: `src-${rows.length + 1}`,
      kind: m[1] as FireSourceKind,
      label: m[2]!,
      url: m[3]!,
      config: JSON.parse(m[7]!) as Record<string, unknown>,
      area_id: AREA_BY_TOWN[m[5]!] ?? null,
      poll_minutes: Number(m[4]),
      enabled: false,
      last_fetched_at: null,
      etag: null,
      last_modified: null,
    });
  }
  return rows;
}

export function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/**
 * The network, offline: each source's recorded response, and a 404 for every
 * robots.txt (what all four hosts answered on 11 Oct).
 */
export const recordedFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
  const name = FIXTURE_FOR_URL[url];
  if (!name) return new Response("not recorded", { status: 404 });
  const type = name.endsWith(".json")
    ? "application/json"
    : name.endsWith(".html")
      ? "text/html"
      : "application/xml";
  return new Response(fixtureText(name), { headers: { "content-type": type } });
}) as typeof fetch;
