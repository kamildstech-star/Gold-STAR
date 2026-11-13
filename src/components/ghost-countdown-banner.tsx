/**
 * The ghost timer, on the account record, with its one snooze beside it.
 *
 * WHY THIS EXISTS. The outreach/ghost rules decide, silently and server-side,
 * that a prospect is going cold and then move it. PR #164 put the first UI on
 * that engine — a strip on the pipeline board card — and deferred the rest
 * with a note: "A snooze there would be a button answering a warning that
 * isn't on screen. Flagged as a follow-up: put the rule verdict on the record
 * first, snooze beside it." Until this shipped, `fetchPipelineRuleStateFor`
 * had no callers at all: you could open an account that had been quiet for
 * twenty-six days, four days from ghosting itself, and see nothing.
 *
 * WHY IT IS NOT AN "ON THE RECORD" SIGNAL. That surface — `account_focus`, on
 * the suggestion card — was the obvious host and is the wrong one, for three
 * reasons that are all about what it is FOR:
 *
 *   1. It is computed in SQL. Adding a line to it means a migration to
 *      `account_focus`, and the verdict is already a view the client can read.
 *      Two server-side derivations of one rule is the drift #164 warned about.
 *   2. It shows the top suggestion and hides the rest behind "+N more". A
 *      countdown that fires on its own must not be rankable behind an expiring
 *      certificate.
 *   3. Every focus row is dismissible per person, and its action is a
 *      destination from `focus-destination.ts` — a tab to open. A snooze is
 *      not a destination; it is a once-per-stage write against a gate, and it
 *      has no vocabulary in that table.
 *
 * So it sits with the stage rail instead, in the banner strip directly above
 * it, next to `StageAutoAdvanceBanner`. Those two are the same statement in
 * two tenses: that one says the engine moved this record and why, this one
 * says the engine is about to and when. A rep reading the rail reads both.
 *
 * ONE SNOOZE, ONE GATE. Whether the button appears, what it is labelled and
 * whether it is disabled all come from `snoozeControl` in
 * `lib/pipeline-snooze.ts` — the same call the board makes, so a spent snooze
 * is a disabled button carrying the database's own refusal in both places
 * rather than two different explanations of one record. The press is
 * `snoozeGhost`, the same RPC wrapper, and it invalidates the same query keys
 * the board's does so the banner and the board never disagree afterwards.
 */
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock } from "lucide-react";
import { toast } from "sonner";

import { useWritesDisabled } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import { ghostVerdict } from "@/lib/ghost-verdict";
import type { GhostUrgency } from "@/lib/ghost-verdict";
import {
  fetchPipelineRuleStateFor,
  loadPipelineRuleSettings,
  snoozeGhost,
} from "@/lib/pipeline-rules";
import { snoozeControl, snoozeDateLabel } from "@/lib/pipeline-snooze";
import { cn } from "@/lib/utils";

/**
 * The strip's colours by urgency, in the shared tones (`styles.css`, Tones).
 * Literal classes, because Tailwind only builds what it can read.
 */
const URGENCY_TONE: Record<
  GhostUrgency,
  { band: string; disc: string; headline: string; chip: string }
> = {
  watch: {
    band: "border-tone-amber/40 border-l-tone-amber bg-tone-amber-soft",
    disc: "bg-tone-amber text-tone-amber-fg",
    headline: "text-tone-amber-text",
    chip: "bg-tone-amber/15 text-tone-amber-text",
  },
  near: {
    band: "border-tone-orange/40 border-l-tone-orange bg-tone-orange-soft",
    disc: "bg-tone-orange text-tone-orange-fg",
    headline: "text-tone-orange-text",
    chip: "bg-tone-orange text-tone-orange-fg",
  },
  due: {
    band: "border-tone-rose/45 border-l-tone-rose bg-tone-rose-soft",
    disc: "bg-tone-rose text-tone-rose-fg",
    headline: "text-tone-rose-text",
    chip: "bg-tone-rose text-tone-rose-fg",
  },
};

export function GhostCountdownBanner({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const qc = useQueryClient();
  const writes = useWritesDisabled();

  /*
   * Keyed under the board's own prefix on purpose. The board reads
   * ["pipeline-rule-state", cardIds] and invalidates ["pipeline-rule-state"],
   * so a snooze taken on either surface refreshes the other by prefix match
   * and neither can be left showing a countdown the other has already paused.
   */
  const stateQ = useQuery({
    queryKey: ["pipeline-rule-state", accountId],
    queryFn: () => fetchPipelineRuleStateFor(accountId),
    staleTime: 60_000,
  });

  /* One number, shared with the board's cache: how many days a snooze buys. */
  const settingsQ = useQuery({
    queryKey: ["pipeline-rule-settings"],
    queryFn: loadPipelineRuleSettings,
    staleTime: 10 * 60_000,
  });

  const snooze = useMutation({
    mutationFn: () => snoozeGhost(accountId),
    onError: (error) => toastDbError(error, { action: `snooze ${accountName}` }),
    onSuccess: (until) =>
      toast.success(`${accountName} — ghosting paused until ${snoozeDateLabel(until)}`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["pipeline-rule-state"] });
      qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
    },
  });

  const row = stateQ.data ?? null;
  const verdict = React.useMemo(() => ghostVerdict(row), [row]);

  // The control is asked for with the same fields the board passes, so the two
  // surfaces can only ever offer or refuse the snooze together.
  const control = row
    ? snoozeControl({
        warning: row.warning,
        stageKey: row.stage_key,
        ghostSnoozedAt: row.ghost_snoozed_at,
        ghostSnoozedUntil: row.ghost_snoozed_until,
        settings: settingsQ.data,
      })
    : null;

  if (!verdict) return null;

  // Mark: "the colors here in the pipeline aren't exciting" — and this strip
  // was the same beige from day 24 to the day it ghosted. The colour now
  // climbs with the clock (`verdict.urgency`): amber while the date is more
  // than a week off, orange inside the last week, rose once it is due. The
  // words carry the same news, so the colour is never the only signal.
  const tone = URGENCY_TONE[verdict.urgency];

  return (
    <section
      aria-label="Ghost timer"
      data-testid="ghost-countdown"
      data-urgency={verdict.urgency}
      className={cn(
        "flex items-start gap-3 rounded-lg border border-l-4 px-3 py-2.5 text-[12.5px]",
        tone.band,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-px flex size-7 shrink-0 items-center justify-center rounded-full",
          tone.disc,
        )}
      >
        <AlarmClock className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cn("font-semibold", tone.headline)}>{verdict.headline}</span>
          <span className="text-foreground">{verdict.outcome}</span>
          {verdict.daysLeft != null && (
            <span
              className={cn(
                "rounded-full px-2 py-px text-[11px] font-semibold tabular-nums",
                tone.chip,
              )}
            >
              {verdict.daysLeft === 1 ? "1 day left" : `${verdict.daysLeft} days left`}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-muted-foreground">
          {verdict.effort}
          {verdict.standard ? ` ${verdict.standard}` : ""}
        </p>
      </div>
      {control && (
        <button
          type="button"
          disabled={writes.disabled || snooze.isPending || control.disabled}
          title={writes.disabled ? (writes.reason ?? "Read only") : control.hint}
          aria-label={`${control.label} — ${control.hint}`}
          onClick={() => snooze.mutate()}
          className={cn(
            "shrink-0 rounded-full border border-current px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.03em] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
            tone.headline,
          )}
        >
          {snooze.isPending ? "…" : control.label}
        </button>
      )}
    </section>
  );
}
