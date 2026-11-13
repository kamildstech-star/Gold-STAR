/**
 * Public incident pages: the "active incidents" / "current calls" pages many
 * county 911 centers and fire departments publish, read without a browser.
 *
 * Mark, after the X adapter was dropped: "I don't want to pay API fees." A
 * government page that lists live calls is free, already public, and often
 * closer to the fire than any news story. An admin adds the page's URL and
 * says how to read it — one of three presets:
 *
 *   - html_table: the page has a <table> of calls. Which table, and which
 *     column holds the type, address, time, units, town, status and the
 *     center's own incident number (by header text or column number). Left
 *     blank, the columns are guessed from the headers.
 *   - json:       the page's data endpoint. A path to the list of calls and a
 *     path per field ("properties.address", "geometry.coordinates[1]").
 *     GeoJSON FeatureCollections are understood without a list path.
 *   - rss:        the center publishes a feed (Monroe County, NY does); read
 *     by the fire feed's RSS reader.
 *
 * Pure: page text in, rows out. Fetching (robots.txt, the two-minute floor,
 * conditional GET, refusing logins and CAPTCHAs) is polite-fetch.ts; turning
 * rows into feed items is the source file. Every row becomes a RawItem with
 * its columns in `structured`, so the fire feed's rules read the 911
 * center's own type and address rather than guessing them from prose.
 */
import { z } from "zod";

import type { RawItem, SourceRow, WatchArea } from "./types";

export const PUBLIC_PAGE_FIELDS = [
  "type",
  "address",
  "time",
  "units",
  "town",
  "status",
  "id",
  "cross",
  "alarm",
] as const;
export type PublicPageField = (typeof PUBLIC_PAGE_FIELDS)[number];

export const PUBLIC_PAGE_FIELD_LABEL: Record<PublicPageField, string> = {
  type: "Call type",
  address: "Address",
  time: "Time",
  units: "Units",
  town: "Town",
  status: "Status",
  id: "Incident #",
  cross: "Cross street",
  alarm: "Alarm level",
};

const pathOrColumn = z.string().trim().max(120).optional();

export const publicPageConfigSchema = z.object({
  preset: z.enum(["html_table", "json", "rss"]),
  /** The admin confirmed this is a public government page (asked when the host is not .gov / .us). */
  government_ack: z.boolean().optional(),
  /** Times on the page are in this zone when they carry none. */
  timezone: z.string().trim().max(64).optional(),
  /** Keep only rows whose type or text mentions a fire (default true). */
  fire_rows_only: z.boolean().optional(),
  /**
   * Rows whose status is one of these are dropped ("Closed", "Completed").
   * Off unless set: a fire that was put out an hour ago is still a
   * restoration lead, and the ledger already stops a call being read twice.
   */
  exclude_statuses: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  /** Why an admin added or paused this source — shown on the settings screen. */
  note: z.string().trim().max(500).optional(),
  table: z
    .object({
      /** 1-based: "the 2nd table on the page". */
      index: z.number().int().min(1).max(50).optional(),
      /** The table's HTML id ("GridView2"), which wins over the index when set. */
      id: z
        .string()
        .trim()
        .max(80)
        .regex(/^[A-Za-z][\w:.-]*$/)
        .optional(),
      columns: z
        .object(
          Object.fromEntries(PUBLIC_PAGE_FIELDS.map((f) => [f, pathOrColumn])) as Record<
            PublicPageField,
            typeof pathOrColumn
          >,
        )
        .partial()
        .optional(),
    })
    .optional(),
  json: z
    .object({
      items_path: z.string().trim().max(200).optional(),
      fields: z
        .object({
          ...(Object.fromEntries(PUBLIC_PAGE_FIELDS.map((f) => [f, pathOrColumn])) as Record<
            PublicPageField,
            typeof pathOrColumn
          >),
          lat: pathOrColumn,
          lon: pathOrColumn,
        })
        .partial()
        .optional(),
    })
    .optional(),
});

export type PublicPageConfig = z.infer<typeof publicPageConfigSchema>;

export const DEFAULT_TIMEZONE = "America/New_York";

/**
 * The zone a page's bare times are in, from the watch area's state when the
 * source does not say: Rockland's page prints Eastern time with no zone,
 * Houston's prints Central. Indiana is Eastern for Columbus; the few Central
 * counties there are not Gold Star's.
 */
const STATE_TIMEZONE: Record<string, string> = {
  CA: "America/Los_Angeles",
  OR: "America/Los_Angeles",
  WA: "America/Los_Angeles",
  NV: "America/Los_Angeles",
  AZ: "America/Phoenix",
  CO: "America/Denver",
  UT: "America/Denver",
  NM: "America/Denver",
  TX: "America/Chicago",
  IL: "America/Chicago",
  WI: "America/Chicago",
  MN: "America/Chicago",
  MO: "America/Chicago",
  LA: "America/Chicago",
  OK: "America/Chicago",
  TN: "America/Chicago",
  AL: "America/Chicago",
  MS: "America/Chicago",
  IA: "America/Chicago",
  KS: "America/Chicago",
  AR: "America/Chicago",
  NE: "America/Chicago",
  MI: "America/Detroit",
  IN: "America/Indiana/Indianapolis",
};

export function timezoneForState(state: string | null | undefined): string {
  return (state && STATE_TIMEZONE[state.toUpperCase()]) || DEFAULT_TIMEZONE;
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone a source's zone-less times are in: its own `config.timezone` when
 * that is a real zone, else the state of the watch area it is pinned to, else
 * Eastern (where most of Gold Star's offices are).
 */
export function sourceTimeZone(
  source: Pick<SourceRow, "config" | "area_id">,
  areas: readonly Pick<WatchArea, "id" | "state">[],
): string {
  const configured =
    typeof source.config?.timezone === "string" ? source.config.timezone.trim() : "";
  if (configured && isTimeZone(configured)) return configured;
  const area = source.area_id ? areas.find((a) => a.id === source.area_id) : undefined;
  return timezoneForState(area?.state);
}

/** A row of a public page, every column a string (or null). */
export interface PageRow {
  type: string | null;
  address: string | null;
  time: string | null;
  units: string | null;
  town: string | null;
  status: string | null;
  id: string | null;
  cross?: string | null;
  alarm?: string | null;
  lat: number | null;
  lon: number | null;
  /**
   * Every field the source gave for the call, in its own words and order
   * ("Incident Number", "Time Opened", "Friendly", "Units"…), for the call's
   * details pop-up (4 Nov: "they have address bala bala, please show all").
   */
  details?: [string, string][];
}

/* ------------------------------------------------------------------ */
/*  Text                                                                */
/* ------------------------------------------------------------------ */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : Number(ent.slice(1));
      try {
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : "";
      } catch {
        return "";
      }
    }
    return NAMED[ent.toLowerCase()] ?? whole;
  });
}

/** Markup removed, entities decoded, whitespace collapsed. */
export function cellText(html: string): string {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/*  HTML tables                                                         */
/* ------------------------------------------------------------------ */

export interface HtmlTable {
  /** The table's id attribute, when it has one. */
  id: string | null;
  /** Header cells, from the first row that has <th> cells (or the first row). */
  headers: string[];
  rows: string[][];
}

/** Cap on rows read from one page, whatever it holds. */
export const MAX_PAGE_ROWS = 500;

/**
 * Each <table>'s own markup, with any table nested inside it cut out.
 *
 * ASP.NET pages (Houston's HFD list is one) put the call list inside a layout
 * table, so a table can only be read by matching each <table> with ITS
 * </table>. Tables come back in the order they open on the page.
 */
function splitTables(html: string): { open: string; body: string }[] {
  const tags = [...html.matchAll(/<table\b[^>]*>|<\/table\s*>/gi)];
  const stack: { order: number; open: string; start: number; nested: [number, number][] }[] = [];
  const out: { order: number; open: string; body: string }[] = [];
  let order = 0;
  for (const t of tags) {
    const at = t.index!;
    if (t[0][1] !== "/") {
      stack.push({ order: order++, open: t[0], start: at + t[0].length, nested: [] });
      continue;
    }
    const top = stack.pop();
    if (!top) continue;
    let body = "";
    let cursor = top.start;
    for (const [s, e] of top.nested) {
      body += html.slice(cursor, s);
      cursor = e;
    }
    body += html.slice(cursor, at);
    out.push({ order: top.order, open: top.open, body });
    // The parent skips this whole table, tags included.
    const parent = stack[stack.length - 1];
    if (parent) parent.nested.push([top.start - top.open.length, at + t[0].length]);
  }
  return out.sort((a, b) => a.order - b.order).map(({ open, body }) => ({ open, body }));
}

/**
 * Every <table> on the page, as header + rows of cell text. Comments and
 * scripts are dropped first so a commented-out table does not count; a table
 * nested in another is its own table, never rows of the outer one.
 */
export function parseHtmlTables(html: string): HtmlTable[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script[\s\S]*?<\/script>/gi, " ");
  const tables: HtmlTable[] = [];
  for (const t of splitTables(clean)) {
    const id = /\sid\s*=\s*["']?([^"'\s>]+)/i.exec(t.open)?.[1] ?? null;
    const rows: { th: boolean; cells: string[] }[] = [];
    for (const r of t.body.matchAll(
      /<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tbody>|<\/thead>|<\/tfoot>|$)/gi,
    )) {
      const cells = [...r[1]!.matchAll(/<(t[dh])\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi)].map(
        (c) => ({
          th: c[1]!.toLowerCase() === "th",
          text: cellText(c[2]!.replace(/<\/t[dh]>\s*$/i, "")),
        }),
      );
      if (cells.length === 0) continue;
      rows.push({ th: cells.every((c) => c.th), cells: cells.map((c) => c.text) });
    }
    if (rows.length === 0) continue;
    const headIdx = rows.findIndex((r) => r.th);
    const headerRow = headIdx >= 0 ? headIdx : 0;
    tables.push({
      id,
      headers: rows[headerRow]!.cells,
      rows: rows
        .slice(headerRow + 1)
        .map((r) => r.cells)
        .slice(0, MAX_PAGE_ROWS),
    });
  }
  return tables;
}

const GUESS: Record<PublicPageField, RegExp> = {
  type: /^(call ?type|incident ?type|type|nature|nature of call|description|incident|call|event type)$/i,
  address: /^(address|location|street|incident address|addr|block)$/i,
  time: /^(time|date|date\/time|received|dispatched|reported|call time|time received|created|opened)$/i,
  units: /^(units?|apparatus|assigned|units assigned|responding)$/i,
  town: /^(town|city|municipality|jurisdiction|community|area|district|twp|township)$/i,
  status: /^(status|state|disposition)$/i,
  id: /^(id|incident ?(#|no\.?|number|id)|event ?(#|no\.?|number|id)|call ?(#|no\.?|number|id)|number|#)$/i,
  cross: /^(cross ?streets?|nearest intersection|intersection|cross)$/i,
  alarm: /^(alarm ?level|alarms?)$/i,
};

/** Column index per field, from the admin's mapping or, where blank, guessed from the headers. */
export function resolveColumns(
  headers: readonly string[],
  mapping: Partial<Record<PublicPageField, string>> = {},
): Partial<Record<PublicPageField, number>> {
  const out: Partial<Record<PublicPageField, number>> = {};
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  for (const f of PUBLIC_PAGE_FIELDS) {
    const want = mapping[f]?.trim();
    if (want) {
      if (/^\d{1,2}$/.test(want)) {
        const i = Number(want) - 1;
        if (i >= 0 && i < Math.max(headers.length, 50)) out[f] = i;
        continue;
      }
      const exact = headers.findIndex((h) => norm(h) === norm(want));
      const partial = exact >= 0 ? exact : headers.findIndex((h) => norm(h).includes(norm(want)));
      if (partial >= 0) out[f] = partial;
      continue;
    }
    const guessed = headers.findIndex((h) => GUESS[f].test(h.trim()));
    if (guessed >= 0) out[f] = guessed;
  }
  return out;
}

export function rowsFromTable(
  table: HtmlTable,
  mapping?: Partial<Record<PublicPageField, string>>,
): PageRow[] {
  const cols = resolveColumns(table.headers, mapping);
  const at = (cells: string[], f: PublicPageField) => {
    const i = cols[f];
    const v = i == null ? null : (cells[i] ?? null);
    return v && v.trim() ? v.trim() : null;
  };
  return table.rows.map((cells) => ({
    type: at(cells, "type"),
    address: at(cells, "address"),
    time: at(cells, "time"),
    units: at(cells, "units"),
    town: at(cells, "town"),
    status: at(cells, "status"),
    id: at(cells, "id"),
    cross: at(cells, "cross"),
    alarm: at(cells, "alarm"),
    lat: null,
    lon: null,
    details: table.headers
      .map((h, i): [string, string] => [h.trim().slice(0, 60), (cells[i] ?? "").trim().slice(0, 300)])
      .filter(([h, v]) => h && v)
      .slice(0, MAX_DETAILS),
  }));
}

/* ------------------------------------------------------------------ */
/*  JSON                                                                */
/* ------------------------------------------------------------------ */

/** "data.items", "features[0].properties.address", "" (the value itself). */
export function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (m[1]) cur = (cur as Record<string, unknown>)[m[1]];
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(idx[1])];
    }
  }
  return cur;
}

const MAX_DETAILS = 30;

/** The record's own fields as label/value pairs: scalars as written, a units map as its names. */
export function recordDetails(item: unknown): [string, string][] {
  const o = item as { type?: unknown; properties?: unknown } | null;
  const rec =
    o && o.type === "Feature" && o.properties && typeof o.properties === "object"
      ? o.properties
      : item;
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return [];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(rec as Record<string, unknown>)) {
    if (out.length >= MAX_DETAILS) break;
    if (/^(lat|latitude|lon|lng|long|longitude|x|y|geometry)$/i.test(k)) continue;
    let val: string | null = null;
    if (v == null) val = null;
    else if (Array.isArray(v)) val = v.filter((x) => typeof x !== "object").map(String).join(", ");
    else if (typeof v === "object") {
      // {"FD22": "VALLEY COTTAGE FD", "22-100": "22-100"}: the names, once each.
      const names = Object.entries(v as Record<string, unknown>).map(([kk, vv]) =>
        typeof vv === "string" || typeof vv === "number" ? String(vv) : kk,
      );
      val = [...new Set(names)].join(", ");
    } else val = String(v);
    val = val?.trim() ?? "";
    if (val) out.push([k.slice(0, 60), val.slice(0, 300)]);
  }
  return out;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(", ") : null;
  if (typeof v === "object") {
    // Rockland's Units are {"FD08": "NANUET FD", "6-1": "6-1"}: the unit ids.
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length ? keys.join(", ") : null;
  }
  const s = String(v).trim();
  return s ? s : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

const JSON_GUESS: Record<PublicPageField | "lat" | "lon", string[]> = {
  type: [
    "type",
    "callType",
    "call_type",
    "incidentType",
    "incident_type",
    "nature",
    "description",
    "properties.type",
    "properties.callType",
  ],
  address: [
    "address",
    "addr",
    "location",
    "street",
    "incidentAddress",
    "properties.address",
    "properties.location",
  ],
  time: [
    "time",
    "date",
    "received",
    "dispatched",
    "reported",
    "callTime",
    "call_time",
    "created",
    "properties.time",
    "properties.date",
  ],
  units: ["units", "apparatus", "assigned", "properties.units"],
  town: ["town", "city", "municipality", "jurisdiction", "properties.town", "properties.city"],
  status: ["status", "properties.status"],
  id: ["id", "incidentId", "incident_id", "eventId", "event_id", "number", "properties.id"],
  cross: ["crossStreet", "cross_street", "intersection", "properties.crossStreet"],
  alarm: ["alarm", "alarmLevel", "alarm_level", "properties.alarmLevel"],
  lat: ["lat", "latitude", "y", "geometry.coordinates[1]", "properties.lat"],
  lon: ["lon", "lng", "long", "longitude", "x", "geometry.coordinates[0]", "properties.lon"],
};

/** The list of calls in a JSON document: the configured path, a GeoJSON FeatureCollection, or a top-level array. */
export function jsonItems(doc: unknown, itemsPath?: string): unknown[] {
  const at = getPath(doc, itemsPath);
  if (Array.isArray(at)) return at.slice(0, MAX_PAGE_ROWS);
  if (!itemsPath && at && typeof at === "object") {
    const o = at as Record<string, unknown>;
    if (o.type === "FeatureCollection" && Array.isArray(o.features))
      return o.features.slice(0, MAX_PAGE_ROWS);
    for (const k of ["items", "incidents", "calls", "data", "results", "features"]) {
      if (Array.isArray(o[k])) return (o[k] as unknown[]).slice(0, MAX_PAGE_ROWS);
    }
  }
  return [];
}

export function rowsFromJson(
  doc: unknown,
  cfg: NonNullable<PublicPageConfig["json"]> = {},
): PageRow[] {
  const fields = cfg.fields ?? {};
  const pick = (item: unknown, f: keyof typeof JSON_GUESS): unknown => {
    const configured = (fields as Record<string, string | undefined>)[f];
    if (configured) return getPath(item, configured);
    // A GeoJSON Feature keeps its columns in `properties`, and its own `type`
    // is the word "Feature" — so a guess looks there first.
    const o = item as { type?: unknown; properties?: unknown } | null;
    const scopes =
      o && o.type === "Feature" && o.properties && typeof o.properties === "object"
        ? [o.properties, item]
        : [item];
    for (const scope of scopes) {
      for (const p of JSON_GUESS[f]) {
        const v = getPath(scope, p);
        if (v != null && v !== "" && !(scope === item && scopes.length > 1 && p === "type"))
          return v;
      }
    }
    return undefined;
  };
  return jsonItems(doc, cfg.items_path).map((item) => {
    const lat = num(pick(item, "lat"));
    const lon = num(pick(item, "lon"));
    const okPoint =
      lat != null &&
      lon != null &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      !(lat === 0 && lon === 0);
    return {
      type: str(pick(item, "type")),
      address: str(pick(item, "address")),
      time: str(pick(item, "time")),
      units: str(pick(item, "units")),
      town: str(pick(item, "town")),
      status: str(pick(item, "status")),
      id: str(pick(item, "id")),
      cross: str(pick(item, "cross")),
      alarm: str(pick(item, "alarm")),
      lat: okPoint ? lat : null,
      lon: okPoint ? lon : null,
      details: recordDetails(item),
    };
  });
}

/* ------------------------------------------------------------------ */
/*  Times                                                               */
/* ------------------------------------------------------------------ */

/** Minutes the zone is ahead of UTC at that instant (New York in October: -240). */
function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - utcMs) / 60_000);
}

/** A wall-clock time in `timeZone`, as an instant. */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - zoneOffsetMinutes(guess, timeZone) * 60_000;
  t = guess - zoneOffsetMinutes(t, timeZone) * 60_000;
  return new Date(t);
}

function localDate(now: Date, timeZone: string): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), mo: get("month"), d: get("day") };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * The time a page printed, as ISO. Understands ISO with a zone, epoch
 * seconds or milliseconds, "10/11/2026 5:09 PM", "2026-10-11 17:09", a bare
 * "17:09" (today, or yesterday when today's would be in the future),
 * Rockland's time-first "18:28:00 10/11/2026" and LAFD's "Sunday, October
 * 11, 2026 - 07:40". A time with no zone is read in `timeZone` — never in
 * the server's own zone, which on a Worker is UTC. Null when it cannot tell;
 * the pipeline then uses the time it saw the row.
 */
export function parsePageTime(
  raw: string | null,
  now: Date,
  timeZone = DEFAULT_TIMEZONE,
): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{10}(\d{3})?$/.test(s)) {
    const n = Number(s);
    return new Date(s.length === 10 ? n * 1000 : n).toISOString();
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const hm = (h: string, m: string, sec: string | undefined, ap: string | undefined) => {
    let hour = Number(h);
    if (ap) {
      const pm = /p/i.test(ap);
      if (hour === 12) hour = pm ? 12 : 0;
      else if (pm) hour += 12;
    }
    return { h: hour, mi: Number(m), s: Number(sec ?? 0) };
  };
  let m =
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/.exec(
      s,
    );
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const t = hm(m[4]!, m[5]!, m[6], m[7]);
    return zonedToUtc(y, Number(m[1]), Number(m[2]), t.h, t.mi, t.s, timeZone).toISOString();
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    return zonedToUtc(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? 0),
      timeZone,
    ).toISOString();
  }
  m =
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(
      s,
    );
  if (m) {
    const y = m[7]!.length === 2 ? 2000 + Number(m[7]) : Number(m[7]);
    const t = hm(m[1]!, m[2]!, m[3], m[4]);
    return zonedToUtc(y, Number(m[5]), Number(m[6]), t.h, t.mi, t.s, timeZone).toISOString();
  }
  m =
    /^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s*[-,@]\s*|\s+at\s+|\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/.exec(
      s,
    );
  if (m && MONTHS[m[1]!.slice(0, 3).toLowerCase()]) {
    const t = hm(m[4]!, m[5]!, m[6], m[7]);
    return zonedToUtc(
      Number(m[3]),
      MONTHS[m[1]!.slice(0, 3).toLowerCase()]!,
      Number(m[2]),
      t.h,
      t.mi,
      t.s,
      timeZone,
    ).toISOString();
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/.exec(s);
  if (m) {
    const t = hm(m[1]!, m[2]!, m[3], m[4]);
    const { y, mo, d } = localDate(now, timeZone);
    let at = zonedToUtc(y, mo, d, t.h, t.mi, t.s, timeZone);
    if (at.getTime() > now.getTime() + 3_600_000) at = new Date(at.getTime() - 86_400_000);
    return at.toISOString();
  }
  // Anything else only when it names its own zone; a zone-less string handed
  // to Date.parse would be read in the server's zone, which is wrong here.
  if (!/(GMT|UTC|Z|[+-]\d{2}:?\d{2}|\b[ECMP][SD]T)$/i.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/* ------------------------------------------------------------------ */
/*  Rows to feed items                                                  */
/* ------------------------------------------------------------------ */

/** "E1, L2, R3" → 3; "4" → 4. */
export function unitCount(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim();
  if (/^\d{1,3}$/.test(s)) return Number(s);
  const parts = s
    .split(/[,;/]+|\s{2,}|\s+(?=[A-Z]{1,4}-?\d)/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 && parts.length < 100 ? parts.length : null;
}

const FIRE_ROW =
  /\b(fire|smoke|burn\w*|flames?|explosion|structure|alarm|odor of smoke|working fire|2nd alarm|3rd alarm)\b/i;

export function isFireRow(r: PageRow): boolean {
  return FIRE_ROW.test(`${r.type ?? ""} ${r.status ?? ""}`);
}

/** True when the row's status is one the admin asked to drop ("Completed", "Closed"). */
export function hasExcludedStatus(r: PageRow, excluded: readonly string[] | undefined): boolean {
  if (!excluded?.length || !r.status) return false;
  const s = r.status.trim().toLowerCase();
  return excluded.some((x) => x.trim().toLowerCase() === s);
}

/** "WESLEY HILLS, NY 10952" → "WESLEY HILLS": the town, without the state and ZIP a page appends. */
export function townOnly(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw
    .replace(/,?\s*[A-Z]{2}\s*\d{5}(-\d{4})?\s*$/, "")
    .replace(/,\s*[A-Z]{2}\s*$/, "")
    .trim();
  return t || null;
}

/** "BLK MAIN ST" → "MAIN ST": Houston writes "block of" in front of its cross streets. */
function crossOnly(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.replace(/^(BLK|BLOCK OF|BLOCK)\s+/i, "").trim();
  return t || null;
}

/** 32-bit FNV-1a as 8 hex characters — a stable key for a row without its own number. */
function fnv32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function itemFromRow(
  r: PageRow,
  ctx: {
    sourceId: string;
    areaId: string | null;
    host: string;
    pageUrl: string;
    label: string;
    now: Date;
    timeZone: string;
  },
): RawItem | null {
  if (!r.type && !r.address) return null;
  const publishedAt = parsePageTime(r.time, ctx.now, ctx.timeZone);
  // The center's own incident number when the page shows one; otherwise the
  // row's type, address and time, which together do not repeat.
  const identity = r.id
    ? `id:${r.id}`
    : `row:${fnv32(`${r.type}|${r.address}|${r.time}|${r.town}`)}`;
  const town = townOnly(r.town);
  const cross = crossOnly(r.cross);
  // A street with no house number is only placeable with its cross street
  // ("STUDEWOOD ST & E 11TH ST"); a numbered address stands on its own.
  const numbered = Boolean(r.address && /^\d/.test(r.address.trim()));
  // Rockland writes an intersection call's address as "ROOSEVELT AV &
  // OSTEREH BLVD" already; its "Nearest Intersection" would only repeat it.
  const isIntersection = Boolean(r.address && /\s(&|and|\/)\s/i.test(r.address));
  const useCross = Boolean(r.address && !numbered && !isIntersection && cross);
  const street = useCross ? `${r.address} & ${cross}` : r.address;
  const where = [street, town].filter(Boolean).join(", ");
  return {
    key: `pp:${ctx.host}:${identity}`,
    sourceKind: "public_page",
    sourceId: ctx.sourceId,
    title: [r.type ?? "Incident", where ? `at ${where}` : null].filter(Boolean).join(" "),
    url: ctx.pageUrl,
    publisher: ctx.label,
    publishedAt,
    text: [r.status ? `Status: ${r.status}.` : null, r.units ? `Units: ${r.units}.` : null]
      .filter(Boolean)
      .join(" "),
    areaId: ctx.areaId,
    areaPinned: ctx.areaId != null,
    point: r.lat != null && r.lon != null ? { lat: r.lat, lon: r.lon } : null,
    details: r.details?.length ? r.details : undefined,
    structured: {
      incidentType: r.type,
      address: numbered ? r.address : null,
      locality: town,
      units: unitCount(r.units),
      status: r.status,
      // A street without a number is placed approximately: with its cross
      // street, or as the page wrote it (an intersection, a bare street).
      crossStreet: numbered ? null : useCross ? street : (r.address ?? cross ?? null),
      alarmLevel: r.alarm ?? null,
    },
  };
}

/** Hosts that are government by their name. Anything else needs the admin's confirmation. */
export function isGovernmentHost(host: string): boolean {
  const h = host.toLowerCase();
  // .gov / .mil, and US locality domains such as co.ocean.nj.us or
  // twp.lakewood.nj.us (the .us state subdomains are reserved for
  // government and schools).
  return /\.(gov|mil)$/.test(h) || /\.[a-z]{2}\.us$/.test(h);
}

/** Pages that want a person, not a reader: a login form or a CAPTCHA. */
export function looksGated(html: string): string | null {
  if (/<input[^>]+type\s*=\s*["']?password/i.test(html))
    return "This page asks for a login — only public pages can be read.";
  if (/g-recaptcha|h-captcha|hcaptcha|cf-turnstile|cf-challenge|captcha/i.test(html)) {
    return "This page shows a CAPTCHA or bot check — the feed does not get past those.";
  }
  return null;
}
