/**
 * The admin side of the fire feed: Settings › Sales › Fire feed.
 *
 * Reads and writes go through the signed-in admin's own client, so RLS
 * (is_privileged, migration 20261011140000) decides — this file adds no
 * access of its own. Until that migration is applied every read answers
 * `migrated: false` and the screen says so instead of failing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { checkPublicUrl } from "@/lib/public-url";
import { isMissingSchema } from "@/lib/schema-fallback";

import {
  FIRE_FEED_SETTINGS_KEY,
  parseFireFeedConfig,
  withFireFeedConfig,
  type FireFeedConfig,
} from "./settings";
import type { FireSourceKind, WatchArea } from "./types";

/* Not in the generated types until Lovable regenerates them after
   migration 20261011140000 is applied. */
const db = () => supabase as unknown as SupabaseClient;

export interface AdminSource {
  id: string;
  kind: FireSourceKind;
  label: string;
  url: string | null;
  config: Record<string, unknown>;
  area_id: string | null;
  poll_minutes: number;
  enabled: boolean;
  last_fetched_at: string | null;
  last_status: number | null;
  last_error: string | null;
}

export interface AdminRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  trigger: "cron" | "manual";
  dry_run: boolean;
  status: "running" | "ok" | "partial" | "failed";
  fetched: Record<
    string,
    { label: string; kind: string; items: number; error: string | null; notes?: string[] }
  >;
  new_items: number;
  leads_created: number;
  merged: number;
  skipped: Record<string, number>;
  deferred: number;
  errors: string[];
  extractor: { ai_calls?: number; ai_items?: number; ai_error?: string | null };
}

export interface AdminItem {
  id: string;
  created_at: string;
  source_kind: FireSourceKind;
  title: string | null;
  url: string | null;
  publisher: string | null;
  published_at: string | null;
  decision: "lead" | "merged" | "skipped";
  reason: string | null;
  incident_id: string | null;
  extracted_by: "ai" | "rules" | null;
  area_id: string | null;
  /** What the feed read from the call — for the details pop-up (4 Nov). */
  extraction?: Record<string, unknown> | null;
}

export type FireFeedAdmin =
  | { migrated: false }
  | {
      migrated: true;
      config: FireFeedConfig;
      rawConfig: unknown;
      areas: WatchArea[];
      sources: AdminSource[];
      runs: AdminRun[];
      items: AdminItem[];
    };

export async function loadFireFeedAdmin(): Promise<FireFeedAdmin> {
  const [settings, areas, sources, runs, items] = await Promise.all([
    db().from("app_settings").select("value").eq("key", FIRE_FEED_SETTINGS_KEY).maybeSingle(),
    db().from("fire_feed_areas").select("*").order("label"),
    db()
      .from("fire_feed_sources")
      .select(
        "id, kind, label, url, config, area_id, poll_minutes, enabled, last_fetched_at, last_status, last_error",
      )
      .order("created_at"),
    db().from("fire_feed_runs").select("*").order("started_at", { ascending: false }).limit(12),
    db()
      .from("fire_feed_items")
      .select(
        "id, created_at, source_kind, title, url, publisher, published_at, decision, reason, incident_id, extracted_by, area_id, extraction",
      )
      .order("created_at", { ascending: false })
      .limit(80),
  ]);
  for (const r of [areas, sources, runs, items]) {
    if (r.error) {
      if (isMissingSchema(r.error)) return { migrated: false };
      throw r.error;
    }
  }
  return {
    migrated: true,
    config: parseFireFeedConfig(settings.data?.value),
    rawConfig: settings.data?.value ?? null,
    areas: ((areas.data ?? []) as Record<string, unknown>[]).map((a) => ({
      id: String(a.id),
      label: String(a.label),
      locality: (a.locality as string | null) ?? null,
      county: (a.county as string | null) ?? null,
      state: String(a.state),
      postal_codes: (a.postal_codes as string[]) ?? [],
      center_lat: a.center_lat == null ? null : Number(a.center_lat),
      center_lon: a.center_lon == null ? null : Number(a.center_lon),
      radius_miles: Number(a.radius_miles),
      active: Boolean(a.active),
    })),
    sources: (sources.data ?? []) as AdminSource[],
    runs: (runs.data ?? []) as AdminRun[],
    items: (items.data ?? []) as AdminItem[],
  };
}

/* ---- the switch ----------------------------------------------------------- */

export async function saveFireFeedConfig(
  current: unknown,
  patch: Parameters<typeof withFireFeedConfig>[1],
): Promise<void> {
  const value = withFireFeedConfig(current, patch);
  const { error } = await db()
    .from("app_settings")
    .upsert({ key: FIRE_FEED_SETTINGS_KEY, value }, { onConflict: "key" });
  if (error) throw error;
}

/* ---- areas ----------------------------------------------------------------- */

/** "08701, 08527 08753" → ["08701","08527","08753"]; anything that is not five digits is an error. */
export function parseZipList(raw: string): string[] {
  const parts = raw
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const bad = parts.filter((p) => !/^\d{5}$/.test(p));
  if (bad.length)
    throw new Error(`ZIP codes are five digits — check ${bad.slice(0, 3).join(", ")}.`);
  return [...new Set(parts)];
}

export function normaliseState(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) throw new Error("State is the two-letter abbreviation (NJ, NY).");
  return s;
}

export interface AreaInput {
  locality: string;
  county: string;
  state: string;
  zips: string;
  radius: string;
}

/** The row an add form produces, checked the way the table's CHECKs will check it. */
export function areaRowFromInput(input: AreaInput) {
  const locality = input.locality.trim() || null;
  const county = input.county.trim().replace(/\s+county$/i, "") || null;
  if (!locality && !county) throw new Error("Give the area a town or a county to search for.");
  const state = normaliseState(input.state);
  const radius = input.radius.trim() ? Number(input.radius) : 15;
  if (!Number.isFinite(radius) || radius <= 0 || radius > 100)
    throw new Error("Radius is between 1 and 100 miles.");
  return {
    label: `${locality ?? `${county} County`}, ${state}`,
    locality,
    county,
    state,
    postal_codes: parseZipList(input.zips),
    radius_miles: radius,
  };
}

export async function addArea(input: AreaInput): Promise<void> {
  const { error } = await db().from("fire_feed_areas").insert(areaRowFromInput(input));
  if (error) throw error;
}

export async function updateArea(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("fire_feed_areas").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteArea(id: string): Promise<void> {
  const { error } = await db().from("fire_feed_areas").delete().eq("id", id);
  if (error) throw error;
}

/* ---- sources --------------------------------------------------------------- */

export function normaliseFeedUrl(raw: string): string {
  const check = checkPublicUrl(raw);
  if (!check.ok) {
    throw new Error(
      check.reason === "Not a web address"
        ? "That is not a web address. Paste the feed's full URL, starting https://"
        : `${check.reason}.`,
    );
  }
  return check.url.toString();
}

export async function addRssFeed(input: {
  label: string;
  url: string;
  poll: string;
  publisher: string;
}): Promise<void> {
  const label = input.label.trim();
  if (!label) throw new Error("Give the feed a name (the fire department or paper).");
  const poll = input.poll.trim() ? Math.round(Number(input.poll)) : 10;
  if (!Number.isFinite(poll) || poll < 2 || poll > 1440)
    throw new Error("Check every 2 to 1440 minutes.");
  const { error } = await db()
    .from("fire_feed_sources")
    .insert({
      kind: "rss",
      label,
      url: normaliseFeedUrl(input.url),
      poll_minutes: poll,
      config: input.publisher.trim() ? { publisher: input.publisher.trim() } : {},
    });
  if (error) {
    if ((error as { code?: string }).code === "23505")
      throw new Error("That feed is already on the list.");
    throw error;
  }
}

export async function updateSource(
  id: string,
  patch: Partial<Pick<AdminSource, "label" | "enabled" | "poll_minutes" | "area_id">>,
): Promise<void> {
  const { error } = await db().from("fire_feed_sources").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteSource(id: string): Promise<void> {
  const { error } = await db().from("fire_feed_sources").delete().eq("id", id);
  if (error) throw error;
}
