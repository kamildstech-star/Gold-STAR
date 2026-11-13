/**
 * The card at the top of the prospect dock — two different things, honestly
 * labelled.
 *
 * The top half is the READ: what a model noticed while reading this account's
 * history, each line carrying the date and words it came from. That is the
 * part worth calling AI, and it is the part that costs tokens, so it is
 * cached per account and only regenerated when the history has moved.
 *
 * It is headed "what the AI read", not "from the timeline". The old label
 * rendered as a bold uppercase FROM THE TIMELINE at the top of the dock and
 * was taken for the heading of the card actually called Timeline, which sits
 * below the dock — Mark's QC failure. The only heading on this page that may
 * say "Timeline" is that card's.
 *
 * The bottom half is the CHECKS: `account_focus` (SECURITY INVOKER, so RLS
 * decides what the viewer may be told) plus the compliance rows. Overdue
 * tasks, cadence due, a missing certificate. Genuinely useful, and computed
 * in SQL from rows the rep can already see — which is exactly why it is
 * labelled "on the record" and not "AI suggestion". Counting rows and calling
 * it intelligence was the complaint.
 *
 * Neither half is polled. The checks refresh when the record changes (every
 * write on this layout invalidates them) and otherwise at most once per
 * interval; the read only refreshes when a person asks for it.
 */
import { T } from "@/components/bilingual";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ClipboardCheck, Info, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { useWritesDisabled } from "@/components/app-context";
import { TimelineReadPanel } from "@/components/timeline-read-panel";
import { Button } from "@/components/ui/button";
import {
  FOCUS_ACTION_LABEL,
  dismissFocus,
  fetchAccountFocus,
  restoreFocus,
  type FocusSeverity,
  type FocusSuggestion,
} from "@/lib/account-focus";
import { focusAccent, type FocusAccent } from "@/lib/focus-accent";
import { cn } from "@/lib/utils";
import { assertWritesEnabled } from "@/lib/write-guard";

/** How long a fetched list is trusted before a remount or focus re-reads it. */
const REFRESH_INTERVAL_MS = 5 * 60_000;

const RANK: Record<FocusSeverity, number> = { danger: 0, warn: 1, info: 2 };

/**
 * The top check's row, by `focusAccent`: an overdue touch is rose — a date
 * that has gone by — not the beige of everything else on the page; an
 * upcoming one is amber; the rest stay quiet. The icon and the title carry the
 * same news, so colour is never the only signal.
 */
const TONE: Record<FocusAccent, { icon: typeof Info; disc: string; row: string }> = {
  late: {
    icon: AlertTriangle,
    disc: "bg-tone-rose text-tone-rose-fg",
    row: "border-tone-rose/30 bg-tone-rose-soft",
  },
  warn: {
    icon: TriangleAlert,
    disc: "bg-tone-amber text-tone-amber-fg",
    row: "border-tone-amber/35 bg-tone-amber-soft",
  },
  info: { icon: Info, disc: "bg-muted text-muted-foreground", row: "border-border bg-muted/40" },
};

/** Highest severity first, then whatever order the RPC returned. */
function topSuggestion(items: FocusSuggestion[]): FocusSuggestion | null {
  if (!items.length) return null;
  return [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity])[0] ?? null;
}

export function ProspectSuggestionCard({
  accountId,
  onAction,
  canAction,
  className,
}: {
  accountId: string;
  onAction: (s: FocusSuggestion) => void;
  canAction?: (s: FocusSuggestion) => boolean;
  className?: string;
}) {
  const qc = useQueryClient();
  const writes = useWritesDisabled();

  const focusQ = useQuery({
    queryKey: ["account-focus", accountId],
    queryFn: () => fetchAccountFocus(accountId),
    staleTime: REFRESH_INTERVAL_MS,
  });

  const dismiss = useMutation({
    mutationFn: (key: string) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      return dismissFocus(accountId, key);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-focus", accountId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const restore = useMutation({
    mutationFn: () => {
      assertWritesEnabled(writes.disabled, writes.reason);
      return restoreFocus(accountId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["account-focus", accountId] });
      qc.invalidateQueries({ queryKey: ["account-timeline-read", accountId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const items = Array.isArray(focusQ.data) ? focusQ.data : [];
  const top = topSuggestion(items);
  const tone = TONE[top ? focusAccent(top) : "info"];
  const Icon = tone.icon;

  return (
    <section aria-label="Account intel" className={cn("rounded-xl border bg-card", className)}>
      {/*
        The next step leads, as a card heading of its own, because it is the
        one thing on the page that asks the rep to do something. It is still
        labelled "on the record" — computed from rows, not written by a model.
      */}
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-3 sm:px-5">
        <ClipboardCheck className="size-4 shrink-0 text-link" />
        <h2 className="font-display text-[17px] font-bold leading-none tracking-tight">
          <T>Next step</T>
        </h2>
        <span className="text-[12px] text-muted-foreground">
          On the record
          {items.length > 1 && ` · +${items.length - 1} more`}
        </span>
        {top ? (
          <button
            type="button"
            className="ml-auto min-h-8 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-50"
            disabled={writes.disabled || dismiss.isPending}
            title={writes.disabled ? (writes.reason ?? "Read only") : undefined}
            onClick={() => dismiss.mutate(top.key)}
          >
            Dismiss
          </button>
        ) : (
          !focusQ.isLoading &&
          !focusQ.isError && (
            <button
              type="button"
              className="ml-auto min-h-8 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-hover hover:text-foreground"
              disabled={writes.disabled || restore.isPending}
              title={writes.disabled ? (writes.reason ?? "Read only") : undefined}
              onClick={() => restore.mutate()}
            >
              Restore dismissed
            </button>
          )
        )}
      </header>

      <div className="space-y-4 p-4 sm:p-5">
        <div
          className={cn(
            "flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4",
            top && !focusQ.isLoading && !focusQ.isError && "rounded-xl border px-4 py-4",
            top && !focusQ.isLoading && !focusQ.isError && tone.row,
          )}
          data-focus-accent={top ? focusAccent(top) : undefined}
        >
          {focusQ.isLoading ? (
            <p className="text-[13px] text-muted-foreground">Checking the record…</p>
          ) : focusQ.isError ? (
            <button
              type="button"
              className="text-[13px] text-destructive underline"
              onClick={() => void focusQ.refetch()}
            >
              Could not load the record checks. Retry
            </button>
          ) : !top ? (
            <p className="text-[13px] text-muted-foreground">
              Nothing needs attention on this account.
            </p>
          ) : (
            <>
              <span
                className={cn(
                  "flex size-11 shrink-0 items-center justify-center rounded-full",
                  tone.disc,
                )}
              >
                <Icon className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[16px] font-bold leading-snug">{top.title}</div>
                {top.detail && (
                  <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
                    {top.detail}
                  </p>
                )}
              </div>
              {top.action !== "none" && (canAction?.(top) ?? true) && (
                <Button
                  variant="cta"
                  className="h-11 shrink-0 gap-1.5 rounded-lg px-5 text-[13.5px] font-semibold"
                  disabled={writes.disabled}
                  title={writes.disabled ? (writes.reason ?? "Read only") : undefined}
                  onClick={() => onAction(top)}
                >
                  <Icon className="size-4" />
                  {FOCUS_ACTION_LABEL[top.action] ?? "Open"}
                </Button>
              )}
            </>
          )}
        </div>

        {/*
        The read is the AI half of the card, so it is drawn in the AI tone
        (indigo, used for nothing else) and the check above it is not: a rep
        can tell at a glance which lines a model wrote.
      */}
        <TimelineReadPanel
          accountId={accountId}
          className="rounded-xl border border-ai/20 bg-ai-soft px-4 py-3"
        />
      </div>
    </section>
  );
}
