/**
 * One run of the fire feed: fetch every due source, read what is new, and
 * land structure fires in the chase deck through `ingestIncident` — the same
 * insert the BNN webhook uses.
 *
 * Called by the pg_cron hook (/api/public/hooks/fire-feed, every two minutes
 * when something is due) and by "Run now" on Settings › Sales › Fire feed.
 * Every decision is made in decide.ts; this file only does the I/O around it,
 * in an order that keeps a bad minute cheap:
 *
 *  - nothing is due → no run row, no request (the kick usually stops this
 *    before the hook is even called);
 *  - a source that fails is logged on its row and in the run, and the other
 *    sources carry on;
 *  - an item seen before is skipped by its key before any reading, model call
 *    or geocode is spent on it;
 *  - a geocoder or insert failure leaves the item OUT of the ledger, so the
 *    next run tries it again; a decision (lead, merge, skip) is written to the
 *    ledger so it is never made twice.
 *
 * A DRY run (Run now while the feed is switched off) does all the reading and
 * deciding and writes nothing but its own run row — the way to see what the
 * feed would do before it is allowed to do it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { incidentPayloadSchema } from "@/lib/incident-payload";
import { isMissingSchema } from "@/lib/schema-fallback";

import { areaPlaceName } from "./areas";
import {
  candidateFromLead,
  findMatch,
  leadPayload,
  mergePatch,
  place,
  postalCodeOf,
  sightingOfItem,
  SKIP_REASON_LABEL,
  triage,
  type CandidateIncident,
  type Geocoded,
  type SkipReason,
} from "./decide";
import { DEDUPE_RULES, ledgerKey } from "./dedupe";
import type { Extraction } from "./extract";
import type { ExtractionOutcome } from "./extract-ai.server";
import { FIRE_FEED_SETTINGS_KEY, parseFireFeedConfig } from "./settings";
import type { FireSource, RawItem, SourceRow, WatchArea } from "./types";

/** New items read per run; the rest wait for the next run (they are not in the ledger yet). */
export const MAX_NEW_ITEMS_PER_RUN = 150;
/** Geocoder calls per run. The OpenStreetMap fallbacks ask for one a second. */
export const MAX_GEOCODES_PER_RUN = 40;
/** How long the ledger remembers an item. Feeds only carry the last day or two. */
export const LEDGER_DAYS = 30;
/**
 * A run row still "running" after this long is taken to have died (cut off by
 * pg_net's 60 s timeout, a worker restart) and no longer blocks a new run.
 * The same window fire_feed_kick() uses.
 */
export const RUNNING_RUN_MINUTES = 5;

export type RunTrigger = "cron" | "manual";

export interface RunDeps {
  /** Service-role client. */
  db: SupabaseClient;
  fetch: typeof fetch;
  now: () => Date;
  geocode: (
    query: string,
  ) => Promise<{ lat: number; lon: number; formatted: string | null } | null>;
  extract: (
    items: readonly RawItem[],
    areas: readonly WatchArea[],
    useAi: boolean,
  ) => Promise<ExtractionOutcome>;
  sourceFor: (kind: string) => FireSource | null;
  ingest: (
    payload: import("@/lib/incident-payload").IncidentPayload,
    extras: import("@/lib/incident-payload").TrustedIncidentExtras,
  ) => Promise<
    { ok: true; incident: { id: string; status: string } | null } | { ok: false; error: string }
  >;
}

export interface ItemDecision {
  key: string;
  title: string;
  url: string | null;
  source_kind: string;
  decision: "lead" | "merged" | "skipped";
  reason: string | null;
  area: string | null;
  incident_id: string | null;
}

export interface RunSummary {
  status: "idle" | "ok" | "partial" | "failed";
  /** Why an idle run did nothing. */
  idleReason?: string;
  runId: string | null;
  dryRun: boolean;
  fetched: Record<
    string,
    { label: string; kind: string; items: number; error: string | null; notes: string[] }
  >;
  newItems: number;
  leads: number;
  merged: number;
  skipped: Record<string, number>;
  deferred: number;
  errors: string[];
  extractor: { ai_calls: number; ai_items: number; ai_error: string | null };
  decisions: ItemDecision[];
}

function emptySummary(dryRun: boolean): RunSummary {
  return {
    status: "idle",
    runId: null,
    dryRun,
    fetched: {},
    newItems: 0,
    leads: 0,
    merged: 0,
    skipped: {},
    deferred: 0,
    errors: [],
    extractor: { ai_calls: 0, ai_items: 0, ai_error: null },
    decisions: [],
  };
}

function isDue(s: SourceRow, now: Date): boolean {
  if (!s.last_fetched_at) return true;
  // Thirty seconds of slack so a two-minute cron tick does not miss a source
  // whose last fetch finished a few seconds after the previous tick.
  return Date.parse(s.last_fetched_at) <= now.getTime() - s.poll_minutes * 60_000 + 30_000;
}

function toArea(r: Record<string, unknown>): WatchArea {
  return {
    id: String(r.id),
    label: String(r.label ?? ""),
    locality: (r.locality as string | null) ?? null,
    county: (r.county as string | null) ?? null,
    state: String(r.state ?? ""),
    postal_codes: Array.isArray(r.postal_codes) ? (r.postal_codes as string[]) : [],
    center_lat: r.center_lat == null ? null : Number(r.center_lat),
    center_lon: r.center_lon == null ? null : Number(r.center_lon),
    radius_miles: Number(r.radius_miles ?? 15),
    active: r.active !== false,
  };
}

function toSource(r: Record<string, unknown>): SourceRow {
  return {
    id: String(r.id),
    kind: r.kind as SourceRow["kind"],
    label: String(r.label ?? ""),
    url: (r.url as string | null) ?? null,
    config: r.config && typeof r.config === "object" ? (r.config as Record<string, unknown>) : {},
    area_id: (r.area_id as string | null) ?? null,
    poll_minutes: Number(r.poll_minutes ?? 15),
    enabled: r.enabled !== false,
    last_fetched_at: (r.last_fetched_at as string | null) ?? null,
    etag: (r.etag as string | null) ?? null,
    last_modified: (r.last_modified as string | null) ?? null,
  };
}

export async function runFireFeed(
  deps: RunDeps,
  opts: { trigger: RunTrigger; triggeredBy?: string | null },
): Promise<RunSummary> {
  const now = deps.now();
  const db = deps.db;

  /* ---- settings, areas, sources ------------------------------------- */
  const settingsRow = await db
    .from("app_settings")
    .select("value")
    .eq("key", FIRE_FEED_SETTINGS_KEY)
    .maybeSingle();
  const config = parseFireFeedConfig(settingsRow.data?.value);
  const dryRun = !config.enabled;
  const summary = emptySummary(dryRun);
  if (dryRun && opts.trigger === "cron")
    return { ...summary, idleReason: "The fire feed is switched off." };

  const areasRes = await db.from("fire_feed_areas").select("*").eq("active", true);
  if (areasRes.error) {
    if (isMissingSchema(areasRes.error)) {
      return {
        ...summary,
        idleReason:
          "The fire feed's tables are not on this database yet (migration 20261011140000).",
      };
    }
    return { ...summary, status: "failed", errors: [areasRes.error.message] };
  }
  const areas = (areasRes.data ?? []).map((r) => toArea(r as Record<string, unknown>));
  if (areas.length === 0) return { ...summary, idleReason: "No watch area is switched on." };

  const sourcesRes = await db.from("fire_feed_sources").select("*").eq("enabled", true);
  if (sourcesRes.error) return { ...summary, status: "failed", errors: [sourcesRes.error.message] };
  const sources = (sourcesRes.data ?? []).map((r) => toSource(r as Record<string, unknown>));
  const due = opts.trigger === "manual" ? sources : sources.filter((s) => isDue(s, now));
  if (due.length === 0) {
    return {
      ...summary,
      idleReason: sources.length ? "No source is due yet." : "No source is switched on.",
    };
  }

  /* ---- one run at a time ---------------------------------------------- */
  // The kick checks this before it calls the hook, but "Run now" does not go
  // through the kick, and two runs side by side would both decide the same
  // new items before either has written its ledger rows.
  const busy = await db
    .from("fire_feed_runs")
    .select("id")
    .eq("status", "running")
    .gte("started_at", new Date(now.getTime() - RUNNING_RUN_MINUTES * 60_000).toISOString())
    .limit(1);
  if (busy.error) return { ...summary, status: "failed", errors: [busy.error.message] };
  if ((busy.data ?? []).length > 0) {
    return {
      ...summary,
      idleReason: "Another run is still going. Try again in a few minutes.",
    };
  }

  /* ---- the run row ---------------------------------------------------- */
  const runIns = await db
    .from("fire_feed_runs")
    .insert({
      trigger: opts.trigger,
      triggered_by: opts.triggeredBy ?? null,
      dry_run: dryRun,
      status: "running",
    })
    .select("id")
    .single();
  if (runIns.error || !runIns.data) {
    return {
      ...summary,
      status: "failed",
      errors: [runIns.error?.message ?? "Could not open a run row"],
    };
  }
  const runId = String((runIns.data as { id: string }).id);
  summary.runId = runId;

  const changedCursors: { source_id: string; query_key: string; cursor: string }[] = [];
  const sourceUpdates = new Map<
    string,
    {
      last_fetched_at: string;
      last_status: number | null;
      last_error: string | null;
      etag?: string | null;
      last_modified?: string | null;
    }
  >();

  try {
    /* ---- fetch ---------------------------------------------------------- */
    const cursorRes = await db
      .from("fire_feed_cursors")
      .select("source_id, query_key, cursor")
      .in(
        "source_id",
        due.map((s) => s.id),
      );
    const cursorRows = (cursorRes.data ?? []) as {
      source_id: string;
      query_key: string;
      cursor: string;
    }[];
    let sourceErrors = 0;

    const all: RawItem[] = [];
    for (const src of due) {
      const adapter = deps.sourceFor(src.kind);
      const entry = {
        label: src.label,
        kind: src.kind,
        items: 0,
        error: null as string | null,
        notes: [] as string[],
      };
      summary.fetched[src.id] = entry;
      if (!adapter) {
        entry.error = `No adapter for "${src.kind}" in this build.`;
        sourceErrors += 1;
        sourceUpdates.set(src.id, {
          last_fetched_at: now.toISOString(),
          last_status: null,
          last_error: entry.error,
        });
        continue;
      }
      const mine = new Map(
        cursorRows.filter((c) => c.source_id === src.id).map((c) => [c.query_key, c.cursor]),
      );
      let result;
      try {
        result = await adapter.fetch({
          source: src,
          areas,
          now,
          fetch: deps.fetch,
          cursors: {
            get: (k) => mine.get(k) ?? null,
            set: (k, v) => {
              mine.set(k, v);
              changedCursors.push({ source_id: src.id, query_key: k, cursor: v });
            },
          },
        });
      } catch (e) {
        result = {
          items: [],
          state: { error: e instanceof Error ? e.message.slice(0, 300) : String(e) },
        };
      }
      entry.items = result.items.length;
      entry.error = result.state.error ?? null;
      entry.notes = (result as { notes?: string[] }).notes ?? [];
      if (entry.error) sourceErrors += 1;
      all.push(...result.items);
      sourceUpdates.set(src.id, {
        last_fetched_at: now.toISOString(),
        last_status: result.state.status ?? null,
        last_error: entry.error,
        etag: result.state.etag,
        last_modified: result.state.lastModified,
      });
    }
    /* ---- what is new ---------------------------------------------------- */
    const byKey = new Map<string, RawItem>();
    for (const raw of all) {
      const it = { ...raw, key: ledgerKey(raw.key) };
      if (!byKey.has(it.key)) byKey.set(it.key, it);
    }
    const keys = [...byKey.keys()];
    const seen = new Set<string>();
    for (let i = 0; i < keys.length; i += 200) {
      const slice = keys.slice(i, i + 200);
      const r = await db.from("fire_feed_items").select("item_key").in("item_key", slice);
      if (r.error) throw new Error(`ledger lookup: ${r.error.message}`);
      for (const row of (r.data ?? []) as { item_key: string }[]) seen.add(row.item_key);
    }
    if (seen.size) summary.skipped.already_seen = seen.size;
    // Oldest first, so the first report of a fire becomes the lead and the
    // later ones merge onto it.
    const fresh = [...byKey.values()]
      .filter((it) => !seen.has(it.key))
      .sort((a, b) => (a.publishedAt ?? "").localeCompare(b.publishedAt ?? ""));
    const todo = fresh.slice(0, MAX_NEW_ITEMS_PER_RUN);
    summary.deferred = fresh.length - todo.length;
    summary.newItems = todo.length;

    /* ---- read ------------------------------------------------------------ */
    const read = todo.length
      ? await deps.extract(todo, areas, config.useAi)
      : { extractions: [] as Extraction[], aiCalls: 0, aiItems: 0, aiError: null };
    summary.extractor = { ai_calls: read.aiCalls, ai_items: read.aiItems, ai_error: read.aiError };

    /* ---- what is already on file ---------------------------------------- */
    const windowStart = new Date(
      now.getTime() - (DEDUPE_RULES.addressHours + 24) * 3_600_000,
    ).toISOString();
    const candRes = await db
      .from("incidents")
      .select(
        "id, source, address, locality, postal_code, lat, lon, reported_at, needs_review, review_reason, source_links",
      )
      .gte("reported_at", windowStart)
      .is("duplicate_of", null)
      .order("reported_at", { ascending: true })
      .limit(1500);
    if (candRes.error) throw new Error(`incident lookup: ${candRes.error.message}`);
    const candidates: CandidateIncident[] = ((candRes.data ?? []) as Record<string, unknown>[]).map(
      (r) => ({
        id: String(r.id),
        source: String(r.source ?? ""),
        address: (r.address as string | null) ?? null,
        locality: (r.locality as string | null) ?? null,
        postal_code: (r.postal_code as string | null) ?? null,
        lat: r.lat == null ? null : Number(r.lat),
        lon: r.lon == null ? null : Number(r.lon),
        reported_at: String(r.reported_at),
        needs_review: r.needs_review === true,
        review_reason: (r.review_reason as string | null) ?? null,
        source_links: Array.isArray(r.source_links)
          ? (r.source_links as CandidateIncident["source_links"])
          : [],
      }),
    );

    /* ---- decide ----------------------------------------------------------- */
    // Skips are written in one batch at the end: a skip that is lost when a run
    // is cut off is simply decided again next time. A lead or a merge is
    // written the moment its incident is, so a run cut off after the insert
    // (pg_net gives the hook 60 s) cannot leave an incident with no ledger row
    // for the next run to create again.
    const ledger: Record<string, unknown>[] = [];
    const writeNow = async (row: Record<string, unknown>) => {
      if (dryRun) return;
      const r = await db
        .from("fire_feed_items")
        .upsert([row], { onConflict: "item_key", ignoreDuplicates: true });
      if (r.error) summary.errors.push(`Ledger write: ${r.error.message}`);
    };
    let geocodes = 0;
    const record = async (
      it: RawItem,
      ex: Extraction | null,
      decision: ItemDecision["decision"],
      reason: string | null,
      areaId: string | null,
      areaName: string | null,
      incidentId: string | null,
    ) => {
      if (decision === "skipped" && reason)
        summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
      summary.decisions.push({
        key: it.key,
        title: it.title,
        url: it.url,
        source_kind: it.sourceKind,
        decision,
        reason,
        area: areaName,
        incident_id: incidentId,
      });
      const row = {
        item_key: it.key,
        source_id: it.sourceId,
        source_kind: it.sourceKind,
        run_id: runId,
        title: it.title.slice(0, 300),
        url: it.url?.slice(0, 2000) ?? null,
        publisher: it.publisher?.slice(0, 120) ?? null,
        published_at: it.publishedAt,
        area_id: areaId,
        decision,
        reason,
        incident_id: incidentId,
        // The source's own fields ride along for the call's details pop-up.
        extraction: it.details?.length ? { ...(ex ?? {}), sourceDetails: it.details } : ex,
        extracted_by: ex?.method ?? null,
      };
      if (decision === "skipped") ledger.push(row);
      else await writeNow(row);
    };

    for (let i = 0; i < todo.length; i++) {
      const it = todo[i]!;
      const ex = read.extractions[i]!;
      const t = triage(it, ex, areas, now, config);
      if ("skip" in t) {
        await record(it, ex, "skipped", t.skip, null, null, null);
        continue;
      }
      const plan = t.locate;

      let geo: Geocoded | null = null;
      if (plan.query) {
        if (geocodes >= MAX_GEOCODES_PER_RUN) {
          summary.deferred += 1;
          continue;
        }
        geocodes += 1;
        try {
          const hit = await deps.geocode(plan.query);
          if (hit)
            geo = {
              lat: hit.lat,
              lon: hit.lon,
              postalCode: postalCodeOf(hit.formatted),
              formatted: hit.formatted,
            };
        } catch (e) {
          // An outage, not an answer: leave the item out of the ledger so the
          // next run asks again.
          summary.errors.push(
            `Geocoding "${plan.query}": ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
          );
          continue;
        }
      }
      if (plan.point) {
        geo = {
          lat: plan.point.lat,
          lon: plan.point.lon,
          postalCode: geo?.postalCode ?? null,
          formatted: geo?.formatted ?? null,
        };
      }
      if (!geo) {
        await record(it, ex, "skipped", "not_found", null, null, null);
        continue;
      }

      const where = place(plan, geo, areas, it.areaId);
      if (!where) {
        await record(it, ex, "skipped", "outside_areas", null, null, null);
        continue;
      }
      const areaName = areaPlaceName(where.area);

      const match = findMatch(sightingOfItem(it, plan, geo, now), candidates);
      if (match) {
        const patch = mergePatch(match.incident, it, plan, geo);
        if (patch && !dryRun) {
          const up = await db.from("incidents").update(patch).eq("id", match.incident.id);
          if (up.error) {
            summary.errors.push(`Merging into ${match.incident.id}: ${up.error.message}`);
            continue;
          }
        }
        if (patch?.source_links)
          match.incident.source_links = patch.source_links as CandidateIncident["source_links"];
        if (patch?.address) match.incident.address = patch.address as string;
        summary.merged += 1;
        await record(it, ex, "merged", match.reason, where.area.id, areaName, match.incident.id);
        continue;
      }

      const { payload, extras } = leadPayload(it, ex, plan, geo, where, now);
      const valid = incidentPayloadSchema.safeParse(payload);
      if (!valid.success) {
        summary.errors.push(
          `"${it.title.slice(0, 80)}": ${valid.error.issues[0]?.message ?? "invalid payload"}`,
        );
        continue;
      }
      if (dryRun) {
        summary.leads += 1;
        await record(it, ex, "lead", null, where.area.id, areaName, null);
        candidates.push(candidateFromLead(`dry-${i}`, valid.data, extras));
        continue;
      }
      const ins = await deps.ingest(valid.data, extras);
      if (!ins.ok || !ins.incident) {
        summary.errors.push(
          `Inserting "${it.title.slice(0, 80)}": ${ins.ok ? "no row returned" : ins.error}`,
        );
        continue;
      }
      if (ins.incident.status === "discarded") {
        // The database's own same-address rule caught it (incidents_classify).
        summary.merged += 1;
        await record(
          it,
          ex,
          "merged",
          "database_duplicate",
          where.area.id,
          areaName,
          ins.incident.id,
        );
        continue;
      }
      summary.leads += 1;
      await record(it, ex, "lead", null, where.area.id, areaName, ins.incident.id);
      candidates.push(candidateFromLead(ins.incident.id, valid.data, extras));
    }

    /* ---- remember the skips, prune, close --------------------------------- */
    if (!dryRun && ledger.length) {
      for (let i = 0; i < ledger.length; i += 200) {
        const r = await db
          .from("fire_feed_items")
          .upsert(ledger.slice(i, i + 200), { onConflict: "item_key", ignoreDuplicates: true });
        if (r.error) summary.errors.push(`Ledger write: ${r.error.message}`);
      }
    }
    if (!dryRun) {
      const cutoff = new Date(now.getTime() - LEDGER_DAYS * 86_400_000).toISOString();
      await db.from("fire_feed_items").delete().lt("created_at", cutoff);
      await db.from("fire_feed_runs").delete().lt("started_at", cutoff);
    }

    summary.status =
      summary.errors.length || sourceErrors
        ? sourceErrors === due.length && !summary.newItems
          ? "failed"
          : "partial"
        : "ok";
  } catch (e) {
    summary.status = "failed";
    summary.errors.push(e instanceof Error ? e.message : String(e));
  }

  // Validators (ETag / Last-Modified, and the per-query cursors that hold
  // them) are kept only when every new item was decided. Otherwise the next
  // fetch could come back 304 and the items this run put off — the cap, a
  // geocoder outage, a failed run — would never be seen again. The fetch
  // time and error are written either way, so the schedule and the admin
  // screen stay honest.
  const keepValidators =
    !dryRun && summary.status !== "failed" && summary.deferred === 0 && summary.errors.length === 0;
  for (const [id, u] of sourceUpdates) {
    const { etag, last_modified, ...rest } = u;
    const patch = keepValidators
      ? {
          ...rest,
          ...(etag !== undefined ? { etag } : {}),
          ...(last_modified !== undefined ? { last_modified } : {}),
        }
      : rest;
    await db.from("fire_feed_sources").update(patch).eq("id", id);
  }
  if (changedCursors.length && keepValidators) {
    const last = new Map(changedCursors.map((c) => [`${c.source_id}|${c.query_key}`, c]));
    await db.from("fire_feed_cursors").upsert(
      [...last.values()].map((c) => ({ ...c, updated_at: now.toISOString() })),
      { onConflict: "source_id,query_key" },
    );
  }

  await db
    .from("fire_feed_runs")
    .update({
      finished_at: deps.now().toISOString(),
      status: summary.status,
      fetched: summary.fetched,
      new_items: summary.newItems,
      leads_created: summary.leads,
      merged: summary.merged,
      skipped: summary.skipped,
      deferred: summary.deferred,
      errors: summary.errors.slice(0, 50),
      extractor: summary.extractor,
      // A dry run's decisions are its only record (it writes no ledger).
      decisions: dryRun ? summary.decisions.slice(0, 200) : null,
    })
    .eq("id", runId);

  return summary;
}

/** "14 not a fire · 3 outside every watch area" for the status panel. */
export function skippedLine(skipped: Record<string, number>): string {
  return Object.entries(skipped)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${(SKIP_REASON_LABEL[k as SkipReason] ?? k).toLowerCase()}`)
    .join(" · ");
}
