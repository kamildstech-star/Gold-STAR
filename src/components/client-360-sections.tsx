/**
 * The Client 360 cards, as components — Satisfaction, Claim Details,
 * Milestones, Open Tasks, and the section frame they all sit in.
 *
 * They were written inline in the /farming route, inside the docked panel,
 * which was the only place a client's satisfaction score or milestone ladder
 * was ever drawn. Then Mark, with the board and a prospect record side by
 * side: "When clicking on an active client, it's supposed to have the same
 * look as the pipeline ... Just the cards that are actually relevant to the
 * active clients?" So the account record now carries these cards too — and a
 * record that redrew them would be a second copy of "what does a milestone
 * look like" that the panel could never be kept in step with. This file is
 * the one copy. The panel and the record both mount it; neither owns it.
 *
 * Each card takes plain data rather than an `ActiveClientRow`, because the
 * record does not have one — it has the account row and the job. Everything
 * a card writes goes through the helpers in `lib/client-360-edit.ts` and the
 * job field convention in `job-inline-field.tsx`, exactly as it did in the
 * panel, so the permission gates and the timeline triggers came with it.
 */
import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Circle, Star } from "lucide-react";
import { toast } from "sonner";

import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { JobField, type JobRecordLike } from "@/components/job-inline-field";
import { nextSatisfaction, saveSatisfaction } from "@/lib/client-360-edit";
import { errText } from "@/lib/db-errors";
import { fmtDate } from "@/lib/table-prefs";
import { cn } from "@/lib/utils";
import { assertWritesEnabled } from "@/lib/write-guard";
import type { ClientDetail } from "@/lib/active-clients";

const CARD = "rounded-xl border border-[var(--border)] bg-card";
const NAVY = "var(--foreground)";
const MUTED = "var(--muted-foreground)";

/* ------------------------------------------------------------------ frame */

/**
 * One card of the panel. The title is a heading rather than a bold div so a
 * rep skimming the record and a screen reader listing its sections both find
 * "Milestones" the way they find "Documents" and "Timeline" beside it.
 */
export function Client360Section({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  // A section that is a record of what happened (milestones, tasks, messages)
  // is simply drawn as text: no "Read-only" lock chip, no note explaining why
  // there is nothing to click.
  return (
    <section aria-label={title} className={cn(CARD, "break-inside-avoid p-3", className)}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-[12.5px] font-bold" style={{ color: NAVY }}>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

export function Client360Empty({ children }: { children: ReactNode }) {
  return (
    <div className="text-[12px]" style={{ color: MUTED }}>
      {children}
    </div>
  );
}

/* ----------------------------------------------------------- satisfaction */

/**
 * Five stars, click to score, click the lit one again to clear. The write is
 * `saveSatisfaction`, validated there; `onSaved` is how the host re-reads the
 * score, because the board reads it off `active-clients` and the record off
 * the account row, and the card should not know which.
 */
export function SatisfactionSection({
  accountId,
  score,
  canEdit,
  onSaved,
  className,
}: {
  accountId: string;
  score: number | null;
  /**
   * The account edit policy (its rep or a manager of its office). False — or
   * still being checked — draws the score as plain stars with nothing to click.
   * The read-only preview (View As) is read here, not passed in, and keeps its
   * disabled stars and reason.
   */
  canEdit: boolean;
  onSaved: () => void;
  className?: string;
}) {
  const app = useAppContext();
  const writes = useWritesDisabled();

  const setScore = useMutation({
    mutationFn: async (next: number | null) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      await saveSatisfaction(accountId, next, app.userId);
    },
    onSuccess: (_v, next) => {
      toast.success(next === null ? "Satisfaction cleared" : "Satisfaction saved");
      onSaved();
    },
  });

  const star = (i: number) => (
    <Star
      className="h-5 w-5"
      style={{ color: "#F5A623" }}
      fill={(score ?? 0) >= i ? "#F5A623" : "none"}
    />
  );

  return (
    <Client360Section title="Satisfaction" className={className}>
      <div className="flex items-center gap-2">
        {canEdit ? (
          [1, 2, 3, 4, 5].map((i) => (
            <button
              key={i}
              type="button"
              aria-label={
                Math.round(score ?? 0) === i ? "Clear satisfaction score" : `Set satisfaction ${i}`
              }
              disabled={writes.disabled || setScore.isPending}
              title={writes.disabled ? (writes.reason ?? undefined) : undefined}
              onClick={() => setScore.mutate(nextSatisfaction(score, i))}
            >
              {star(i)}
            </button>
          ))
        ) : (
          <span
            className="flex items-center gap-2"
            role="img"
            aria-label={score == null ? "Not scored yet" : `Satisfaction ${score.toFixed(1)} of 5`}
          >
            {[1, 2, 3, 4, 5].map((i) => (
              <span key={i}>{star(i)}</span>
            ))}
          </span>
        )}
        <span className="text-[12px]" style={{ color: MUTED }}>
          {setScore.isPending ? "Saving…" : score == null ? "Not scored yet" : score.toFixed(1)}
        </span>
      </div>
      {setScore.isError ? (
        <p role="alert" className="mt-1 text-[11px] text-destructive">
          {errText(setScore.error)}
        </p>
      ) : null}
      {canEdit && !writes.disabled && score != null ? (
        <p className="mt-1 text-[10.5px]" style={{ color: MUTED }}>
          Click the lit star again to clear the score.
        </p>
      ) : null}
      {canEdit && writes.disabled && writes.reason ? (
        <p className="mt-1 text-[10.5px]" style={{ color: MUTED }}>
          {writes.reason}
        </p>
      ) : null}
    </Client360Section>
  );
}

/* ---------------------------------------------------------- claim details */

/** The job columns the card shows, in this order. Deductible is money-gated. */
const CLAIM_FIELDS: [string, string][] = [
  ["insurance_carrier", "Insurance Carrier"],
  ["claim_number", "Claim Number"],
  ["loss_date", "Date of Loss"],
  ["loss_description", "Cause of Loss"],
  ["adjuster_name", "Adjuster"],
  ["deductible", "Deductible"],
  ["completion_date", "Estimated Completion"],
];

/**
 * Job fields, edited through the app's own job field convention — JobField
 * carries the field-permission matrix, the money gate and the
 * `log_job_field_changes` timeline trigger with it.
 */
export function ClaimDetailsSection({
  job,
  money,
  onSaved,
  className,
}: {
  job: ClientDetail["job"];
  /** Commission rule — the deductible is hidden when false. */
  money: boolean;
  onSaved: () => void;
  className?: string;
}) {
  return (
    <Client360Section title="Claim Details" className={className}>
      {job ? (
        <div className="space-y-1.5 text-[12px]">
          {CLAIM_FIELDS.map(([key, label]) =>
            key === "deductible" && !money ? null : (
              <JobField
                key={key}
                job={job as unknown as JobRecordLike}
                fieldKey={key}
                label={label}
                onSaved={onSaved}
              />
            ),
          )}
        </div>
      ) : (
        <Client360Empty>No open job on this client.</Client360Empty>
      )}
    </Client360Section>
  );
}

/* -------------------------------------------------------------- milestones */

/** The ladder every restoration job walks, with the rungs it has reached lit. */
export function MilestonesSection({
  milestones,
  className,
}: {
  milestones: ClientDetail["milestones"] | undefined;
  className?: string;
}) {
  return (
    <Client360Section title="Milestones" className={className}>
      {milestones?.length ? (
        <ul className="space-y-2">
          {milestones.map((m) => (
            <li key={m.label} className="flex items-center gap-2">
              {m.done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: "var(--success)" }} />
              ) : (
                <Circle className="h-4 w-4 shrink-0" style={{ color: "#C6D0DC" }} />
              )}
              <span
                className="flex-1 truncate text-[12.5px]"
                style={{ color: m.done ? NAVY : MUTED }}
              >
                {m.label}
              </span>
              <span className="text-[11px]" style={{ color: MUTED }}>
                {m.date ? fmtDate(m.date) : ""}
              </span>
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                style={
                  m.done
                    ? {
                        background: "color-mix(in oklab, var(--success) 14%, var(--card))",
                        color: "var(--success)",
                      }
                    : { background: "var(--border)", color: MUTED }
                }
              >
                {m.done ? "Completed" : "Upcoming"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Client360Empty>No milestones yet.</Client360Empty>
      )}
    </Client360Section>
  );
}

/* -------------------------------------------------------------- open tasks */

export function OpenTasksSection({
  tasks,
  className,
}: {
  tasks: ClientDetail["tasks"] | undefined;
  className?: string;
}) {
  return (
    <Client360Section title={`Open Tasks (${tasks?.length ?? 0})`} className={className}>
      {tasks?.length ? (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <Circle className="h-3.5 w-3.5 shrink-0" style={{ color: "#C6D0DC" }} />
              <span className="flex-1 truncate text-[12.5px]" style={{ color: NAVY }}>
                {t.title}
              </span>
              <span className="text-[11px]" style={{ color: MUTED }}>
                {t.due ? `Due ${fmtDate(t.due)}` : ""}
              </span>
              {t.priority ? (
                <span
                  className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize"
                  style={
                    t.priority === "high" || t.priority === "urgent"
                      ? {
                          background: "color-mix(in oklab, var(--destructive) 14%, var(--card))",
                          color: "var(--destructive)",
                        }
                      : {
                          background: "color-mix(in oklab, var(--warning) 14%, var(--card))",
                          color: "var(--warning)",
                        }
                  }
                >
                  {t.priority}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Client360Empty>Nothing outstanding.</Client360Empty>
      )}
    </Client360Section>
  );
}
