/**
 * The fire feed's contract: what a source hands the pipeline, and what the
 * pipeline needs to know about where Gold Star is watching.
 *
 * Mark: "we need to make a feed that crawls google and x for fires in certain
 * areas and gathers those and can implement it into the program in place of
 * bnn", then "I don't want to pay API fees." So every source behind this
 * interface is free and sanctioned — a published feed or a public government
 * page, never a scraped search engine or social network.
 *
 * A source only FETCHES. It does not decide what is a fire, where it is, or
 * whether it is new; the pipeline does that the same way for every source, so
 * a Google News story, a fire department's RSS item and a county 911 page row
 * become leads by one set of rules and land through the one incident insert
 * the BNN webhook uses. Adding a source is a new file in `sources/` named
 * `<kind>.source.ts` whose default export is a `FireSource`; the registry
 * finds it by name.
 *
 * Keep this file dependency-free. It is the seam other source files build
 * against.
 */

/** Every kind the database allows (fire_feed_sources.kind). */
export type FireSourceKind = "google_news" | "rss" | "public_page";

/** One row of fire_feed_areas: a town Gold Star wants fires from. */
export interface WatchArea {
  id: string;
  label: string;
  /** Town or city as people write it in a headline. */
  locality: string | null;
  /** Without the word "County". */
  county: string | null;
  /** Two-letter state. */
  state: string;
  postal_codes: string[];
  center_lat: number | null;
  center_lon: number | null;
  radius_miles: number;
  active: boolean;
}

/** One row of fire_feed_sources, as a source sees it. */
export interface SourceRow {
  id: string;
  kind: FireSourceKind;
  label: string;
  url: string | null;
  /** Kind-specific settings (a public page's parser preset, say). */
  config: Record<string, unknown>;
  /** A feed known to cover one area; null means "match by location". */
  area_id: string | null;
  poll_minutes: number;
  enabled: boolean;
  last_fetched_at: string | null;
  etag: string | null;
  last_modified: string | null;
}

/**
 * Something a source found. Not yet a lead: nobody has decided it is a fire,
 * where it is, or that it is new.
 */
export interface RawItem {
  /**
   * Stable identity across runs, used to skip what was already seen and as
   * the incident's external_ref: a canonical article URL, a feed guid, a
   * 911 center's own incident id.
   */
  key: string;
  sourceKind: FireSourceKind;
  sourceId: string;
  title: string;
  url: string | null;
  /** The newspaper or agency, when the feed says. */
  publisher: string | null;
  /** ISO timestamp, when the feed says. */
  publishedAt: string | null;
  /** Summary or description, tags stripped. */
  text: string;
  /** The area the source was asked about, when it was asked about one. */
  areaId: string | null;
  /**
   * True when `areaId` is the source's own area (a feed pinned to one place,
   * such as a county's 911 page), not the town a search was run for. A pinned
   * area names the town for an item that names none; a search hint never does.
   */
  areaPinned?: boolean;
  /** Coordinates the feed itself carried (a 911 feed's geo:lat/geo:long). */
  point?: { lat: number; lon: number } | null;
  /** Every field a structured source gave, as label/value pairs, for the details pop-up. */
  details?: [string, string][];
  /**
   * Columns a structured source already separated out (a 911 page's table).
   * The pipeline prefers these to anything it would read out of prose.
   */
  structured?: {
    incidentType?: string | null;
    address?: string | null;
    locality?: string | null;
    units?: number | null;
    status?: string | null;
    /** The cross street, when the page gives the street and its cross street but no house number. */
    crossStreet?: string | null;
    /** The page's own alarm level ("2", "2nd alarm"). */
    alarmLevel?: string | null;
  } | null;
}

/** What a source tells the pipeline to remember about the fetch. */
export interface FetchState {
  /** HTTP status of the last request, when there was one. */
  status?: number | null;
  etag?: string | null;
  lastModified?: string | null;
  /** True when the server answered 304 — nothing new, nothing to parse. */
  notModified?: boolean;
  /** Plain-language reason a fetch failed, kept on the source row. */
  error?: string | null;
}

export interface FetchContext {
  source: SourceRow;
  /** Active areas only. */
  areas: WatchArea[];
  now: Date;
  /** Injected so tests use recorded fixtures and production uses the network. */
  fetch: typeof fetch;
  /** Per-source, per-query cursor storage (fire_feed_cursors). */
  cursors: {
    get(queryKey: string): string | null;
    set(queryKey: string, value: string): void;
  };
}

export interface FetchResult {
  items: RawItem[];
  state: FetchState;
  /** Per-query notes for the run log ("Lakewood, NJ: 5 items"). */
  notes?: string[];
}

export interface FireSource {
  kind: FireSourceKind;
  /** Shown in the admin screen next to the source's rows. */
  label: string;
  fetch(ctx: FetchContext): Promise<FetchResult>;
}

/** The User-Agent every fire-feed request sends, so a site can see who we are. */
export const FIRE_FEED_USER_AGENT =
  "RecoveryHub-FireFeed/1.0 (Gold Star Restoration; +https://goldstarrestoration.com)";
