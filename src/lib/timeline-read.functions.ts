/**
 * The timeline read, server side.
 *
 * One server function does two different jobs, and the difference is the whole
 * cost story:
 *
 *  - `generate: false` — a pure cache read. Loads the account's timeline under
 *    the caller's own RLS, fingerprints it, and returns whatever read is
 *    already stored. No model call, ever. This is what a page view does.
 *  - `generate: true` — the rep pressed the button, or the stored read is
 *    older than the history. Only then is the model asked, and only if the
 *    fingerprint actually changed and the cooldown has passed.
 *
 * The turn runs entirely under the asker's permissions: the timeline comes
 * from `fetchAccountTimeline` with `context.supabase`, which is the caller's
 * authenticated client, so the model sees exactly the feed the Timeline card
 * would have rendered for that person and never a row wider.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireAssistantCapability } from "@/lib/assistant-capability.server";
import {
  MIN_ENTRIES_FOR_READ,
  buildTimelineDigest,
  buildTimelineReadPrompt,
  isStale,
  needsRegeneration,
  observationKey,
  parseTimelineRead,
  TIMELINE_READ_SYSTEM,
  type CachedReadMark,
  type TimelineObservation,
  type TimelineReadStatus,
} from "@/lib/timeline-read";

const MODEL = "google/gemini-3.6-flash";

export type TimelineReadResult = {
  status: TimelineReadStatus;
  items: TimelineObservation[];
  /** The stored read predates the current history. */
  stale: boolean;
  /** ISO timestamp of the newest entry the read covered. */
  readThrough: string | null;
  generatedAt: string | null;
  /** Entries eligible for a read right now — drives the "too thin" copy. */
  entryCount: number;
  /** Why the read is unavailable, in words a rep can act on. */
  message: string | null;
};

const input = z.object({
  account_id: z.string().uuid(),
  /** Only ever true because a person asked. Never set by a render. */
  generate: z.boolean().optional().default(false),
});

type CacheRow = {
  fingerprint: string;
  latest_entry_at: string | null;
  entry_count: number;
  status: string;
  items: unknown;
  generated_at: string;
};

function cachedItems(row: CacheRow | null, dismissed: Set<string>): TimelineObservation[] {
  if (!row || !Array.isArray(row.items)) return [];
  return (row.items as TimelineObservation[]).filter(
    (i) => i && typeof i.key === "string" && !dismissed.has(i.key),
  );
}

export const accountTimelineRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data, context }): Promise<TimelineReadResult> => {
    const sb = context.supabase;
    await requireAssistantCapability(sb, context.userId);

    const { fetchAccountTimeline } = await import("@/lib/account-timeline");
    const { resolveAssistantScope, logAssistantEvent, untrusted } =
      await import("@/lib/assistant-scope.server");
    const scope = await resolveAssistantScope(sb, context.userId);

    // A missing account and an RLS-hidden account get the same answer.
    const { data: account } = await sb
      .from("accounts")
      .select("id,name")
      .eq("id", data.account_id)
      .maybeSingle();
    if (!account) throw new Error("That account is not visible to you.");

    const [timeline, dismissRes, cacheRes] = await Promise.all([
      fetchAccountTimeline(data.account_id, sb),
      sb
        .from("account_focus_dismissals")
        .select("suggestion_key")
        .eq("account_id", data.account_id)
        .eq("user_id", context.userId),
      sb
        .from("account_timeline_reads")
        .select("fingerprint,latest_entry_at,entry_count,status,items,generated_at")
        .eq("account_id", data.account_id)
        .eq("user_id", context.userId)
        .maybeSingle(),
    ]);

    const dismissed = new Set(
      ((dismissRes.data ?? []) as Array<{ suggestion_key: string }>)
        .map((r) => r.suggestion_key)
        .filter((k) => k.startsWith("timeline_read:")),
    );
    const row = (cacheRes.data ?? null) as CacheRow | null;
    const digest = buildTimelineDigest(timeline.entries);
    const mark: CachedReadMark | null = row
      ? {
          fingerprint: row.fingerprint,
          latestEntryAt: row.latest_entry_at,
          entryCount: row.entry_count,
          generatedAt: row.generated_at,
        }
      : null;

    const stale = isStale(mark, digest);
    const cached: TimelineReadResult = {
      status: row ? ((row.status as TimelineReadStatus) ?? "ok") : "none",
      items: cachedItems(row, dismissed),
      stale,
      readThrough: row?.latest_entry_at ?? null,
      generatedAt: row?.generated_at ?? null,
      entryCount: digest.entryCount,
      message: null,
    };

    // The page-view path stops here. No model, no tokens.
    if (!data.generate) return cached;
    if (!needsRegeneration(mark, digest)) return cached;

    if (digest.entryCount < MIN_ENTRIES_FOR_READ) {
      const at = new Date().toISOString();
      const insufficient: TimelineReadResult = {
        status: "insufficient",
        items: [],
        stale: false,
        readThrough: digest.latestEntryAt,
        generatedAt: at,
        entryCount: digest.entryCount,
        message: "There is too little history on this account to read yet.",
      };
      await sb.from("account_timeline_reads").upsert(
        {
          account_id: data.account_id,
          user_id: context.userId,
          fingerprint: digest.fingerprint,
          latest_entry_at: digest.latestEntryAt,
          entry_count: digest.entryCount,
          status: "insufficient",
          items: [],
          model: null,
          generated_at: at,
        },
        { onConflict: "account_id,user_id" },
      );
      return insufficient;
    }

    // Headlines this rep has already waved away are named in the prompt, so a
    // dismissal survives a regeneration rather than coming straight back.
    const dismissedHeadlines = (
      Array.isArray(row?.items) ? (row!.items as TimelineObservation[]) : []
    )
      .filter((i) => i && dismissed.has(i.key))
      .map((i) => i.headline);

    const prompt = buildTimelineReadPrompt(digest, {
      accountName: account.name ?? "this account",
      dismissedHeadlines,
    });

    let parsed;
    try {
      const { complete, safeJson } = await import("@/lib/ai.server");
      const raw = await complete(TIMELINE_READ_SYSTEM, untrusted(prompt), true, "general", {
        feature: "timeline_read",
      });
      const json = safeJson<unknown>(raw);
      if (!json) throw new Error("The assistant's answer could not be read.");
      parsed = parseTimelineRead(json, digest, { dismissedKeys: dismissed });
    } catch (err) {
      await logAssistantEvent(scope, {
        feature: "timeline_read",
        scopeSummary: { account_id: data.account_id },
        retrieved: { entries_supplied: digest.entryCount },
        outcome: "error",
        responsePreview: (err as Error).message,
        model: MODEL,
      });
      // Honest degradation: keep whatever was cached, say the read failed, and
      // let the mechanical checks carry the card.
      return {
        ...cached,
        status: row ? cached.status : "unavailable",
        message:
          "The timeline read is unavailable right now. The checks below are still up to date.",
      };
    }

    const generatedAt = new Date().toISOString();
    const result: TimelineReadResult = {
      status: "ok",
      items: parsed.items,
      stale: false,
      readThrough: digest.latestEntryAt,
      generatedAt,
      entryCount: digest.entryCount,
      message: null,
    };

    // Dismissed items are stored too, so their headlines are still available
    // to suppress on the next generation; they are filtered out on the way
    // back to the UI, here and in `cachedItems`.
    const dismissedCarry = (
      Array.isArray(row?.items) ? (row!.items as TimelineObservation[]) : []
    ).filter((i) => i && dismissed.has(i.key));

    await sb.from("account_timeline_reads").upsert(
      {
        account_id: data.account_id,
        user_id: context.userId,
        fingerprint: digest.fingerprint,
        latest_entry_at: digest.latestEntryAt,
        entry_count: digest.entryCount,
        status: "ok",
        items: JSON.parse(JSON.stringify([...parsed.items, ...dismissedCarry])),
        model: MODEL,
        generated_at: generatedAt,
      },
      { onConflict: "account_id,user_id" },
    );

    await logAssistantEvent(scope, {
      feature: "timeline_read",
      scopeSummary: { account_id: data.account_id },
      retrieved: {
        entries_supplied: digest.entryCount,
        entries_on_record: digest.totalEntries,
        accepted: parsed.items.length,
        rejected: parsed.rejected,
      },
      responsePreview: parsed.items.map((i) => `${i.date} ${i.headline}`).join(" | "),
      model: MODEL,
      outcome: "ok",
    });

    return result;
  });

/** Dismiss one observation. Shares the Focus dismissal table, so Restore clears both. */
export const dismissTimelineObservation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        account_id: z.string().uuid(),
        key: z.string().min(1).max(200).startsWith("timeline_read:"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("account_focus_dismissals").upsert(
      {
        account_id: data.account_id,
        user_id: context.userId,
        suggestion_key: data.key,
      },
      { onConflict: "account_id,user_id,suggestion_key" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export { observationKey };
