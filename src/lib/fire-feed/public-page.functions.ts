/**
 * "Test this page" on the Public incident pages panel: fetch the page once,
 * politely (robots.txt still decides), read it with the settings being
 * typed, and show what came out — the tables found and their headers, the
 * columns matched, and the first rows — so an admin can map a county's
 * table without guessing. Writes nothing.
 *
 * Admins only (is_privileged, the same people who may add the source) and
 * rate-limited: every test is a request to somebody else's server.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import type { PageRow } from "./public-page";

export interface PublicPageTestResult {
  ok: boolean;
  error: string | null;
  notes: string[];
  tables: { headers: string[]; rows: number }[];
  totalRows: number;
  fireRows: number;
  sample: PageRow[];
  fireSample: { title: string; publishedAt: string | null; units: number | null }[];
}

const input = z.object({
  url: z.string().trim().min(8).max(2000),
  label: z.string().trim().max(120).optional(),
  config: z.record(z.unknown()),
});

export const testPublicPage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data, context }): Promise<PublicPageTestResult> => {
    const ctx = context as unknown as {
      supabase: {
        rpc: (fn: "is_privileged", args: { _user_id: string }) => Promise<{ data: unknown }>;
      };
      userId: string;
    };
    const { data: allowed } = await ctx.supabase.rpc("is_privileged", { _user_id: ctx.userId });
    if (!allowed) throw new Error("Only an owner or admin can test a public incident page.");

    const empty = (error: string): PublicPageTestResult => ({
      ok: false,
      error,
      notes: [],
      tables: [],
      totalRows: 0,
      fireRows: 0,
      sample: [],
      fireSample: [],
    });

    const { RATE_LIMITS, consumeLimit } = await import("@/lib/rate-limit.server");
    const budget = await consumeLimit(
      "public-page-test",
      ctx.userId,
      RATE_LIMITS.publicPageTest,
      "closed",
    );
    if (!budget.allowed) {
      return empty(
        `Testing is resting — try again in about ${Math.max(1, Math.ceil(budget.retryAfterSeconds / 60))} minute(s).`,
      );
    }

    const { readPublicPage } = await import("./sources/public_page.source");
    const cursors = new Map<string, string>();
    const r = await readPublicPage(
      {
        source: {
          id: "test",
          kind: "public_page",
          label: data.label || "Public page",
          url: data.url,
          config: data.config,
          area_id: null,
          poll_minutes: 3,
          enabled: true,
          last_fetched_at: null,
          etag: null,
          last_modified: null,
        },
        areas: [],
        now: new Date(),
        fetch: (i, init) => fetch(i, init),
        cursors: { get: (k) => cursors.get(k) ?? null, set: (k, v) => void cursors.set(k, v) },
      },
      { respectInterval: false },
    );
    return {
      ok: !r.state.error,
      error: r.state.error ?? null,
      notes: r.notes ?? [],
      tables: r.tables ?? [],
      totalRows: r.rows.length || r.items.length,
      fireRows: r.items.length,
      sample: r.rows.slice(0, 12),
      fireSample: r.items.slice(0, 12).map((i) => ({
        title: i.title,
        publishedAt: i.publishedAt,
        units: i.structured?.units ?? null,
      })),
    };
  });
