// Client-review approval state for each sidebar page.
//
// During a review phase an admin walks the app with the client and marks every
// page unreviewed -> in review -> approved. The state lives in public.page_reviews,
// one row per sidebar nav entry, and is read by everyone but written only by
// admin / owner / dev (RLS enforces that, not this file).
//
// Two deliberate design points:
//   * A missing row means "unreviewed" — nothing has to be seeded.
//   * If the table itself is missing (migration not applied yet) the hook
//     reports `available: false` and the sidebar simply renders as it always
//     did. A pending migration must never take the app down.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { errText } from "@/lib/db-errors";

export type PageReviewStatus = "unreviewed" | "in_review" | "approved";

export const PAGE_REVIEW_STATUSES: PageReviewStatus[] = ["unreviewed", "in_review", "approved"];

export const PAGE_REVIEW_LABEL: Record<PageReviewStatus, string> = {
  unreviewed: "Not reviewed",
  in_review: "In review",
  approved: "Approved",
};

/** unreviewed -> in_review -> approved -> unreviewed. */
export function nextPageReviewStatus(current: PageReviewStatus): PageReviewStatus {
  const i = PAGE_REVIEW_STATUSES.indexOf(current);
  return PAGE_REVIEW_STATUSES[(i + 1) % PAGE_REVIEW_STATUSES.length];
}

/**
 * The key a nav entry is stored under. The route path is the only stable
 * identity a sidebar item has (labels get reworded, order is per-person), so
 * the key is the path minus its leading slash: "/pipeline" -> "pipeline",
 * "/chase/search" -> "chase/search", "/" -> "dashboard".
 */
export function pageKeyForPath(to: string): string {
  if (!to || to === "/") return "dashboard";
  return to.replace(/^\/+/, "").replace(/\/+$/, "") || "dashboard";
}

/* ---------------------------------------------------------------- colours --
 * Every palette in this app ships a dark sidebar in both light and dark mode,
 * so the status colours are the theme's own warning / success tokens lifted
 * toward white far enough to stay legible on that ground. Unreviewed keeps the
 * default sidebar foreground — review mode off must look like no feature.
 */
export const PAGE_REVIEW_TEXT_CLASS: Record<PageReviewStatus, string> = {
  unreviewed: "",
  in_review: "text-[color-mix(in_oklab,var(--warning)_62%,white)]",
  approved: "text-[color-mix(in_oklab,var(--success)_52%,white)]",
};

export const PAGE_REVIEW_DOT_CLASS: Record<PageReviewStatus, string> = {
  unreviewed: "bg-transparent border-sidebar-foreground/50",
  in_review:
    "bg-[color-mix(in_oklab,var(--warning)_62%,white)] border-[color-mix(in_oklab,var(--warning)_62%,white)]",
  approved:
    "bg-[color-mix(in_oklab,var(--success)_52%,white)] border-[color-mix(in_oklab,var(--success)_52%,white)]",
};

/* ------------------------------------------------------------ review mode --*/

const reviewModeKey = (userId: string | null | undefined) =>
  `rh.sidebar.review-mode.${userId ?? "anon"}`;

/**
 * Whether this person is walking the app in review mode. Off by default and
 * remembered per person on this device, the same way the sidebar's collapsed
 * groups are.
 */
export function useReviewMode(userId: string | null | undefined, allowed: boolean) {
  const key = reviewModeKey(userId);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!allowed) {
      setOn(false);
      return;
    }
    try {
      setOn(localStorage.getItem(key) === "1");
    } catch {
      setOn(false);
    }
  }, [key, allowed]);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* private mode — session-only */
      }
      return next;
    });
  }, [key]);

  return { reviewMode: allowed && on, toggleReviewMode: toggle };
}

/* ------------------------------------------------------------------ data --*/

type PageReviewRow = {
  page_key: string;
  status: PageReviewStatus;
  note: string | null;
  updated_at: string | null;
};

export type PageReviewMap = Record<string, PageReviewStatus>;

export type PageReviewData = {
  statuses: PageReviewMap;
  /** False when the table isn't there yet — the UI then shows no colours. */
  available: boolean;
};

const EMPTY_REVIEWS: PageReviewData = { statuses: {}, available: false };

type QueryError = { message?: string; code?: string; details?: string; hint?: string } | null;

/**
 * public.page_reviews is applied by a separate migration, so it is not in the
 * generated Database types yet. Reach the table through a narrow hand-written
 * shim rather than widening the whole client.
 */
type ReviewTable = {
  select: (columns: string) => PromiseLike<{ data: PageReviewRow[] | null; error: QueryError }>;
  upsert: (
    values: Record<string, unknown>,
    options?: { onConflict?: string },
  ) => PromiseLike<{ data: unknown; error: QueryError }>;
};

function reviewTable(): ReviewTable {
  return (supabase as unknown as { from: (table: string) => ReviewTable }).from("page_reviews");
}

/** True when the failure is "this table does not exist yet". */
function isMissingTable(err: QueryError): boolean {
  if (!err) return false;
  const raw = `${err.message ?? ""} ${err.details ?? ""} ${err.hint ?? ""}`;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    /could not find the table|does not exist|schema cache/i.test(raw)
  );
}

export const PAGE_REVIEWS_QUERY_KEY = ["page-reviews"] as const;

async function fetchPageReviews(): Promise<PageReviewData> {
  const { data, error } = await reviewTable().select("page_key,status,note,updated_at");
  if (error) {
    // Never throw: the sidebar has to render whatever the database says.
    console.warn(
      isMissingTable(error)
        ? "[page-reviews] table public.page_reviews is not there yet — review colors are off."
        : "[page-reviews] could not load review statuses:",
      error,
    );
    return EMPTY_REVIEWS;
  }
  const statuses: PageReviewMap = {};
  for (const row of data ?? []) {
    if (row?.page_key) statuses[row.page_key] = row.status ?? "unreviewed";
  }
  return { statuses, available: true };
}

/** Review statuses for every page. Only fetched while review mode is on. */
export function usePageReviews(enabled: boolean): PageReviewData {
  const q = useQuery({
    queryKey: PAGE_REVIEWS_QUERY_KEY,
    queryFn: fetchPageReviews,
    enabled,
    staleTime: 30_000,
  });
  return q.data ?? EMPTY_REVIEWS;
}

/**
 * Write one page's status. Optimistic, with the previous value put back if the
 * database rejects the write — and the real error surfaced, never swallowed.
 */
export function useSetPageReview(updatedBy: string | null) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (vars: { pageKey: string; status: PageReviewStatus }) => {
      const { error } = await reviewTable().upsert(
        {
          page_key: vars.pageKey,
          status: vars.status,
          updated_by: updatedBy,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "page_key" },
      );
      if (error) throw new Error(errText(error));
      return vars;
    },
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: PAGE_REVIEWS_QUERY_KEY });
      const previous = qc.getQueryData<PageReviewData>(PAGE_REVIEWS_QUERY_KEY);
      qc.setQueryData<PageReviewData>(PAGE_REVIEWS_QUERY_KEY, (old) => {
        const base = old ?? { statuses: {}, available: true };
        return { ...base, statuses: { ...base.statuses, [vars.pageKey]: vars.status } };
      });
      return { previous };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(PAGE_REVIEWS_QUERY_KEY, ctx.previous);
      else qc.invalidateQueries({ queryKey: PAGE_REVIEWS_QUERY_KEY });
      console.error(`[page-reviews] upsert failed for ${vars.pageKey}:`, err);
      toast.error(`Could not save review status: ${errText(err)}`);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: PAGE_REVIEWS_QUERY_KEY });
    },
  });
}

/** Counts for the sidebar legend, over the pages currently on screen. */
export function usePageReviewSummary(pageKeys: string[], statuses: PageReviewMap) {
  return useMemo(() => {
    const counts: Record<PageReviewStatus, number> = {
      unreviewed: 0,
      in_review: 0,
      approved: 0,
    };
    for (const key of pageKeys) counts[statuses[key] ?? "unreviewed"] += 1;
    return counts;
  }, [pageKeys, statuses]);
}
