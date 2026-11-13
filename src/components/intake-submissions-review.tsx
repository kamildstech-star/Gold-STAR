/**
 * "New info from <sender> — N fields to review."
 *
 * Mark, 13 Oct: "when you send an email for info, it needs to have a pop up or
 * a bubble or something that shows that info that should be inputted into the
 * correct fields in the job not as a task".
 *
 * What a recipient gives us — through the secure intake form, or by simply
 * replying to the request email (read by info-reply.server.ts) — is a set of
 * proposals, never facts. The job shows a bubble; Review opens a panel that
 * lists each proposed value against what the job holds now, with Apply, Edit
 * (change it, then apply) and Dismiss per field, and Apply all / Dismiss all.
 *
 * Apply writes through the job's ordinary paths — updateJobFieldsQueued for a
 * job column (the Edit all forms' path, so field permissions, the offline
 * queue and the field-change history trigger behave exactly as for a typed
 * edit), saveJobIntakeAnswers for a questionnaire answer (stamped
 * 'recipient'), insertJobContactMethods for a phone or email. Nothing is
 * written until somebody clicks. Only people who can manage the job see it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, Inbox, Mail, Pencil, X } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { useIntakeQuestions, useJobIntakeAnswers } from "@/lib/intake-questions";
import { useJobFieldAccess } from "@/lib/job-field-access";
import { applySuggestionItems } from "@/lib/info-suggestions-apply";
import { useLossTypes } from "@/lib/loss-categories";
import { useCanManageJob } from "@/lib/use-can-manage-job";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  bubbleText,
  buildSuggestionRows,
  senderOf,
  heldBackFieldIds,
  submissionStatusAfter,
  type FieldDecision,
  type SuggestionRow,
  type SuggestionSubmission,
} from "@/lib/info-suggestions";
import { CarrierConfirm } from "@/components/carrier-confirm";
import { LoadError } from "@/components/ui-density";
import type { CarrierAccount } from "@/lib/carrier-match";
import { cn } from "@/lib/utils";

const BASE_COLUMNS =
  "id, submitted_by_name, submitted_by_email, created_at, answers, fields, status";
/** 20261013121500. Read with a fallback until it is applied. */
const SOURCE_COLUMNS = `${BASE_COLUMNS}, source, source_subject, source_excerpt, source_received_at, field_review`;

/** For columns newer than the generated types. */
const untyped = supabase as unknown as SupabaseClient;

const HIDE_PREFIX = "info-suggestions-hidden:";
function readHidden(jobId: string): string | null {
  try {
    return window.sessionStorage.getItem(HIDE_PREFIX + jobId);
  } catch {
    return null;
  }
}
function writeHidden(jobId: string, signature: string | null) {
  try {
    if (signature) window.sessionStorage.setItem(HIDE_PREFIX + jobId, signature);
    else window.sessionStorage.removeItem(HIDE_PREFIX + jobId);
  } catch {
    /* private window: the bubble simply comes back on the next visit */
  }
}

export function IntakeSubmissionsReview({
  jobId,
  job,
  onApplied,
}: {
  jobId: string;
  job: Record<string, unknown> | null;
  /** The job page re-reads the record after a value lands. */
  onApplied?: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const canManage = useCanManageJob(jobId) === true;
  const access = useJobFieldAccess();
  const questionsQ = useIntakeQuestions({ includeInactive: true });
  const answersQ = useJobIntakeAnswers(canManage ? jobId : null);
  /* Loss type travels as the option-list row id. Shown raw it is a uuid. */
  const lossTypes = useLossTypes();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readHidden(jobId),
  );
  /** Decisions made while field_review cannot be stored (migration unapplied). */
  const [local, setLocal] = useState<Record<string, Record<string, FieldDecision>>>({});
  /* A carrier the recipient typed is confirmed against the CRM before Apply. */
  const [carriers, setCarriers] = useState<Record<string, CarrierAccount | null>>({});

  const subsQ = useQuery({
    queryKey: ["intake-submissions", jobId],
    enabled: canManage,
    refetchInterval: 60_000,
    queryFn: async () => {
      const read = (cols: string) =>
        untyped
          .from("intake_submissions")
          .select(cols)
          .eq("job_id", jobId)
          .eq("status", "pending")
          .order("created_at", { ascending: false });
      let res = await read(SOURCE_COLUMNS);
      if (res.error && isMissingSchema(res.error)) res = await read(BASE_COLUMNS);
      if (res.error) throw res.error;
      return (res.data ?? []) as unknown as SuggestionSubmission[];
    },
  });

  const primaryContactId = (job?.["primary_contact_id"] as string | null) ?? null;
  const contactsQ = useQuery({
    queryKey: ["job-contact-values", jobId, primaryContactId],
    enabled: canManage && (subsQ.data?.length ?? 0) > 0,
    queryFn: async () => {
      const [own, person] = await Promise.all([
        supabase.from("job_contact_methods").select("kind, value").eq("job_id", jobId),
        primaryContactId
          ? supabase
              .from("contacts")
              .select("phone, email")
              .eq("id", primaryContactId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      const phone: string[] = [];
      const email: string[] = [];
      for (const m of (own.data ?? []) as { kind: string; value: string }[]) {
        (m.kind === "email" ? email : phone).push(m.value);
      }
      const p = person.data as { phone: string | null; email: string | null } | null;
      if (p?.phone) phone.push(p.phone);
      if (p?.email) email.push(p.email);
      return { phone, email };
    },
  });

  const subs = useMemo(
    () =>
      (subsQ.data ?? []).map((s) => ({
        ...s,
        field_review: { ...(s.field_review ?? {}), ...(local[s.id] ?? {}) },
      })),
    [subsQ.data, local],
  );

  const groups = useMemo(
    () =>
      subs.map((sub) => ({
        sub,
        rows: buildSuggestionRows(sub, {
          job,
          answers: answersQ.data ?? {},
          questions: questionsQ.data ?? [],
          contactValues: contactsQ.data ?? { phone: [], email: [] },
          lossTypeLabel: (id) => lossTypes.label(id),
          canSee: access.canSee,
        }),
      })),
    [subs, job, answersQ.data, questionsQ.data, contactsQ.data, lossTypes, access.canSee],
  );

  const pending = groups.reduce(
    (n, g) => n + g.rows.filter((r) => r.status === "pending").length,
    0,
  );
  const signature = `${groups.map((g) => g.sub.id).join(",")}#${pending}`;

  const canEditRow = (row: SuggestionRow) => {
    if (app.writesDisabled) return false;
    if (row.target.type === "job") {
      const col = row.target.column === "loss_type_id" ? "loss_type" : row.target.column;
      return access.canEdit(col);
    }
    return row.target.type !== "advisory";
  };

  /** Store per-field decisions; close the submission once nothing is pending. */
  const decide = async (
    sub: SuggestionSubmission,
    rows: SuggestionRow[],
    decisions: Record<string, FieldDecision>,
  ) => {
    const review = { ...(sub.field_review ?? {}), ...decisions };
    const after = rows.map((r) =>
      decisions[r.fieldId] ? { ...r, status: decisions[r.fieldId]!.status } : r,
    );
    // Items this viewer is not shown stay pending for someone who is.
    const status = submissionStatusAfter(
      after,
      heldBackFieldIds({ ...sub, field_review: review }, { canSee: access.canSee, job }),
    );
    const closing =
      status === "pending"
        ? {}
        : { reviewed_by: app.userId ?? null, reviewed_at: new Date().toISOString() };
    const { error } = await untyped
      .from("intake_submissions")
      .update({ field_review: review, status, ...closing })
      .eq("id", sub.id);
    if (!error) return;
    if (!isMissingSchema(error)) throw error;
    // No field_review column yet: remember the decisions here, and close the
    // submission the old way once every field is decided.
    setLocal((l) => ({ ...l, [sub.id]: { ...(l[sub.id] ?? {}), ...decisions } }));
    if (status !== "pending") {
      const { error: statusError } = await supabase
        .from("intake_submissions")
        .update({ status, ...closing })
        .eq("id", sub.id);
      if (statusError) throw statusError;
    }
  };

  const refresh = (touched: { job?: boolean; answers?: boolean; contacts?: boolean }) => {
    void qc.invalidateQueries({ queryKey: ["intake-submissions", jobId] });
    if (touched.answers) void qc.invalidateQueries({ queryKey: ["job-intake-answers", jobId] });
    if (touched.contacts) void qc.invalidateQueries({ queryKey: ["job-contact-values", jobId] });
    if (touched.job || touched.contacts) onApplied?.();
  };

  const applyRows = useMutation({
    mutationFn: async (input: {
      sub: SuggestionSubmission;
      rows: SuggestionRow[];
      items: { row: SuggestionRow; value: string }[];
      dismiss?: SuggestionRow[];
    }) => {
      const touched = await applySuggestionItems({
        jobId,
        items: input.items,
        userId: app.userId ?? null,
        carrierAccountId: carriers[input.sub.id]?.id ?? null,
        jobHasCarrierAccount: Boolean(job?.["insurance_carrier_account_id"]),
      });
      const decisions: Record<string, FieldDecision> = {};
      for (const { row, value } of input.items) {
        decisions[row.fieldId] = { status: "applied", value };
      }
      for (const row of input.dismiss ?? []) decisions[row.fieldId] = { status: "dismissed" };
      await decide(input.sub, input.rows, decisions);
      return { touched, count: input.items.length };
    },
    onSuccess: ({ touched, count }) => {
      if (count)
        toast.success(count === 1 ? "Applied to the job" : `${count} fields applied to the job`);
      refresh(touched);
    },
    onError: (e) => toastDbError(e, { action: "Apply recipient details" }),
  });

  const dismissRows = useMutation({
    mutationFn: async (input: {
      sub: SuggestionSubmission;
      rows: SuggestionRow[];
      dismiss: SuggestionRow[];
    }) => {
      const decisions: Record<string, FieldDecision> = {};
      for (const row of input.dismiss) decisions[row.fieldId] = { status: "dismissed" };
      await decide(input.sub, input.rows, decisions);
    },
    onSuccess: () => refresh({}),
    onError: (e) => toastDbError(e, { action: "Dismiss recipient details" }),
  });

  if (!canManage) return null;

  /* A failed read used to render as no card at all, which is indistinguishable
     from "the recipient sent nothing". */
  if (subsQ.isError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="p-3">
          <LoadError
            what="details provided by the recipient"
            error={subsQ.error}
            onRetry={() => void subsQ.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  if (!groups.length) return null;

  const busy = applyRows.isPending || dismissRows.isPending;
  const text = pending ? bubbleText(subs, pending) : "Recipient details — nothing new to apply";

  return (
    <>
      <InfoSuggestionsBubble
        text={text}
        emailed={subs.some((s) => s.source === "email_reply")}
        collapsed={hidden === signature}
        pending={pending}
        onReview={() => setOpen(true)}
        onHide={() => {
          writeHidden(jobId, signature);
          setHidden(signature);
        }}
        onShow={() => {
          writeHidden(jobId, null);
          setHidden(null);
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Inbox className="size-4 text-primary" /> Suggested updates
            </DialogTitle>
            <DialogDescription>
              Values the customer sent us. Nothing changes on the job until you apply it.
            </DialogDescription>
          </DialogHeader>
          <InfoSuggestionsPanelBody
            groups={groups}
            busy={busy}
            canEdit={canEditRow}
            onApply={(sub, rows, row, value) =>
              applyRows.mutate({ sub, rows, items: [{ row, value }] })
            }
            onDismiss={(sub, rows, row) => dismissRows.mutate({ sub, rows, dismiss: [row] })}
            onApplyAll={(sub, rows) => {
              const waiting = rows.filter((r) => r.status === "pending");
              const items = waiting
                .filter((r) => r.target.type !== "advisory" && canEditRow(r))
                .map((row) => ({ row, value: row.proposed }));
              // Reference-only rows have nothing to apply; Apply all closes them.
              const dismiss = waiting.filter((r) => r.target.type === "advisory");
              applyRows.mutate({ sub, rows, items, dismiss });
            }}
            onDismissAll={(sub, rows) =>
              dismissRows.mutate({ sub, rows, dismiss: rows.filter((r) => r.status === "pending") })
            }
            renderExtra={(sub) =>
              sub.fields?.["insurance_carrier"] && !job?.["insurance_carrier_account_id"] ? (
                <CarrierConfirm
                  className="mb-2"
                  name={sub.fields["insurance_carrier"]}
                  value={carriers[sub.id] ?? null}
                  onChange={(a) => setCarriers((c) => ({ ...c, [sub.id]: a }))}
                />
              ) : null
            }
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The bubble                                                          */
/* ------------------------------------------------------------------ */

export function InfoSuggestionsBubble({
  text,
  emailed,
  collapsed,
  pending,
  onReview,
  onHide,
  onShow,
}: {
  text: string;
  emailed: boolean;
  collapsed: boolean;
  pending: number;
  onReview: () => void;
  onHide: () => void;
  onShow: () => void;
}) {
  if (collapsed) {
    // Hidden, never lost: a small chip stays until every field is decided.
    return (
      <button
        type="button"
        data-info-suggestions="chip"
        onClick={onShow}
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3 py-1 text-xs text-primary hover:bg-primary/10"
      >
        <Inbox className="size-3.5" />
        {pending} suggested update{pending === 1 ? "" : "s"}
      </button>
    );
  }
  return (
    <div
      role="status"
      data-info-suggestions="bubble"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/50 bg-primary/5 px-3 py-2 shadow-sm"
    >
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        {emailed ? <Mail className="size-4" /> : <Inbox className="size-4" />}
        {pending > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-primary" />
        ) : null}
      </span>
      <p className="min-w-0 flex-1 text-sm font-medium">{text}</p>
      <div className="flex items-center gap-1">
        <Button size="sm" onClick={onReview}>
          Review
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onHide}
          aria-label="Hide for now"
          title="Hide for now"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The review panel                                                    */
/* ------------------------------------------------------------------ */

type Group = { sub: SuggestionSubmission; rows: SuggestionRow[] };

export function InfoSuggestionsPanelBody({
  groups,
  busy,
  canEdit,
  onApply,
  onDismiss,
  onApplyAll,
  onDismissAll,
  renderExtra,
}: {
  groups: Group[];
  busy: boolean;
  canEdit: (row: SuggestionRow) => boolean;
  onApply: (
    sub: SuggestionSubmission,
    rows: SuggestionRow[],
    row: SuggestionRow,
    value: string,
  ) => void;
  onDismiss: (sub: SuggestionSubmission, rows: SuggestionRow[], row: SuggestionRow) => void;
  onApplyAll: (sub: SuggestionSubmission, rows: SuggestionRow[]) => void;
  onDismissAll: (sub: SuggestionSubmission, rows: SuggestionRow[]) => void;
  renderExtra?: (sub: SuggestionSubmission) => React.ReactNode;
}) {
  const [editing, setEditing] = useState<Record<string, string>>({});

  return (
    <div className="space-y-4">
      {groups.map(({ sub, rows }) => {
        const open = rows.filter((r) => r.status === "pending");
        const done = rows.length - open.length;
        const applicable = open.filter((r) => r.target.type !== "advisory" && canEdit(r));
        const overwrites = applicable.filter((r) => r.overwrites).length;
        const emailed = sub.source === "email_reply";
        const when = sub.source_received_at ?? sub.created_at;
        return (
          <section key={sub.id} data-submission={sub.id} className="rounded-md border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {emailed ? <Mail className="size-3.5" /> : <Inbox className="size-3.5" />}
              <span>
                From <span className="font-medium text-foreground">{senderOf(sub)}</span>
                {sub.submitted_by_name && sub.submitted_by_email
                  ? ` <${sub.submitted_by_email}>`
                  : ""}{" "}
                · {emailed ? "email reply" : "intake form"} ·{" "}
                {new Date(when).toLocaleString("en-US")}
              </span>
              {done ? (
                <Badge variant="secondary" className="text-[10px]">
                  {done} handled
                </Badge>
              ) : null}
            </div>

            {emailed && (sub.source_excerpt || sub.source_subject) ? (
              <SourceSnippet
                subject={sub.source_subject ?? null}
                excerpt={sub.source_excerpt ?? null}
              />
            ) : null}

            {renderExtra?.(sub)}

            {open.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing new — everything matches the job.
              </p>
            ) : (
              <ul className="divide-y">
                {open.map((row) => {
                  const draft = editing[row.id];
                  const editable = canEdit(row);
                  return (
                    <li key={row.id} data-row={row.fieldId} className="space-y-1.5 py-2 text-sm">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{row.label}</div>
                          <div className="text-xs text-muted-foreground">
                            <span className={cn(row.overwrites && "line-through opacity-70")}>
                              {row.currentText}
                            </span>{" "}
                            <span className="text-foreground">→ {row.proposedText}</span>
                            {row.overwrites ? (
                              <span className="ml-1 text-warning">
                                (replaces the current value)
                              </span>
                            ) : null}
                            {row.target.type === "advisory" ? (
                              <span className="ml-1">(for reference)</span>
                            ) : null}
                          </div>
                        </div>
                        {draft === undefined ? (
                          <div className="flex gap-1">
                            {row.target.type !== "advisory" ? (
                              <>
                                <Button
                                  size="sm"
                                  className="h-7"
                                  disabled={busy || !editable}
                                  title={editable ? undefined : "You cannot edit this field"}
                                  onClick={() => onApply(sub, rows, row, row.proposed)}
                                >
                                  <Check className="mr-1 size-3.5" /> Apply
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7"
                                  disabled={busy || !editable}
                                  onClick={() =>
                                    setEditing((e) => ({ ...e, [row.id]: row.proposed }))
                                  }
                                >
                                  <Pencil className="mr-1 size-3.5" /> Edit
                                </Button>
                              </>
                            ) : null}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7"
                              disabled={busy}
                              onClick={() => onDismiss(sub, rows, row)}
                            >
                              <X className="mr-1 size-3.5" /> Dismiss
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      {draft !== undefined ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <RowEditor
                            row={row}
                            value={draft}
                            onChange={(v) => setEditing((e) => ({ ...e, [row.id]: v }))}
                          />
                          <Button
                            size="sm"
                            className="h-8"
                            disabled={busy || !draft.trim()}
                            onClick={() => {
                              onApply(sub, rows, row, draft);
                              setEditing((e) => {
                                const next = { ...e };
                                delete next[row.id];
                                return next;
                              });
                            }}
                          >
                            <Check className="mr-1 size-3.5" /> Apply
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8"
                            onClick={() =>
                              setEditing((e) => {
                                const next = { ...e };
                                delete next[row.id];
                                return next;
                              })
                            }
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}

            {open.length ? (
              <div className="mt-2 flex flex-wrap justify-end gap-2 border-t pt-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onDismissAll(sub, rows)}
                >
                  Dismiss all
                </Button>
                <Button
                  size="sm"
                  disabled={busy || applicable.length === 0}
                  onClick={() => onApplyAll(sub, rows)}
                >
                  <Check className="mr-1 size-3.5" /> Apply all ({applicable.length})
                  {overwrites ? ` · replaces ${overwrites}` : ""}
                </Button>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function SourceSnippet({ subject, excerpt }: { subject: string | null; excerpt: string | null }) {
  const [full, setFull] = useState(false);
  return (
    <div className="mb-2 rounded-md bg-muted/50 p-2 text-xs" data-source-snippet>
      {subject ? <div className="mb-1 font-medium">Subject: {subject}</div> : null}
      {excerpt ? (
        <>
          <blockquote
            className={cn(
              "whitespace-pre-wrap border-l-2 border-primary/40 pl-2 text-muted-foreground",
              !full && "max-h-24 overflow-hidden",
            )}
          >
            {excerpt}
          </blockquote>
          {excerpt.length > 240 ? (
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1 text-primary hover:underline"
              onClick={() => setFull((f) => !f)}
            >
              <ChevronDown className={cn("size-3 transition-transform", full && "rotate-180")} />
              {full ? "Show less" : "Show the whole reply"}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Edit-before-apply: the right input for the target's kind. */
function RowEditor({
  row,
  value,
  onChange,
}: {
  row: SuggestionRow;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = row.target;
  const kind =
    t.type === "job"
      ? t.def.kind
      : t.type === "answer"
        ? t.answerType === "yes_no"
          ? "bool"
          : t.answerType === "date"
            ? "date"
            : t.answerType === "choice"
              ? "choice"
              : "text"
        : "text";
  if (kind === "bool") {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-32">
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (kind === "choice" && t.type === "answer" && t.choices.length) {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-56">
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          {t.choices.map((c) => (
            <SelectItem key={c} value={c}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  const type =
    kind === "date"
      ? "date"
      : kind === "time"
        ? "time"
        : kind === "money" || kind === "number"
          ? "number"
          : "text";
  return (
    <Input
      className="h-8 w-64 max-w-full"
      type={type}
      value={value}
      autoFocus
      onChange={(e) => onChange(e.target.value)}
      aria-label={`Edit ${row.label}`}
    />
  );
}
